"""`key create|list|rotate|revoke` on in-memory stores (S1-ADMIN): what may be issued, the ceilings of
decision Z14, rotation with a grace period, revocation with its hooks, and that a secret leaves the
server only in the reply of create and rotate. No database; the Postgres variants are in
`test_admin_pg.py`."""

from __future__ import annotations

import asyncio
import json
from datetime import timedelta

import pytest

from admin_helpers import ACTOR, KeyEnv, key_env, refused
from auth_helpers import NOW
from coordination.admin.protocol import AdminError
from coordination.audit import AuditEvent
from coordination.auth import SCOPES, Verdict, parse_key, verify_key


def verdict(env: KeyEnv, token: str) -> Verdict:
    parsed = parse_key(token)
    assert parsed is not None
    record = asyncio.run(env.store.get(parsed.key_id))
    return verify_key(token, record, env=env.config.env, pepper=env.config.key_pepper, now=env.clock.now())


# -- create ---------------------------------------------------------------------------------


def test_create_a_local_harness_key_returns_a_working_secret_once():
    env = key_env()
    result = env.create(scope="local-harness", agent="claude-code@box", expires="30d")
    assert result["scope"] == "local-harness" and result["owner"] == "claude-code@box"
    assert result["status"] == "active"
    assert verdict(env, result["token"]) is Verdict.OK
    # Only the hash is stored.
    record = asyncio.run(env.store.get(result["key_id"]))
    secret = parse_key(result["token"]).secret
    assert secret not in record.secret_hash and record.secret_hash.startswith("sha256:")
    # The audit row names the actor and the key, not the secret.
    rows = env.audit_store.of(AuditEvent.KEY_CREATED)
    assert len(rows) == 1 and rows[0].actor == ACTOR and rows[0].subject == result["key_id"]
    assert secret not in json.dumps([r.detail_json() for r in env.audit_store.rows])


def test_create_uses_the_pepper_when_one_is_configured():
    env = key_env(key_pepper="x" * 32)
    result = env.create(scope="local-harness", agent="claude-code@box", expires="1d")
    assert asyncio.run(env.store.get(result["key_id"])).secret_hash.startswith("hmac-sha256:")
    assert verdict(env, result["token"]) is Verdict.OK


def test_expiry_is_required_and_has_a_ceiling_per_stage():
    s1 = key_env()
    assert refused(s1, scope="local-harness", agent="claude-code@box").code == "invalid_args"
    assert s1.create(scope="local-harness", agent="claude-code@box", expires="365d")["expires_at"].startswith("2027-11-15")
    assert "365 day ceiling" in refused(s1, scope="local-harness", agent="claude-code@box", expires="366d").message
    for stage in ("s2", "s3"):
        env = key_env(exposure_stage=stage)
        assert env.create(scope="remote-peer", agent="peer-a", cards=["claude-code@box"], expires="90d")["status"] == "active"
        err = refused(env, scope="remote-peer", agent="peer-a", cards=["claude-code@box"], expires="91d")
        assert "90 day ceiling" in err.message
        # The 365 day maximum of s1 is refused at s2 and s3, not clamped.
        assert refused(env, scope="status-client", agent="cognitive-engine", expires="365d").code == "invalid_args"


@pytest.mark.parametrize("bad", ["", "90", "90 d", "-1d", "1w", "0d", "0h", "abc", 90, None, "1.5d"])
def test_a_malformed_expiry_is_refused(bad):
    assert refused(key_env(), scope="local-harness", agent="claude-code@box", expires=bad).code == "invalid_args"


def test_expiry_cannot_be_under_an_hour_and_one_hour_is_enough():
    env = key_env()
    assert "at least 1h" not in refused(env, scope="nope", agent="claude-code@box", expires="1h").message
    assert env.create(scope="local-harness", agent="claude-code@box", expires="1h")["status"] == "active"


def test_tailnet_node_is_required_at_s2_and_s3_for_harness_keys_only():
    s1 = key_env()
    assert s1.create(scope="local-harness", agent="claude-code@box", expires="30d")["tailnet_node"] is None
    for stage in ("s2", "s3"):
        env = key_env(exposure_stage=stage)
        assert "tailnet-node is required" in refused(env, scope="local-harness", agent="claude-code@box", expires="30d").message
        made = env.create(scope="local-harness", agent="claude-code@box", tailnet_node="mac", expires="30d")
        assert made["tailnet_node"] == "mac"
    # Not for the other scopes.
    assert "local-harness keys only" in refused(
        s1, scope="status-client", agent="cognitive-engine", tailnet_node="mac", expires="30d"
    ).message


def test_there_is_no_tailnet_login_option():
    err = refused(key_env(), scope="local-harness", agent="claude-code@box", tailnet_login="a@b", expires="30d")
    assert "tailnet-login" in err.message


