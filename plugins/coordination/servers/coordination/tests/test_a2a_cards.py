"""Agent Cards (S1-A2A, spec 3.2, 8.5, decisions D31, D32, D35, Z13): the builder, the cards file and
the card routes behind the real access-control middleware."""

from __future__ import annotations

import json

import pytest
import sqlalchemy as sa
from a2a_helpers import (
    CARD_AGY,
    CARD_CLAUDE,
    CARD_MAC,
    CARDS_YAML,
    H_CLAUDE,
    make_a2a_env,
)
from auth_helpers import make_config
from conftest import PLUGIN_DIR, run

from coordination.a2a import CardBuilder, CardsError, load_cards, parse_cards, sync_cards
from coordination.a2a.cards import EXTENSION_URI, FRONT_DESK_NAME, card_json, deviation_sentence
from coordination.store.tables import cards as cards_table

REQUIRED = ("name", "description", "supportedInterfaces", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills")


def builder(**overrides) -> tuple[CardBuilder, object]:
    config = make_config(public_url="https://a2a.example", listen="0.0.0.0:8120", **overrides)
    return CardBuilder(config), config


def registry():
    return parse_cards(CARDS_YAML)


# -- the builder ---------------------------------------------------------------------------------


def test_member_card_has_all_eight_required_fields_in_protojson_camelcase():
    b, _ = builder()
    card = card_json(b.member(registry().get(CARD_CLAUDE)))
    for name in REQUIRED:
        assert card.get(name) not in (None, "", [], {}), name
    assert not any("_" in key for key in card), "ProtoJSON is camelCase"
    assert card["name"] == CARD_CLAUDE and card["version"] == "0.1.0"
    assert card["defaultInputModes"] == card["defaultOutputModes"] == ["text/plain", "application/json"]
    assert "supportsAuthenticatedExtendedCard" not in card and "protocolVersion" not in card  # no v0.3 fields (D33)


def test_interfaces_carry_the_public_url_and_the_card_id_as_tenant_never_the_listen_address():
    b, config = builder()
    card = card_json(b.member(registry().get(CARD_AGY)))
    interfaces = card["supportedInterfaces"]
    assert {i["protocolBinding"] for i in interfaces} == {"JSONRPC", "HTTP+JSON"}
    for i in interfaces:
        assert i["url"] == "https://a2a.example/a2a/v1"
        assert i["tenant"] == CARD_AGY  # tenant equals the card id
        assert i["protocolVersion"] == "1.0"
    text = json.dumps(card)
    assert "0.0.0.0" not in text and "8120" not in text  # the listener's address is not an input


def test_a_trailing_slash_in_the_public_url_does_not_double_up():
    b2 = CardBuilder(make_config(public_url="https://a2a.example/"))
    assert card_json(b2.member(registry().get(CARD_MAC)))["supportedInterfaces"][0]["url"] == "https://a2a.example/a2a/v1"


def test_capabilities_are_honest_and_declared_in_the_json_even_when_false():
    b, _ = builder()
    caps = card_json(b.member(registry().get(CARD_CLAUDE)))["capabilities"]
    assert caps["streaming"] is False and caps["pushNotifications"] is False  # D35, stated not implied
    assert caps["extendedAgentCard"] is True
    assert [e["uri"] for e in caps["extensions"]] == [EXTENSION_URI] == ["urn:agentic-hub:coordination:v1"]
    assert caps["extensions"][0]["required"] is False


def test_push_notifications_flag_follows_the_configuration_streaming_never_flips():
    b, _ = builder(push_enabled=True, push_enc_key="k")
    caps = card_json(b.member(registry().get(CARD_CLAUDE)))["capabilities"]
    assert caps["pushNotifications"] is True and caps["streaming"] is False


def test_bearer_scheme_and_requirement_are_declared_as_enforced():
    b, _ = builder()
    card = card_json(b.member(registry().get(CARD_CLAUDE)))
    scheme = card["securitySchemes"]["bearerAuth"]["httpAuthSecurityScheme"]
    assert scheme["scheme"] == "Bearer"
    assert card["securityRequirements"] == [{"schemes": {"bearerAuth": {"list": []}}}]


def test_the_deviation_sentence_is_in_every_description_and_states_the_real_cap():
    for cap in (60, 2):
        b, _ = builder(send_block_max_s=cap)
        for card in (b.member(registry().get(CARD_CLAUDE)), b.member(registry().get(CARD_MAC)), b.front_desk()):
            assert deviation_sentence(cap) in card.description
            assert f"at most {cap} seconds" in card.description and "returnImmediately" in card.description
    # a definition that already carries the sentence does not get it twice
    b, _ = builder()
    text = deviation_sentence(60)
    reg = parse_cards(f"cards:\n  - name: {CARD_CLAUDE}\n    description: 'Hi. {text}'\n")
    assert b.member(reg.get(CARD_CLAUDE)).description.count(text) == 1


def test_a_card_without_skills_gets_the_default_skill_so_the_required_field_is_never_empty():
    b, _ = builder()
    skills = card_json(b.member(registry().get(CARD_MAC)))["skills"]
    assert [s["id"] for s in skills] == ["parked-task-exchange"]
    declared = card_json(b.member(registry().get(CARD_CLAUDE)))["skills"]
    assert declared[0]["examples"] == ["Ask the session to review the plan."] and declared[0]["tags"] == ["coordination"]


def test_front_desk_is_generic_no_member_name_no_tenant():
    b, _ = builder()
    card = card_json(b.front_desk())
    text = json.dumps(card)
    for member in (CARD_CLAUDE, CARD_AGY, CARD_MAC, "@box", "@mac"):
        assert member not in text  # no member name anywhere
    assert card["name"] == FRONT_DESK_NAME
    assert all(i["tenant"] == "" for i in card["supportedInterfaces"])
    assert "bearerAuth" in card["securitySchemes"] and card["securityRequirements"]  # bearer auth declared
    assert [e["uri"] for e in card["capabilities"]["extensions"]] == [EXTENSION_URI]
    assert "params" not in card["capabilities"]["extensions"][0]  # no member listing extension field (Z13)


def test_the_extended_card_lists_sessions_only_when_given_them():
    from coordination.a2a import cards as C

    b, _ = builder()
    definition = registry().get(CARD_CLAUDE)
    plain = card_json(b.extended(definition, None))
    assert "params" not in plain["capabilities"]["extensions"][0]
    rich = card_json(b.extended(definition, [C.LiveSession(H_CLAUDE, "active")]))
    assert rich["capabilities"]["extensions"][0]["params"] == {"sessions": [{"handle": H_CLAUDE, "liveness": "active"}]}


# -- the cards file ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, fragment",
    [
        ("not: [valid", "not valid YAML"),
        ("cards: 3", "`cards` list"),
        ("cards:\n  - 3", "not a mapping"),
        ("cards:\n  - name: Bad Name", "no valid card id"),
        ("cards:\n  - name: a@b\n  - name: a@b", "defined twice"),
        ("cards:\n  - name: a@b\n    skills: [3]", "skills"),
    ],
)
def test_a_bad_cards_file_is_refused_with_a_reason_that_names_no_content(raw, fragment):
    with pytest.raises(CardsError) as exc:
        parse_cards(raw, source="the cards file x")
    assert fragment in str(exc.value)


