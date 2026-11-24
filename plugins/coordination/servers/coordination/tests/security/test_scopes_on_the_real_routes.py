"""Invariant (api 9, D11; plan S1-SEC "scopes"): every endpoint requires an API key, loopback included.
Wrong scope is `403`. A `remote-peer` key can never reach `/mcp`, `/wake/*`, `/sessions` or `/status`.
A `status-client` key reaches only `POST /status`.

`test_auth_middleware.py` proves the scope matrix with a catch-all handler behind the real middleware.
This file adds the other half: the matrix against the routes the real app (`build_server_app`) really
serves, so a router mounted without a matrix entry, or an entry that does not match a route, shows up.

1. Structural: every route of the real app is classified by the scope map (no route outside it), and
   the only routes a `remote-peer` key may use are under `/a2a/v1` and the Agent Card paths.
2. Live: on a real Postgres, every method of every concrete route is requested with no key, with a
   `remote-peer` key and with a `status-client` key, from the loopback peer. No side effect follows a
   refusal: no listener parked, no session row, no audit row.
"""

from __future__ import annotations

import re

import pytest
import sqlalchemy as sa
from auth_helpers import bearer
from wake_helpers import make_wake_env, run_wake

from coordination.app import build_server_app
from coordination.auth import LOCAL_HARNESS, REMOTE_PEER, STATUS_CLIENT
from coordination.auth.scopes import Access, classify
from coordination.store.tables import audit, sessions

LOCAL_ONLY = ["/mcp", "/wake/listen", "/wake/pending", "/sessions", "/sessions/end"]
CARD_PATH = re.compile(r"^(/\.well-known/agent-card\.json|/agents/[^/]+/\.well-known/agent-card\.json)$")


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "x", path)


def _routes(app) -> list[tuple[str, frozenset[str]]]:
    out = []
    for route in app.routes:
        path = getattr(route, "path", None)
        assert path, f"a route without a path: {route!r}"
        out.append((path, frozenset(getattr(route, "methods", None) or {"GET", "POST", "DELETE", "PUT"})))
    return out


@pytest.fixture
def real_app(pg_db):
    return build_server_app(pg_db(allow_writes=True, status_enabled=True))


def test_every_route_of_the_real_app_is_in_the_scope_map(real_app):
    routes = _routes(real_app)
    paths = {p for p, _ in routes}
    assert set(LOCAL_ONLY) | {"/healthz", "/status", "/.well-known/agent-card.json", "/a2a/v1"} <= paths
    unclassified = [p for p in paths if classify(_concrete(p), status_enabled=True) is None]
    assert unclassified == [], f"routes the scope map does not know (default deny would 404 them): {unclassified}"


def test_a_remote_peer_key_can_only_be_valid_on_a2a_and_the_cards(real_app):
    for path, _ in _routes(real_app):
        rule = classify(_concrete(path), status_enabled=True)
        assert rule is not None
        if rule.access is Access.SCOPED and REMOTE_PEER in rule.scopes:
            assert path.startswith("/a2a/v1"), path
        if rule.access is Access.ANY_KEY or rule.access is Access.PUBLIC:
            assert CARD_PATH.match(_concrete(path)) or CARD_PATH.match(path), path
    for path in LOCAL_ONLY:
        assert classify(path).scopes == {LOCAL_HARNESS}


def test_a_status_client_key_is_valid_on_status_and_the_cards_only(real_app):
    allowed = []
    for path, _ in _routes(real_app):
        rule = classify(_concrete(path), status_enabled=True)
        if rule.access is Access.SCOPED and STATUS_CLIENT in rule.scopes:
            allowed.append(path)
    assert allowed == ["/status"]
    assert [m for p, m in _routes(real_app) if p == "/status"] == [frozenset({"POST"})]


async def _count(engine) -> tuple[int, int]:
    async with engine.connect() as conn:
        return (
            (await conn.execute(sa.select(sa.func.count()).select_from(sessions))).scalar_one(),
            (await conn.execute(sa.select(sa.func.count()).select_from(audit))).scalar_one(),
        )


def test_live_every_method_of_every_route_by_key_kind(pg_db):
    wk = make_wake_env(pg_db, status_enabled=True)

    async def scenario(wk):
        routes = [(_concrete(p), m) for p, m in _routes(wk.app)]
        before = await _count(wk.env.engine)
        refused = 0
        async with wk.client() as http:
            for path, methods in routes:
                for method in sorted(methods - {"HEAD", "OPTIONS"}):
                    plain = path == "/healthz" or path == "/.well-known/agent-card.json"
                    r = await http.request(method, path)  # loopback, no key
                    if plain:
                        assert r.status_code != 401, (method, path)
                    else:
                        assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer", (method, path, r.status_code)
                    if path in LOCAL_ONLY or path == "/status":
                        r = await http.request(method, path, headers=bearer(wk.keys.peer))
                        assert r.status_code == 403 and r.json()["detail"] == "Access denied.", (method, path, r.status_code)
                        refused += 1
                        if path != "/status":
                            r = await http.request(method, path, headers=bearer(wk.keys.status))
                            assert r.status_code == 403, ("status-client", method, path, r.status_code)
                            refused += 1
                    elif path.startswith("/a2a/v1") or CARD_PATH.match(path):
                        r = await http.request(method, path, headers=bearer(wk.keys.status))
                        if path.startswith("/a2a/v1"):
                            assert r.status_code == 403, ("status-client on a2a", method, path, r.status_code)
                            refused += 1
            # status-client on /status itself: POST is the one verb that gets past the scope check
            ok = await http.post("/status", headers=bearer(wk.keys.status))
            assert ok.status_code == 200 and set(ok.json()) == {"dump_age_h"}
            for method in ("GET", "PUT", "DELETE"):
                r = await http.request(method, "/status", headers=bearer(wk.keys.status))
                assert r.status_code in (403, 405), (method, r.status_code)  # never served
            assert wk.table.count() == 0  # no refused request parked a listener
        assert (await _count(wk.env.engine))[0] == before[0]  # no refusal registered a session
        return refused

    refused = run_wake(wk, scenario)
    assert refused >= 20, "too few refusals were exercised: the route walk did not run"


def test_a_refused_remote_peer_key_leaves_no_trace_in_the_database(pg_db):
    wk = make_wake_env(pg_db)

    async def scenario(wk):
        before = await _count(wk.env.engine)
        async with wk.client() as http:
            for path in LOCAL_ONLY:
                for method in ("GET", "POST", "DELETE"):
                    r = await http.request(method, path, headers={**bearer(wk.keys.peer), "X-Coord-Session": "00000000-0000-4000-8000-000000000000"}, json={"session_id": "00000000-0000-4000-8000-000000000000"})
                    assert r.status_code == 403, (method, path, r.status_code)
            assert wk.table.count() == 0
        return before, await _count(wk.env.engine)

    before, after = run_wake(wk, scenario)
    assert after == before