def test_scope_must_be_one_of_the_three_and_there_is_no_admin_scope():
    assert set(SCOPES) == {"local-harness", "remote-peer", "status-client"}
    for bad in ("admin", "", "root", None):
        assert refused(key_env(), scope=bad, agent="claude-code@box", expires="1d").code == "invalid_args"


def test_a_local_harness_key_needs_an_existing_card():
    env = key_env()
    assert "no card" in refused(env, scope="local-harness", agent="claude-code@nowhere", expires="30d").message
    assert "not a card id" in refused(env, scope="local-harness", agent="not a card", expires="30d").message
    assert "remote-peer keys only" in refused(
        env, scope="local-harness", agent="claude-code@box", cards=["claude-code@box"], expires="30d"
    ).message


def test_a_remote_peer_key_carries_its_allowlist():
    env = key_env()
    made = env.create(scope="remote-peer", agent="peer-a", cards=["claude-code@box", "claude-code@box", "antigravity@box"], expires="30d")
    assert made["cards_allowed"] == ["claude-code@box", "antigravity@box"]
    record = asyncio.run(env.store.get(made["key_id"]))
    assert record.peer_id == "peer-a" and record.card_id is None
    assert "at least one card" in refused(env, scope="remote-peer", agent="peer-a", expires="30d").message
    assert "no card" in refused(env, scope="remote-peer", agent="peer-a", cards=["claude-code@nowhere"], expires="30d").message
    assert refused(env, scope="remote-peer", agent="Peer A", cards=["claude-code@box"], expires="30d").code == "invalid_args"


def test_a_status_client_key_has_no_card_and_no_allowlist():
    env = key_env()
    made = env.create(scope="status-client", agent="cognitive-engine", expires="90d")
    assert made["owner"] == "cognitive-engine" and made["cards_allowed"] is None
    assert "remote-peer keys only" in refused(
        env, scope="status-client", agent="cognitive-engine", cards=["claude-code@box"], expires="90d"
    ).message


def test_a_failed_audit_write_issues_no_key():
    env = key_env()
    env.audit_store.fail_with = RuntimeError("audit down")
    err = refused(env, scope="local-harness", agent="claude-code@box", expires="30d")
    assert err.code == "audit_failed"
    assert all(r.revoked_at is not None for r in env.store.records.values())  # nothing usable was left behind


# -- list -----------------------------------------------------------------------------------


def test_list_shows_every_key_and_never_a_secret_or_a_hash():
    env = key_env()
    a = env.create(scope="local-harness", agent="claude-code@box", expires="30d")
    b = env.create(scope="remote-peer", agent="peer-a", cards=["claude-code@box"], expires="30d")
    asyncio.run(env.admin.revoke({"key_id": b["key_id"]}, ACTOR))
    listing = asyncio.run(env.admin.list_keys())
    rows = {r["key_id"]: r for r in listing["keys"]}
    assert rows[a["key_id"]]["status"] == "active" and rows[b["key_id"]]["status"] == "revoked"
    text = json.dumps(listing)
    for made in (a, b):
        secret = parse_key(made["token"]).secret
        assert secret not in text and made["token"] not in text
    for record in env.store.records.values():
        assert record.secret_hash not in text and "secret_hash" not in text
    env.clock.advance(days=31)
    assert {r["status"] for r in asyncio.run(env.admin.list_keys())["keys"]} == {"expired", "revoked"}


# -- rotate ---------------------------------------------------------------------------------


def test_rotate_keeps_the_old_key_for_the_grace_period_and_issues_a_working_one():
    env = key_env(exposure_stage="s2")
    old = env.create(scope="local-harness", agent="claude-code@box", tailnet_node="mac", expires="60d")
    result = asyncio.run(env.admin.rotate({"key_id": old["key_id"]}, ACTOR))
    assert result["replaces"] == old["key_id"] and result["key_id"] != old["key_id"]
    # Same owner, scope and binding; the lifetime of the old key, within the ceiling.
    assert (result["scope"], result["owner"], result["tailnet_node"]) == ("local-harness", "claude-code@box", "mac")
    assert result["expires_at"] == (NOW + timedelta(days=60)).isoformat()
    assert result["old_expires_at"] == (NOW + timedelta(hours=24)).isoformat()  # default grace
    assert verdict(env, result["token"]) is Verdict.OK
    assert verdict(env, old["token"]) is Verdict.OK  # inside the grace period
    env.clock.advance(hours=23, minutes=59)
    assert verdict(env, old["token"]) is Verdict.OK
    env.clock.advance(minutes=2)
    assert verdict(env, old["token"]) is Verdict.EXPIRED
    assert verdict(env, result["token"]) is Verdict.OK
    rows = env.audit_store.of(AuditEvent.KEY_ROTATED)
    assert len(rows) == 1 and rows[0].detail["new_key_id"] == result["key_id"] and rows[0].detail["key_id"] == old["key_id"]