def test_load_cards_reads_a_file_and_names_a_missing_one(tmp_path):
    path = tmp_path / "cards.yaml"
    path.write_text(CARDS_YAML)
    assert load_cards(str(path)).ids() == [CARD_CLAUDE, CARD_AGY, CARD_MAC]
    with pytest.raises(CardsError, match="cannot be read"):
        load_cards(str(tmp_path / "missing.yaml"))


@pytest.mark.skipif(not (PLUGIN_DIR / "config/cards.yaml").is_file(), reason="the config is outside the build context")
def test_the_repository_cards_file_still_parses():
    path = PLUGIN_DIR / "config" / "cards.yaml"
    assert load_cards(str(path)) is not None


# -- routes, behind the real middleware ----------------------------------------------------------


def test_root_card_is_public_member_cards_need_any_valid_key(pg_db):
    env = make_a2a_env(pg_db, public_url="https://a2a.example")
    wire = env.wire()
    root = wire.card("/.well-known/agent-card.json")
    assert root.status_code == 200 and root.headers["cache-control"] == "max-age=60"
    body = root.json()
    assert body["name"] == FRONT_DESK_NAME and CARD_CLAUDE not in root.text
    # the `?agent=` selector is dropped: it changes nothing, and there is no 300
    selector = wire.card(f"/.well-known/agent-card.json?agent={CARD_CLAUDE}")
    assert selector.status_code == 200 and selector.json() == body

    path = f"/agents/{CARD_CLAUDE}/.well-known/agent-card.json"
    denied = wire.card(path)
    assert denied.status_code == 401 and denied.headers["www-authenticate"] == "Bearer"
    assert wire.card(path, "a2ak_dev_deadbeef_" + "A" * 43).status_code == 401  # unknown key
    for token in (env.keys.claude, env.keys.agy, env.keys.peer, env.keys.status):  # any scope is enough
        got = wire.card(path, token)
        assert got.status_code == 200, token[:12]
        assert got.headers["cache-control"] == "max-age=60"
        assert got.json()["name"] == CARD_CLAUDE


