"""Invariant (api 9, 3.2): the Agent Card declares only the auth that is enforced and only the capabilities
that are on.

`test_a2a_cards.py` checks the card builder (one Bearer scheme, honest capability flags). This file checks
the served cards against the running server, on the wire:

- every card served (the public front desk, a member card, the extended card) declares exactly one security
  scheme, HTTP Bearer, and every requirement refers to a declared scheme: no API key header scheme, no
  OAuth, no OpenID Connect, no mTLS, no cookie scheme;
- what the card declares is what the server does: every interface URL in the card answers `401` with
  `WWW-Authenticate: Bearer` without a key, `403` with a key of a scope the endpoint refuses, and works with
  a key it accepts;
- the capabilities flags that are true are the ones that work: streaming is off while the server has no
  streaming path (a `SendStreamingMessage` is refused), push follows `A2A_PUSH_ENABLED` and a push-config
  request is refused while it is off.
"""

from __future__ import annotations

import pytest
from a2a_helpers import CARD_CLAUDE, make_a2a_env, send_params

ROOT = "/.well-known/agent-card.json"
MEMBER = f"/agents/{CARD_CLAUDE}/.well-known/agent-card.json"


@pytest.fixture
def env(pg_db):
    return make_a2a_env(pg_db, public_url="https://a2a.example")


def served_cards(env, wire):
    return {
        "front desk": wire.card(ROOT).json(),
        "member": wire.card(MEMBER, env.keys.claude).json(),
        "extended (JSON-RPC)": wire.rpc(env.keys.claude, "GetExtendedAgentCard", {"tenant": CARD_CLAUDE}).json()["result"],
        "extended (REST)": wire.rest(env.keys.claude, "GET", f"/{CARD_CLAUDE}/extendedAgentCard").json(),
    }


def test_every_served_card_declares_the_bearer_scheme_and_nothing_else(env):
    wire = env.wire()
    cards = served_cards(env, wire)
    assert len(cards) == 4
    for name, card in cards.items():
        schemes = card["securitySchemes"]
        assert list(schemes) == ["bearerAuth"], (name, list(schemes))
        assert list(schemes["bearerAuth"]) == ["httpAuthSecurityScheme"] and schemes["bearerAuth"]["httpAuthSecurityScheme"]["scheme"] == "Bearer"
        for requirement in card["securityRequirements"]:
            assert set(requirement["schemes"]) <= set(schemes), (name, requirement)
        text = str(card).lower()
        for foreign in ("apikeysecurityscheme", "oauth2", "openidconnect", "mutualtls", "cookie"):
            assert foreign not in text, (name, foreign)


def test_the_declared_auth_is_what_the_interface_urls_enforce(env):
    wire = env.wire()
    card = wire.card(MEMBER, env.keys.claude).json()
    assert {i["protocolBinding"] for i in card["supportedInterfaces"]} == {"JSONRPC", "HTTP+JSON"}
    for interface in card["supportedInterfaces"]:
        path = interface["url"].removeprefix("https://a2a.example")
        assert path == "/a2a/v1"
        if interface["protocolBinding"] == "JSONRPC":
            send = lambda token: wire.rpc_raw(token, {"jsonrpc": "2.0", "id": 1, "method": "ListTasks", "params": {}})  # noqa: E731
        else:
            send = lambda token: wire.rest(token, "GET", "/tasks")  # noqa: E731
        none, wrong, bad = send(None), send(env.keys.status), send("a2ak_dev_deadbeef_" + "A" * 43)
        assert none.status_code == 401 and none.headers["www-authenticate"] == "Bearer"
        assert bad.status_code == 401 and bad.headers["www-authenticate"] == "Bearer"
        assert wrong.status_code == 403  # a key whose scope the endpoint refuses
        assert send(env.keys.claude).status_code == 200 and send(env.keys.peer).status_code == 200


def test_the_capabilities_the_card_says_are_on_are_on_and_the_off_ones_are_refused(env):
    wire = env.wire()
    caps = wire.card(MEMBER, env.keys.claude).json()["capabilities"]
    assert caps.get("streaming", False) is False and caps.get("pushNotifications", False) is False  # push is off by default
    refused = wire.rpc(env.keys.claude, "SendStreamingMessage", send_params(CARD_CLAUDE))
    assert refused.status_code != 200 or "error" in refused.json()
    push = wire.rest(env.keys.claude, "POST", "/tasks/x/pushNotificationConfigs", json_body={"url": "https://x.invalid/h"})
    assert push.status_code >= 400
