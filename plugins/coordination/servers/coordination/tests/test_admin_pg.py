"""The admin plane against a real Postgres (S1-ADMIN): the CLI, over the real Unix socket, running
the real commands on the real service layer.

What is proved here that the in-memory tests cannot:

- keys are written to and read from `api_keys`, rotation is one transaction, and `list` over the
  real rows carries no secret or hash;
- a held task leaves its hold ONLY through `review release` with the exact phrase (the runtime half
  of the D19 acceptance; the static half is `test_admin_release_path.py`): every other request on
  the socket, and every other service call, leaves it held;
- release and deny are audited with the operating-system actor, and `status` and `card check` read
  the real tables.

Needs Docker like the rest of the Postgres suite (`A2A_TEST_REQUIRE_DOCKER=1` turns a skip into a
failure).
"""

from __future__ import annotations

import asyncio
import dataclasses
import io
import json
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
import sqlalchemy as sa

from a2a.types import a2a_pb2 as pb
from admin_helpers import FakeTerminal
from conftest import run
from coordination.a2a.cards import CardDefinition, CardRegistry
from coordination.admin.keystore import SqlKeyAdminStore
from coordination.admin.protocol import AdminError, decode_reply, encode_request
from coordination.admin.server import AdminServer
from coordination.admin.wiring import build_admin
from coordination.auth import ApiKeyRecord, Verdict, generate_key, parse_key, verify_key
from coordination.cli import main
from coordination.mcp import McpEndpoint, build_endpoint
from coordination.service.errors import ServiceError
from coordination.store.tables import cards, task_index, wakes
from service_helpers import CARD_A, CARD_B, CARD_C, H_A1, Env, local, msg, remote, service_env

S = pb.TaskState