def test_each_member_has_its_own_path_and_its_interface_points_at_its_own_card(pg_db):
    env = make_a2a_env(pg_db, public_url="https://a2a.example")
    wire = env.wire()
    for card_id in (CARD_CLAUDE, CARD_AGY, CARD_MAC):
        got = wire.card(f"/agents/{card_id}/.well-known/agent-card.json", env.keys.claude)
        assert got.status_code == 200
        body = got.json()
        assert body["name"] == card_id
        assert {i["tenant"] for i in body["supportedInterfaces"]} == {card_id}
        assert {i["url"] for i in body["supportedInterfaces"]} == {"https://a2a.example/a2a/v1"}
    unknown = wire.card("/agents/nobody@nowhere/.well-known/agent-card.json", env.keys.claude)
    assert unknown.status_code == 404
    assert wire.card("/agents/nobody@nowhere/.well-known/agent-card.json").status_code == 401  # no oracle without a key


def test_card_routes_still_get_the_host_check(pg_db):
    env = make_a2a_env(pg_db)
    wire = env.wire()
    wrong = wire.http.get("/.well-known/agent-card.json", headers={"Host": "evil.example"})
    assert wrong.status_code == 421


def test_sync_cards_writes_the_cards_table_the_service_reads_and_is_idempotent(pg_db):
    env = make_a2a_env(pg_db)

    async def rows():
        async with env.engine.connect() as conn:
            return {r.card_id: r for r in (await conn.execute(sa.select(cards_table))).all()}

    assert run(sync_cards(env.engine, env.registry)) == 3
    assert run(sync_cards(env.engine, env.registry)) == 3
    got = run(rows())
    assert set(got) == {CARD_CLAUDE, CARD_AGY, CARD_MAC}
    assert got[CARD_CLAUDE].harness == "claude-code" and got[CARD_CLAUDE].machine == "box"
    assert got[CARD_CLAUDE].card_json["description"] == "Claude Code sessions on box."
    assert run(sync_cards(env.engine, parse_cards("cards: []"))) == 0  # nothing deleted, nothing written
    assert set(run(rows())) == {CARD_CLAUDE, CARD_AGY, CARD_MAC}


def test_extended_card_gives_a_local_key_its_live_sessions_and_a_peer_none(pg_db):
    env = make_a2a_env(pg_db)
    env.base.add_session(H_CLAUDE)
    env.base.add_session("claude-code@box/gone~aaaaaaa9", ended=True)
    wire = env.wire()
    local = wire.result(env.keys.claude, "GetExtendedAgentCard", {"tenant": CARD_CLAUDE})
    params = local["capabilities"]["extensions"][0]["params"]
    assert params == {"sessions": [{"handle": H_CLAUDE, "liveness": "active"}]}  # ended ones are not live
    peer = wire.result(env.keys.peer, "GetExtendedAgentCard", {"tenant": CARD_CLAUDE})
    assert "params" not in peer["capabilities"]["extensions"][0]  # a peer never gets a handle (D-H)
    assert H_CLAUDE not in json.dumps(peer)
    denied = wire.error(env.keys.peer, "GetExtendedAgentCard", {"tenant": CARD_AGY})  # outside cards_allowed
    assert denied["code"] == -32010
    front = wire.error(env.keys.claude, "GetExtendedAgentCard", {})
    assert front["code"] == -32602 and "front desk" in front["message"]


def test_cards_carry_an_etag_and_a_matching_if_none_match_gets_304(pg_db):
    """A2A 1.0.1 section 8.6: a server SHOULD send an ETag; the TCK (CARD-CACHE-002) asks for it."""
    env = make_a2a_env(pg_db, public_url="https://a2a.example")
    wire = env.wire()
    member = f"/agents/{CARD_CLAUDE}/.well-known/agent-card.json"
    for path, token in (("/.well-known/agent-card.json", None), (member, env.keys.claude)):
        first = wire.card(path, token)
        etag = first.headers["etag"]
        assert first.status_code == 200 and etag.startswith('"') and etag.endswith('"')
        assert wire.card(path, token).headers["etag"] == etag  # the same card, the same tag
        headers = {**wire.headers(token, version=None), "If-None-Match": etag}
        same = wire.http.get(path, headers=headers)
        assert same.status_code == 304 and same.content == b"" and same.headers["etag"] == etag
        assert same.headers["cache-control"] == "max-age=60"
        weak = wire.http.get(path, headers={**headers, "If-None-Match": f"W/{etag}"})
        assert weak.status_code == 304
        stale = wire.http.get(path, headers={**headers, "If-None-Match": '"0000"'})
        assert stale.status_code == 200 and stale.headers["etag"] == etag
    other = wire.card(f"/agents/{CARD_AGY}/.well-known/agent-card.json", env.keys.claude)
    assert other.headers["etag"] != wire.card(member, env.keys.claude).headers["etag"]  # another card
    # A card that does not exist gets no tag and no 304.
    gone = wire.http.get("/agents/nobody@nowhere/.well-known/agent-card.json", headers={**wire.headers(env.keys.claude, version=None), "If-None-Match": "*"})
    assert gone.status_code == 404 and "etag" not in gone.headers
