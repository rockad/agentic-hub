"""S1-MCP: how Antigravity's MCP client opens the server, replayed against the real stack.

Source of the requests: observed from agy's real requests to a coordination server on 2026-11-23
(the A8c probe; docs/research/spike-results-2026-11-23-a8c-part2-agy.md). The order, and the bodies
below, are what agy sent, with its client name `antigravity-client` and protocol version
`2025-11-25`:

1. `server/discover` with no session, carrying the client capabilities under `_meta`;
2. `initialize` (id 2), after the discover answered with stateful versions only;
3. with the `Mcp-Session-Id` of the initialize reply: `notifications/initialized`, then
   `notifications/roots/list_changed`, and the same `roots/list_changed` again about 7 seconds later.

Same environment as `test_mcp_transport.py`: the real app over a real Postgres (Docker), in process.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.hooks
from mcp_helpers import make_env

from coordination.mcp.server import SUPPORTED_VERSIONS

CLIENT_CAPS = {"elicitation": {"form": {}, "url": {}}, "roots": {"listChanged": True}}
DISCOVER = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "server/discover",
    "params": {"_meta": {"io.modelcontextprotocol/clientCapabilities": CLIENT_CAPS}},
}
INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 2,
    "method": "initialize",
    "params": {
        "clientInfo": {"name": "antigravity-client", "version": "v1.0.0"},
        "protocolVersion": "2025-11-25",
        "capabilities": CLIENT_CAPS,
    },
}
INITIALIZED = {"jsonrpc": "2.0", "method": "notifications/initialized"}
ROOTS_CHANGED = {"jsonrpc": "2.0", "method": "notifications/roots/list_changed", "params": {}}


@pytest.fixture
def env(pg_db):
    return make_env(pg_db)


def test_agy_opening_sequence(env):
    token = env.keys.agy
    c = env.client()

    # 1. discover: stateful versions only, so the client falls back to initialize; no session needed.
    discover = c.raw(token, DISCOVER, session=None)
    assert discover.status_code == 200
    body = discover.json()
    assert body["id"] == 1
    assert body["result"]["supportedVersions"] == list(SUPPORTED_VERSIONS)
    assert "2026-07-28" not in str(body)

    # 2. initialize with the version agy sends: it succeeds and issues a session id.
    init = c.raw(token, INITIALIZE, session=None)
    assert init.status_code == 200
    reply = init.json()
    assert reply["id"] == 2
    assert reply["result"]["protocolVersion"] == "2025-11-25"
    sid = init.headers["mcp-session-id"]
    assert len(sid) == 32 and int(sid, 16) >= 0
    c.session_id = sid

    # 3. the notifications, with the session id: all accepted with 202 (roots/list_changed twice).
    assert c.raw(token, INITIALIZED).status_code == 202
    assert c.raw(token, ROOTS_CHANGED).status_code == 202
    assert c.raw(token, ROOTS_CHANGED).status_code == 202

    # The session is still good afterwards: tools/list answers and lists a2a_hello.
    names = [t["name"] for t in c.tools(token)]
    assert "a2a_hello" in names


def test_roots_list_changed_without_a_session_id_is_refused_like_any_other_notification(env):
    token = env.keys.agy
    c = env.client()
    c.initialize(token)
    # The transport tests assert 400 (Mcp-Session-Id header required) for a call with no header.
    refused = c.raw(token, ROOTS_CHANGED, session=None)
    assert refused.status_code == 400
    # An unknown session id is 404, so the client re-initialises.
    assert c.raw(token, ROOTS_CHANGED, session="0" * 32).status_code == 404
    # And the real session was not disturbed by either.
    assert c.raw(token, ROOTS_CHANGED).status_code == 202