@dataclass
class Plane:
    env: Env
    server: AdminServer
    mcp: McpEndpoint
    path: Path
    keys: SqlKeyAdminStore

    async def cli(self, *argv: str, typed: str | None = None, tty: bool = True, environ: dict[str, str] | None = None):
        """Run `a2a-coord` in a thread over the real socket; returns (exit code, stdout, stderr)."""
        term = FakeTerminal(stdin=tty, stdout=tty, typed=typed)
        out, err = io.StringIO(), io.StringIO()
        code = await asyncio.to_thread(
            main, list(argv), environ={"A2A_ADMIN_SOCKET": str(self.path), **(environ or {})}, terminal=term, out=out, err=err
        )
        return code, out.getvalue(), err.getvalue()

    async def raw(self, cmd: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        reader, writer = await asyncio.open_unix_connection(str(self.path))
        writer.write(encode_request(cmd, args))
        await writer.drain()
        data = await reader.readline()
        writer.close()
        return decode_reply(data)

    async def state_of(self, task_id: str) -> tuple[int, str | None]:
        stored = await self.env.store.get(task_id)
        index = await self.env.store.get_index(task_id)
        return stored.task.status.state, index.hold if index else None


@asynccontextmanager
async def plane(config, sock_dir: Path, **settings: int):
    path = sock_dir / "admin.sock"
    config = dataclasses.replace(config, admin_socket=str(path))
    async with service_env(config, **settings) as env:
        registry = CardRegistry({c: CardDefinition(c) for c in (CARD_A, CARD_B, CARD_C)})
        mcp = build_endpoint(config, env.service, env.engine, env.clock, audit=env.audit_log)
        keys = SqlKeyAdminStore(env.engine)
        server = build_admin(config, env.clock, env.engine, env.service, env.store, env.audit_log, env.directory, registry, keys=keys, mcp=mcp)
        await server.start()
        try:
            yield Plane(env, server, mcp, path, keys)
        finally:
            await server.stop()


# -- keys -----------------------------------------------------------------------------------


def test_key_lifecycle_over_the_socket_on_real_rows(config, sock_dir):
    async def go():
        async with plane(config, sock_dir) as p:
            code, out, err = await p.cli("key", "create", "--scope", "local-harness", "--agent", CARD_A, "--expires", "90d")
            assert code == 0, err
            token = next(line.strip() for line in out.splitlines() if line.strip().startswith("a2ak_"))
            parsed = parse_key(token)
            record = await p.keys.get(parsed.key_id)
            now = p.env.clock.now()
            assert verify_key(token, record, env="dev", pepper=None, now=now) is Verdict.OK
            assert out.count(token) == 1 and err == ""

            # list: the real row, no secret, no hash, no token
            code, listing, err = await p.cli("key", "list", tty=False)
            assert code == 0 and parsed.key_id in listing and CARD_A in listing and "active" in listing
            code, as_json, _ = await p.cli("key", "list", "--json", tty=False)
            assert parsed.secret not in listing + as_json + err and record.secret_hash not in listing + as_json
            assert token not in listing + as_json

            # a replacement, in one transaction; the old key keeps working for the grace period
            code, out2, err2 = await p.cli("key", "rotate", parsed.key_id, "--grace", "2h")
            assert code == 0, err2
            new_token = next(line.strip() for line in out2.splitlines() if line.strip().startswith("a2ak_"))
            new = parse_key(new_token)
            old_after = await p.keys.get(parsed.key_id)
            new_rec = await p.keys.get(new.key_id)
            assert old_after.expires_at == now + timedelta(hours=2) and new_rec.card_id == CARD_A
            assert verify_key(token, old_after, env="dev", pepper=None, now=now) is Verdict.OK
            assert verify_key(new_token, new_rec, env="dev", pepper=None, now=now) is Verdict.OK
            assert verify_key(token, old_after, env="dev", pepper=None, now=now + timedelta(hours=3)) is Verdict.EXPIRED

            # revoke drops the key's MCP sessions at once and the key is refused
            p.mcp.sessions.create("sess-1", new.key_id, CARD_A)
            p.mcp.sessions.create("sess-2", new.key_id, CARD_A)
            p.mcp.sessions.create("sess-other", "ffffffff", CARD_A)
            code, out3, err3 = await p.cli("key", "revoke", new.key_id, tty=False)
            assert code == 0 and "mcp 2" in out3, (out3, err3)
            assert p.mcp.sessions.get("sess-1") is None and p.mcp.sessions.get("sess-2") is None
            assert p.mcp.sessions.get("sess-other") is not None
            revoked = await p.keys.get(new.key_id)
            assert verify_key(new_token, revoked, env="dev", pepper=None, now=now) is Verdict.REVOKED
            code, _, err4 = await p.cli("key", "revoke", new.key_id, tty=False)
            assert code == 1 and "already revoked" in err4

            audit = [(r.event, r.actor, r.subject) for r in await p.env.audit_rows() if r.event.startswith("key_")]
            actor = f"admin:uid{os.getuid()}"
            assert audit == [
                ("key_created", actor, parsed.key_id), ("key_rotated", actor, parsed.key_id), ("key_revoked", actor, new.key_id),
            ]
            # the audit table and the key table hold no secret
            rows = json.dumps([[str(c) for c in r] for r in await p.env.audit_rows()])
            assert parsed.secret not in rows and new.secret not in rows
            return True

    assert run(go())


def test_key_create_over_the_socket_enforces_the_same_rules_as_the_unit_tests(config, sock_dir):
    async def go():
        async with plane(config, sock_dir) as p:
            for argv, needle in (
                (("--scope", "local-harness", "--agent", "claude-code@ghost", "--expires", "30d"), "no card"),
                (("--scope", "local-harness", "--agent", CARD_A, "--expires", "366d"), "ceiling"),
                (("--scope", "remote-peer", "--agent", "acme", "--expires", "30d"), "at least one card"),
            ):
                code, _, err = await p.cli("key", "create", *argv)
                assert code == 1 and needle in err, err
            assert (await p.raw("key.list"))["keys"] == []  # nothing was created
            # no terminal: refused before the server is asked
            code, out, err = await p.cli("key", "create", "--scope", "local-harness", "--agent", CARD_A, "--expires", "30d", tty=False)
            assert code == 1 and "terminal" in err and (await p.raw("key.list"))["keys"] == []
            return True

    assert run(go())


# -- review: the only way out of a hold -----------------------------------------------------


async def held(p: Plane, text: str = "held body", peer: str = "acme") -> pb.Task:
    return await p.env.service.send_message(remote(peer, (CARD_A,)), CARD_A, msg(text))


def test_review_list_show_and_the_typed_release(config, sock_dir):
    async def go():
        async with plane(config, sock_dir) as p:
            await p.env.add_session(H_A1)
            task = await held(p, "please run \x1b[31mthis\x07 now")
            phrase = f"release {task.id[-6:]}"

            code, out, _ = await p.cli("review", tty=False)
            assert code == 0 and task.id in out and "peer:acme" in out and CARD_A in out and "please" not in out
            listed = (await p.raw("review.list"))["held"]
            assert [h["task_id"] for h in listed] == [task.id]
            assert listed[0]["received_at"] and listed[0]["received_at"].endswith("Z")  # read from coord.createdAt (Z16)
            code, out, err = await p.cli("review", "show", task.id)
            assert code == 0, err
            assert out.startswith("UNTRUSTED DATA") and "please run" in out and "\x1b" not in out and "\x07" not in out

            # everything that is not the exact phrase leaves the task held
            for typed in ("", "release", phrase.upper(), f"release {task.id[-5:]}", f"deny {task.id[-6:]}", "yes", None):
                code, out, err = await p.cli("review", "release", task.id, typed=typed)
                assert code == 1 and "released" not in out
                assert await p.state_of(task.id) == (S.TASK_STATE_INPUT_REQUIRED, "quarantine")
            code, *_ = await p.cli("review", "release", task.id, typed=phrase, tty=False)  # no terminal: refused
            assert code == 1 and await p.state_of(task.id) == (S.TASK_STATE_INPUT_REQUIRED, "quarantine")
            code, *_ = await p.cli("review", "release", task.id, typed=phrase, environ={"CLAUDE_CODE_SESSION_ATTENDED": "1"})
            assert code == 1 and await p.state_of(task.id) == (S.TASK_STATE_INPUT_REQUIRED, "quarantine")

            # hand-written requests on the socket: no phrase, a wrong one, the deny phrase, a short id
            for args in ({"task_id": task.id}, {"task_id": task.id, "phrase": "release 000000"},
                         {"task_id": task.id, "phrase": f"deny {task.id[-6:]}"}, {"task_id": task.id, "phrase": 5},
                         {"task_id": task.id[-6:], "phrase": phrase}, {"phrase": phrase}, {"task_id": task.id, "all": True}):
                with pytest.raises(AdminError):
                    await p.raw("review.release", args)
                assert await p.state_of(task.id) == (S.TASK_STATE_INPUT_REQUIRED, "quarantine"), args
            with pytest.raises(AdminError) as e:
                await p.raw("review.release_all")
            assert e.value.code == "unknown_command"

            # the right phrase, once
            code, out, err = await p.cli("review", "release", task.id, typed=phrase)
            assert code == 0 and "released to SUBMITTED" in out, err
            assert await p.state_of(task.id) == (S.TASK_STATE_SUBMITTED, None)
            # the recipient side can now see it; a second release has nothing to release
            seen = await p.env.service.get_task(local(CARD_A, H_A1), task.id)
            assert seen.status.state == S.TASK_STATE_SUBMITTED
            code, _, err = await p.cli("review", "release", task.id, typed=phrase)
            assert code == 1 and "no held task" in err
            with pytest.raises(AdminError) as e:  # and the socket itself says so, past the CLI's look
                await p.raw("review.release", {"task_id": task.id, "phrase": phrase})
            assert e.value.code == "invalid_transition"
            code, out, _ = await p.cli("review", tty=False)
            assert "no held tasks" in out

            actor = f"admin:uid{os.getuid()}"
            assert await p.env.transitions_of(task.id) == [(None, "QUARANTINED", "r1234abcd"), ("QUARANTINED", "TASK_STATE_SUBMITTED", actor)]
            assert [(r.actor, r.subject) for r in await p.env.audit_rows("hold_released")] == [(actor, task.id)]
            return True

    assert run(go())


def test_one_release_does_not_release_another_task_and_there_is_no_bulk_form(config, sock_dir):
    async def go():
        async with plane(config, sock_dir) as p:
            a, b = await held(p, "a"), await held(p, "b")
            code, *_ = await p.cli("review", "release", a.id, typed=f"release {a.id[-6:]}")
            assert code == 0
            assert await p.state_of(a.id) == (S.TASK_STATE_SUBMITTED, None)
            assert await p.state_of(b.id) == (S.TASK_STATE_INPUT_REQUIRED, "quarantine")
            # b's phrase typed for a (or a's for b) does nothing
            code, *_ = await p.cli("review", "release", b.id, typed=f"release {a.id[-6:]}")
            assert code == 1 and await p.state_of(b.id) == (S.TASK_STATE_INPUT_REQUIRED, "quarantine")
            return True

    assert run(go())


def test_nothing_but_the_admin_release_leaves_a_hold_at_runtime(config, sock_dir):
    """Every other door to a held task, on the real service and the real socket, leaves it held (or
    refuses it, expires it to REJECTED, or cancels it): none of them yields SUBMITTED."""

    async def go():
        async with plane(config, sock_dir, quarantine_ttl_h=72) as p:
            await p.env.add_session(H_A1)
            svc, me = p.env.service, local(CARD_A, H_A1)
            peer = remote("acme", (CARD_A,))
            task = await held(p)
            second = await svc.send_message(peer, CARD_A, msg("second"))
            third = await svc.send_message(peer, CARD_A, msg("third"))

            # the recipient side cannot see, claim, answer or message it
            for call in (
                svc.get_task(me, task.id),
                svc.claim(me, task.id),
                svc.respond(me, task.id, "working"),
                svc.respond(me, task.id, "completed", text="done"),
            ):
                with pytest.raises(ServiceError):
                    await call
            assert (await svc.inbox(me)).items == []
            # the originator cannot move it on: a follow-up is refused, only a cancel is allowed
            follow_up = msg("more", task_id=task.id, context_id=task.context_id)
            with pytest.raises(ServiceError):
                await svc.send_message(peer, CARD_A, follow_up)
            # the admin socket's other commands: a read, and the wrong phrase
            await p.raw("review.show", {"task_id": task.id})
            await p.raw("review.list")
            await p.raw("status")
            await p.raw("card.check")
            for args in ({"task_id": task.id, "phrase": "release"}, {"task_id": task.id}):
                with pytest.raises(AdminError):
                    await p.raw("review.release", args)
            assert await p.state_of(task.id) == (S.TASK_STATE_INPUT_REQUIRED, "quarantine")

            # a cancel is not a release; an expiry is not a release
            canceled = await svc.cancel_task(peer, second.id)
            assert canceled.status.state == S.TASK_STATE_CANCELED
            p.env.clock.advance(hours=73)
            await p.env.touch_session(H_A1)
            result = await svc.sweep()
            assert result.quarantine_expired >= 1
            assert (await p.state_of(task.id))[0] == S.TASK_STATE_REJECTED
            assert (await p.state_of(third.id))[0] == S.TASK_STATE_REJECTED
            # and a task the sweep rejected cannot be released afterwards either
            with pytest.raises(AdminError) as e:
                await p.raw("review.release", {"task_id": third.id, "phrase": f"release {third.id[-6:]}"})
            assert e.value.code == "invalid_transition"

            # across the whole run, no task other than one released by phrase ever had a
            # `-> SUBMITTED` transition from QUARANTINED
            rows = [r for r in await p.env.audit_rows("state_transition") if r.detail_json["from_state"] == "QUARANTINED" and r.detail_json["to_state"] == "TASK_STATE_SUBMITTED"]
            assert rows == []
            return True

    assert run(go())


def test_deny_rejects_with_the_human_reason_and_keeps_the_task_hidden(config, sock_dir):
    async def go():
        async with plane(config, sock_dir) as p:
            await p.env.add_session(H_A1)
            task = await held(p)
            code, *_ = await p.cli("review", "deny", task.id, typed=f"release {task.id[-6:]}")
            assert code == 1 and await p.state_of(task.id) == (S.TASK_STATE_INPUT_REQUIRED, "quarantine")
            code, out, err = await p.cli("review", "deny", task.id, typed=f"deny {task.id[-6:]}")
            assert code == 0, err
            state, hold = await p.state_of(task.id)
            assert state == S.TASK_STATE_REJECTED and hold == "quarantine"
            seen = await p.env.service.get_task(remote("acme", (CARD_A,)), task.id)
            assert json.loads(__import__("google.protobuf.json_format", fromlist=["x"]).MessageToJson(seen.metadata))["coord"]["reason"] == "denied_by_human"
            actor = f"admin:uid{os.getuid()}"
            assert [(r.actor, r.subject) for r in await p.env.audit_rows("hold_denied")] == [(actor, task.id)]
            return True

    assert run(go())


# -- status and card check ------------------------------------------------------------------


def test_status_reads_the_real_tables(config, sock_dir):
    async def go():
        async with plane(config, sock_dir) as p:
            fresh = (await p.raw("status"))
            assert fresh["sessions"] == {"registered": 0, "active": 0, "ended": 0, "by_card": [], "mcp_bound": 0}
            assert fresh["listeners"] == {"parked": None}  # WAKE fills it
            assert fresh["pending"]["submitted"] == fresh["pending"]["held"] == 0
            assert fresh["schema"]["coord_schema_version"] >= 2 and fresh["backup"] == {"dump_age_h": None, "stale": False}

            await p.env.add_session(H_A1)
            await p.env.add_session(f"{CARD_A}/old~aaaaaaa9", ended=True)
            p.mcp.sessions.create("m1", "k", CARD_A)
            queued = await p.env.service.send_message(local(CARD_B, "antigravity@box/one~bbbbbbb1"), CARD_C, msg("queued"))
            await held(p)
            stale = await p.env.service.send_message(local(CARD_B), CARD_A, msg("stale"))
            async with p.env.engine.begin() as conn:
                await conn.execute(sa.update(task_index).where(task_index.c.task_id == stale.id).values(offer_count=5))
                await conn.execute(sa.insert(wakes).values(handle=H_A1, at=p.env.clock.now(), pending_n=1))
                await conn.execute(sa.insert(wakes).values(handle=H_A1, at=p.env.clock.now() - timedelta(hours=2), pending_n=1))

            r = await p.raw("status")
            assert (r["sessions"]["registered"], r["sessions"]["active"], r["sessions"]["ended"], r["sessions"]["mcp_bound"]) == (1, 1, 1, 1)
            assert r["pending"]["held"] == 1 and r["pending"]["submitted"] == 2 and r["pending"]["card_queue"] == 1
            assert {c["card"]: c["submitted"] for c in r["pending"]["by_card"]} == {CARD_A: 1, CARD_C: 1}
            assert r["budgets"]["used"] == [{"handle": H_A1, "wakes": 1, "remaining": r["budgets"]["wake_per_hour_limit"] - 1}]
            assert r["stale_offers"]["count"] == 1 and r["stale_offers"]["tasks"][0]["task_id"] == stale.id
            assert queued.id not in json.dumps(r["stale_offers"])
            # no body anywhere in the status
            assert "queued" not in json.dumps({k: v for k, v in r.items() if k != "pending"})
            code, out, err = await p.cli("status", tty=False)
            assert code == 0 and "1 held for review" in out and "stale offers: 1" in out and "null parked" in out, err
            return True

    assert run(go())


def test_card_check_finds_what_is_wrong_and_exits_by_the_result(config, sock_dir):
    async def go():
        async with plane(config, sock_dir) as p:
            code, out, err = await p.cli("card", "check", tty=False)
            assert code == 0 and "cards OK" in out, (out, err)
            # a key that names a card nobody defines, written straight to the table
            gen = generate_key("dev")
            await p.keys.insert(ApiKeyRecord(
                key_id=gen.key_id, env="dev", name="ghost", scope="remote-peer", secret_hash=gen.secret_hash,
                created_at=p.env.clock.now(), expires_at=p.env.clock.now() + timedelta(days=1),
                peer_id="ghost", cards_allowed=("claude-code@ghost",),
            ))
            async with p.env.engine.begin() as conn:
                await conn.execute(sa.delete(cards).where(cards.c.card_id == CARD_C))
            code, out, err = await p.cli("card", "check", tty=False)
            assert code == 1 and "PROBLEM" in out
            assert "claude-code@ghost" in out and f"{CARD_C}: defined in the cards file but not in the cards table" in out
            return True

    assert run(go())


def test_a_database_failure_is_exit_2_not_a_trace(config, sock_dir):
    async def go():
        async with plane(config, sock_dir) as p:
            await p.env.engine.dispose()
            async with p.env.engine.begin() as conn:  # reconnects: the pool is fine, so break the table instead
                await conn.execute(sa.text("ALTER TABLE api_keys RENAME TO api_keys_gone"))
            code, out, err = await p.cli("key", "list", tty=False)
            assert code == 2 and "[unavailable]" in err and "Traceback" not in err
            async with p.env.engine.begin() as conn:
                await conn.execute(sa.text("ALTER TABLE api_keys_gone RENAME TO api_keys"))
            assert (await p.cli("key", "list", tty=False))[0] == 0
            return True

    assert run(go())


# -- the assembled server -------------------------------------------------------------------


def test_build_server_app_opens_the_socket_with_its_lifespan_and_serves_no_admin_route(config, sock_dir, tmp_path):
    """The real app, as `main` builds it: the socket appears when the app starts, is mode 0600,
    serves the commands against the real database, and is gone when the app stops. The HTTP side
    answers 404 for any admin path, with a valid key and without one."""
    import stat

    from starlette.testclient import TestClient

    from coordination.app import build_server_app

    cards_file = tmp_path / "cards.yaml"
    cards_file.write_text(f"cards:\n  - name: {CARD_A}\n  - name: {CARD_B}\n")
    sock = sock_dir / "admin.sock"
    cfg = dataclasses.replace(config, admin_socket=str(sock), cards_file=str(cards_file))

    async def prepare():
        from coordination.store import schema
        from coordination.store.engine import make_engine

        engine = make_engine(cfg)
        try:
            await schema.migrate_all(engine)
        finally:
            await engine.dispose()

    run(prepare())
    app = build_server_app(cfg)
    assert not sock.exists()  # building the app opens nothing
    with TestClient(app, base_url="http://127.0.0.1:8120") as client:
        assert sock.exists() and stat.S_IMODE(sock.stat().st_mode) == 0o600
        assert app.state.admin.hooks.names() == ["mcp", "wake"]  # revoke closes MCP sessions and (S1-WAKE) parked listeners
        out, err = io.StringIO(), io.StringIO()
        term = FakeTerminal()
        env = {"A2A_ADMIN_SOCKET": str(sock)}
        assert main(["key", "create", "--scope", "local-harness", "--agent", CARD_A, "--expires", "30d"], environ=env, terminal=term, out=out, err=err) == 0, err.getvalue()
        token = next(line.strip() for line in out.getvalue().splitlines() if line.strip().startswith("a2ak_"))
        code_out = io.StringIO()
        assert main(["card", "check"], environ=env, terminal=term, out=code_out, err=err) == 0, code_out.getvalue()
        # the new key works against the real HTTP side; an admin path is 404 for everyone
        assert client.get("/healthz").status_code == 200
        headers = {"Authorization": f"Bearer {token}"}
        for path in ("/admin", "/admin/keys", "/a2a/admin"):
            assert client.get(path, headers=headers).status_code == 404
            assert client.get(path).status_code == 404
        assert client.get("/mcp", headers={}).status_code == 401
    assert not sock.exists()