def test_rotate_grace_can_be_set_and_never_outlives_the_key():
    env = key_env()
    short = env.create(scope="local-harness", agent="claude-code@box", expires="2h")
    result = asyncio.run(env.admin.rotate({"key_id": short["key_id"], "grace": "72h"}, ACTOR))
    assert result["old_expires_at"] == (NOW + timedelta(hours=2)).isoformat()  # its own expiry, not 72 h
    now_off = env.create(scope="local-harness", agent="claude-code@box", expires="30d")
    result = asyncio.run(env.admin.rotate({"key_id": now_off["key_id"], "grace": "0h"}, ACTOR))
    assert verdict(env, now_off["token"]) is Verdict.EXPIRED  # grace 0 ends the old key now
    assert verdict(env, result["token"]) is Verdict.OK
    with pytest.raises(AdminError) as e:
        asyncio.run(env.admin.rotate({"key_id": now_off["key_id"], "grace": "soon"}, ACTOR))
    assert e.value.code == "invalid_args"


def test_the_replacement_never_outlives_the_stage_ceiling():
    env = key_env()  # s1 allows 365 days; the same records are then rotated by a stage-s2 server
    old = env.create(scope="remote-peer", agent="peer-a", cards=["claude-code@box"], expires="365d")
    strict = key_env(exposure_stage="s2")
    strict.store.records.update(env.store.records)
    result = asyncio.run(strict.admin.rotate({"key_id": old["key_id"]}, ACTOR))
    assert result["expires_at"] == (NOW + timedelta(days=90)).isoformat()
    assert result["cards_allowed"] == ["claude-code@box"]
    with pytest.raises(AdminError) as e:
        asyncio.run(strict.admin.rotate({"key_id": old["key_id"], "expires": "91d"}, ACTOR))
    assert e.value.code == "invalid_args"


def test_a_revoked_expired_or_unknown_key_cannot_be_rotated():
    env = key_env()
    gone = env.create(scope="local-harness", agent="claude-code@box", expires="30d")
    asyncio.run(env.admin.revoke({"key_id": gone["key_id"]}, ACTOR))
    for key_id, code in ((gone["key_id"], "refused"), ("abcdef01", "not_found"), ("nothex!!", "invalid_args")):
        with pytest.raises(AdminError) as e:
            asyncio.run(env.admin.rotate({"key_id": key_id}, ACTOR))
        assert e.value.code == code
    old = env.create(scope="local-harness", agent="claude-code@box", expires="2h")
    env.clock.advance(hours=3)
    with pytest.raises(AdminError) as e:
        asyncio.run(env.admin.rotate({"key_id": old["key_id"]}, ACTOR))
    assert e.value.code == "refused"


# -- revoke ---------------------------------------------------------------------------------


def test_revoke_refuses_the_key_at_once_and_runs_the_hooks():
    env = key_env()
    made = env.create(scope="local-harness", agent="claude-code@box", expires="30d")
    seen: list[str] = []
    env.hooks.register("mcp", lambda key_id: (seen.append(key_id), 2)[1])

    async def async_hook(key_id: str) -> int:
        seen.append(f"async:{key_id}")
        return 1

    env.hooks.register("wake", async_hook)
    result = asyncio.run(env.admin.revoke({"key_id": made["key_id"]}, ACTOR))
    assert result["closed"] == {"mcp": 2, "wake": 1} and result["hook_failures"] == [] and result["audited"] is True
    assert seen == [made["key_id"], f"async:{made['key_id']}"]
    assert verdict(env, made["token"]) is Verdict.REVOKED
    assert [r.actor for r in env.audit_store.of(AuditEvent.KEY_REVOKED)] == [ACTOR]
    with pytest.raises(AdminError) as e:
        asyncio.run(env.admin.revoke({"key_id": made["key_id"]}, ACTOR))
    assert e.value.code == "refused"
    with pytest.raises(AdminError) as e:
        asyncio.run(env.admin.revoke({"key_id": "abcdef01"}, ACTOR))
    assert e.value.code == "not_found"


def test_a_failing_hook_is_reported_and_does_not_undo_or_skip_the_rest():
    env = key_env()
    made = env.create(scope="local-harness", agent="claude-code@box", expires="30d")

    def broken(_key_id: str) -> int:
        raise RuntimeError("boom")

    env.hooks.register("broken", broken)
    env.hooks.register("mcp", lambda _k: 3)
    result = asyncio.run(env.admin.revoke({"key_id": made["key_id"]}, ACTOR))
    assert result["hook_failures"] == ["broken"] and result["closed"] == {"mcp": 3}
    assert verdict(env, made["token"]) is Verdict.REVOKED


def test_revoke_still_succeeds_when_the_audit_write_fails():
    env = key_env()
    made = env.create(scope="local-harness", agent="claude-code@box", expires="30d")
    env.audit_store.fail_with = RuntimeError("audit down")
    result = asyncio.run(env.admin.revoke({"key_id": made["key_id"]}, ACTOR))
    assert result["revoked"] is True and result["audited"] is False
    assert verdict(env, made["token"]) is Verdict.REVOKED
