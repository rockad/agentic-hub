"""S1-AUTH: the access-control middleware, the scope matrix and the check order (spec 2.1, 8.1)."""

import asyncio
import json
import logging
from datetime import timedelta

import pytest
from auth_helpers import HOST, NOW, FixedClock, add_key, bearer, client_for, make_config, make_record, probe_app
from starlette.testclient import TestClient

from coordination.app import build_server_app, create_app
from coordination.audit import AuditEvent, AuditLog, InMemoryAuditStore
from coordination.auth import (
    LOCAL_HARNESS,
    REMOTE_PEER,
    SCOPES,
    STATUS_CLIENT,
    Access,
    InMemoryApiKeyStore,
    TailnetIdentity,
    classify,
)
from coordination.config import Config

# The endpoint map of spec 2 with the scopes it allows, as a table written out here and not read
# from the code under test.
ALLOWED = {
    "/a2a/v1": {LOCAL_HARNESS, REMOTE_PEER},
    "/a2a/v1/message:send": {LOCAL_HARNESS, REMOTE_PEER},
    "/mcp": {LOCAL_HARNESS},
    "/wake/listen": {LOCAL_HARNESS},
    "/wake/pending": {LOCAL_HARNESS},
    "/sessions": {LOCAL_HARNESS},
    "/sessions/end": {LOCAL_HARNESS},
    "/status": {STATUS_CLIENT},
    "/agents/claude-code@box/.well-known/agent-card.json": set(SCOPES),  # any valid key
}
STATES = ("valid", "expired", "revoked", "wrong-env", "missing")


def stack(**config_overrides):
    store = InMemoryApiKeyStore()
    config = make_config(status_enabled=True, **config_overrides)
    return store, config, client_for(probe_app(config, store))


def headers_for(store, scope, state):
    if state == "missing":
        return {}
    kwargs = {"valid": {}, "expired": {"expires_in": timedelta(seconds=-5)}, "revoked": {"revoked": True}, "wrong-env": {"env": "live"}}[state]
    return bearer(add_key(store, scope, **kwargs))


# the matrix ----------------------------------------------------------------------------------


@pytest.mark.parametrize("path", sorted(ALLOWED))
@pytest.mark.parametrize("scope", SCOPES)
@pytest.mark.parametrize("state", STATES)
def test_matrix_endpoint_by_scope_by_key_state(path, scope, state):
    store, _, client = stack()
    headers = headers_for(store, scope, state)
    r = client.post(path, headers=headers)
    if state != "valid":
        expected = 401
    else:
        expected = 200 if scope in ALLOWED[path] else 403
    assert r.status_code == expected, (path, scope, state, r.text)
    if expected == 401:
        assert r.headers["www-authenticate"] == "Bearer"
    if expected == 200 and path != "/status":
        assert r.json()["scope"] == scope


def test_matrix_covers_the_whole_endpoint_map():
    # 2 a2a paths, mcp, 2 wake, 2 sessions, status, member card. Failing here means the table above
    # drifted from the spec's endpoint map, not that the code is wrong.
    assert len(ALLOWED) == 9
    assert {p for p, s in ALLOWED.items() if s == {LOCAL_HARNESS}} == {"/mcp", "/wake/listen", "/wake/pending", "/sessions", "/sessions/end"}


@pytest.mark.parametrize("path", ["/mcp", "/wake/listen", "/wake/pending", "/sessions", "/sessions/end"])
@pytest.mark.parametrize("scope", [REMOTE_PEER, STATUS_CLIENT])
def test_remote_peer_and_status_client_get_403_on_the_local_only_endpoints(path, scope):
    store, _, client = stack()
    r = client.post(path, headers=bearer(add_key(store, scope)))
    assert r.status_code == 403


def test_public_endpoints_need_no_key():
    _, _, client = stack()
    assert client.get("/healthz").status_code == 200
    assert client.get("/.well-known/agent-card.json").status_code == 200  # root card: public (spec 3.2)


def test_the_root_card_ignores_a_bad_key_instead_of_refusing_it():
    _, _, client = stack()
    assert client.get("/.well-known/agent-card.json", headers=bearer("garbage")).status_code == 200


def test_member_cards_need_any_valid_key():
    store, _, client = stack()
    path = "/agents/claude-code@box/.well-known/agent-card.json"
    assert client.get(path).status_code == 401
    for scope in SCOPES:
        assert client.get(path, headers=bearer(add_key(store, scope))).status_code == 200


def test_loopback_without_a_key_gets_401():
    _, _, client = stack()  # the test client's peer is 127.0.0.1
    for path in ("/mcp", "/a2a/v1", "/sessions", "/wake/pending", "/status"):
        assert client.post(path).status_code == 401


def test_a_key_is_checked_on_every_request_so_revocation_is_immediate():
    store, _, client = stack()
    token = add_key(store, LOCAL_HARNESS)
    assert client.post("/mcp", headers=bearer(token)).status_code == 200
    key_id = token.split("_")[2]
    assert asyncio.run(store.revoke(key_id, NOW)) is True
    assert client.post("/mcp", headers=bearer(token)).status_code == 401


def test_expiry_takes_effect_with_the_clock():
    clock = FixedClock()
    store = InMemoryApiKeyStore()
    token = add_key(store, LOCAL_HARNESS, expires_in=timedelta(minutes=5))
    client = client_for(probe_app(make_config(), store, clock=clock))
    assert client.post("/mcp", headers=bearer(token)).status_code == 200
    clock.advance(minutes=5)
    assert client.post("/mcp", headers=bearer(token)).status_code == 401


# default deny --------------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/", "/admin", "/admin/keys", "/mcpx", "/sessionsx", "/wakeup", "/a2a", "/a2a/v2", "//mcp", "/probe/x"])
def test_a_path_outside_the_endpoint_map_is_404_with_no_body(path):
    store, _, client = stack()
    token = add_key(store, LOCAL_HARNESS)
    for headers in ({}, bearer(token)):
        r = client.post(path, headers=headers)
        assert r.status_code == 404 and r.content == b"", path


def test_there_is_no_admin_route_and_no_admin_scope():
    assert "admin" not in " ".join(SCOPES)
    assert classify("/admin") is None
    store, _, client = stack()
    for scope in SCOPES:
        assert client.post("/admin", headers=bearer(add_key(store, scope))).status_code == 404


def test_status_is_unknown_while_disabled():
    store = InMemoryApiKeyStore()
    client = client_for(probe_app(make_config(status_enabled=False), store))
    assert client.post("/status", headers=bearer(add_key(store, STATUS_CLIENT))).status_code == 404
    assert classify("/status", status_enabled=False) is None


def test_classify_names_the_access_class_of_each_path():
    assert classify("/healthz").access is Access.EXEMPT
    assert classify("/.well-known/agent-card.json").access is Access.PUBLIC
    assert classify("/agents/x@y/.well-known/agent-card.json").access is Access.ANY_KEY
    assert classify("/agents/x@y/z/.well-known/agent-card.json") is None
    assert classify("/mcp").scopes == {LOCAL_HARNESS}


# order of the checks -------------------------------------------------------------------------


def test_host_is_checked_first_and_is_421():
    store, _, _ = stack()
    app = probe_app(make_config(), store)
    c = client_for(app, host="evil.example")
    token = add_key(store, LOCAL_HARNESS)
    for headers in ({}, bearer(token)):  # even a valid key: the host check comes before the key
        r = c.post("/mcp", headers=headers)
        assert r.status_code == 421 and r.headers["content-type"].startswith("application/problem+json")
    assert c.get("/.well-known/agent-card.json").status_code == 421  # Host applies to the root card
    assert c.get("/healthz").status_code == 200  # but not to /healthz (spec 3.7)


def test_two_host_headers_are_refused():
    store, _, client = stack()
    r = client.post("/mcp", headers=[("Host", HOST), ("Host", HOST)])
    assert r.status_code == 421


def test_the_host_match_is_exact_including_the_port_and_ignores_case():
    store, _, _ = stack()
    app = probe_app(make_config(), store)
    assert client_for(app, host="LOCALHOST:8120").post("/mcp").status_code == 401  # passes Host, fails the key
    assert client_for(app, host="localhost:9999").post("/mcp").status_code == 421
    assert client_for(app, host="127.0.0.1").post("/mcp").status_code == 421


def test_origin_is_refused_unless_listed_and_cors_is_off():
    store = InMemoryApiKeyStore()
    token = add_key(store, LOCAL_HARNESS)
    client = client_for(probe_app(make_config(allowed_origins=("https://ok.example",)), store))
    r = client.post("/mcp", headers={**bearer(token), "Origin": "https://evil.example"})
    assert r.status_code == 403 and r.headers["content-type"].startswith("application/problem+json")
    ok = client.post("/mcp", headers={**bearer(token), "Origin": "https://ok.example"})
    assert ok.status_code == 200
    assert not [h for h in ok.headers if h.lower().startswith("access-control-")]
    assert not [h for h in r.headers if h.lower().startswith("access-control-")]


def test_with_no_origins_configured_any_origin_header_is_refused():
    store, _, client = stack()
    token = add_key(store, LOCAL_HARNESS)
    assert client.post("/mcp", headers={**bearer(token), "Origin": "http://127.0.0.1:8120"}).status_code == 403
    assert client.post("/mcp", headers=bearer(token)).status_code == 200


def test_origin_is_checked_before_the_key_and_a_preflight_gets_no_cors_headers():
    store, _, client = stack()
    r = client.options("/mcp", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert r.status_code == 403
    assert not [h for h in r.headers if h.lower().startswith("access-control-")]


def test_size_is_checked_before_everything_else():
    store = InMemoryApiKeyStore()
    client = client_for(probe_app(make_config(max_body_bytes=100), store), host="evil.example")
    r = client.post("/mcp", content=b"x" * 101)
    assert r.status_code == 413  # not 421, not 401
    assert client.post("/mcp", content=b"x" * 100).status_code == 421


def test_a_body_over_the_limit_is_413_even_without_a_content_length():
    store = InMemoryApiKeyStore()
    token = add_key(store, LOCAL_HARNESS)
    app = probe_app(make_config(max_body_bytes=100), store)

    async def read_all(request):
        await request.body()
        from starlette.responses import JSONResponse

        return JSONResponse({"read": True})

    from starlette.routing import Route

    app.router.routes.insert(0, Route("/mcp", read_all, methods=["POST"]))

    def chunks():
        for _ in range(5):
            yield b"x" * 40

    r = client_for(app).post("/mcp", headers=bearer(token), content=chunks())
    assert r.status_code == 413 and r.headers["content-type"].startswith("application/problem+json")
    assert client_for(app).post("/mcp", headers=bearer(token), content=b"x" * 100).status_code == 200


def test_oversized_headers_are_413():
    store, _, client = stack()
    r = client.post("/mcp", headers={"X-Padding": "a" * 20000})
    assert r.status_code == 413


def test_a_key_is_checked_before_the_scope():
    store, _, client = stack()
    # unknown key on a local-only path: 401, not 403
    assert client.post("/mcp", headers=bearer(make_record(LOCAL_HARNESS)[0])).status_code == 401
    # valid key of the wrong scope: 403
    assert client.post("/mcp", headers=bearer(add_key(store, REMOTE_PEER))).status_code == 403


class FakeLimiter:
    def __init__(self, wait):
        self.wait, self.seen = wait, []

    async def retry_after(self, principal, scope):
        self.seen.append(principal.key_id)
        return self.wait


def test_the_rate_limit_runs_after_the_scope_check_and_answers_429_with_retry_after():
    store = InMemoryApiKeyStore()
    limiter = FakeLimiter(12.2)
    client = client_for(probe_app(make_config(), store, rate_limiter=limiter))
    local = add_key(store, LOCAL_HARNESS)
    peer = add_key(store, REMOTE_PEER)
    r = client.post("/mcp", headers=bearer(local))
    assert r.status_code == 429 and r.headers["retry-after"] == "13"
    assert r.headers["content-type"].startswith("application/problem+json")
    # a wrong-scope key is refused with 403 before the limiter is asked
    limiter.seen.clear()
    assert client.post("/mcp", headers=bearer(peer)).status_code == 403
    assert limiter.seen == []
    # and so is a missing key
    assert client.post("/mcp").status_code == 401 and limiter.seen == []


def test_the_rate_limit_lets_a_request_through_when_the_limiter_says_none():
    store = InMemoryApiKeyStore()
    client = client_for(probe_app(make_config(), store, rate_limiter=FakeLimiter(None)))
    assert client.post("/mcp", headers=bearer(add_key(store, LOCAL_HARNESS))).status_code == 200


# tailnet identity (check 7), unit tested with a fake identity ----------------------------------


def identity_from_headers(scope):
    """A fake identity source that believes whatever the request says. The middleware must not
    consult it for a peer outside A2A_TRUSTED_PROXY_IPS."""
    h = {k.decode(): v.decode() for k, v in scope["headers"]}
    node, login = h.get("x-fake-node"), h.get("x-fake-login")
    return TailnetIdentity(node, login) if (node or login) else None


def tailnet_stack(**fields):
    store = InMemoryApiKeyStore()
    config = make_config(enforce_tailnet_identity=True, trusted_proxy_ips=("10.0.0.0/24",))
    app = probe_app(config, store, identity_source=identity_from_headers)
    return store, app


def test_a_matching_identity_from_a_trusted_proxy_is_accepted():
    store, app = tailnet_stack()
    token = add_key(store, LOCAL_HARNESS, card_id="claude-code@box", tailnet_node="box")
    r = client_for(app, peer="10.0.0.7").post("/mcp", headers={**bearer(token), "X-Fake-Node": "box"})
    assert r.status_code == 200


def test_a_mismatched_identity_is_403_with_no_detail():
    store, app = tailnet_stack()
    token = add_key(store, LOCAL_HARNESS, card_id="claude-code@box", tailnet_node="box")
    r = client_for(app, peer="10.0.0.7").post("/mcp", headers={**bearer(token), "X-Fake-Node": "mac"})
    assert r.status_code == 403
    assert "box" not in r.text and "mac" not in r.text


def test_a_forged_identity_header_from_a_non_proxy_peer_is_ignored():
    store, app = tailnet_stack()
    token = add_key(store, LOCAL_HARNESS, card_id="claude-code@box", tailnet_node="box")
    # the header is exactly what the key is bound to, but the peer is not a trusted proxy
    r = client_for(app, peer="192.0.2.9").post("/mcp", headers={**bearer(token), "X-Fake-Node": "box"})
    assert r.status_code == 403
    # control: the same request from a trusted proxy peer is accepted
    ok = client_for(app, peer="10.0.0.7").post("/mcp", headers={**bearer(token), "X-Fake-Node": "box"})
    assert ok.status_code == 200


def test_no_identity_at_all_is_refused():
    store, app = tailnet_stack()
    token = add_key(store, LOCAL_HARNESS, card_id="claude-code@box", tailnet_node="box")
    assert client_for(app, peer="10.0.0.7").post("/mcp", headers=bearer(token)).status_code == 403


def test_a_login_binding_and_a_node_binding_must_both_match_when_both_are_set():
    store, app = tailnet_stack()
    token = add_key(store, LOCAL_HARNESS, tailnet_node="box", tailnet_login="a@example.test")
    c = client_for(app, peer="10.0.0.7")
    assert c.post("/mcp", headers={**bearer(token), "X-Fake-Node": "box"}).status_code == 403
    both = {**bearer(token), "X-Fake-Node": "box", "X-Fake-Login": "a@example.test"}
    assert c.post("/mcp", headers=both).status_code == 200
    wrong = {**bearer(token), "X-Fake-Node": "box", "X-Fake-Login": "b@example.test"}
    assert c.post("/mcp", headers=wrong).status_code == 403


def test_a_harness_key_without_a_binding_is_refused_while_enforcement_is_on():
    store, app = tailnet_stack()
    token = add_key(store, LOCAL_HARNESS, card_id="claude-code@box")
    assert client_for(app, peer="10.0.0.7").post("/mcp", headers={**bearer(token), "X-Fake-Node": "box"}).status_code == 403


def test_the_tailnet_check_does_not_apply_to_other_scopes_or_when_off():
    store, app = tailnet_stack()
    peer = add_key(store, REMOTE_PEER, peer_id="p", cards_allowed=("claude-code@box",))
    assert client_for(app, peer="192.0.2.9").post("/a2a/v1", headers=bearer(peer)).status_code == 200
    off_store = InMemoryApiKeyStore()
    off = client_for(probe_app(make_config(enforce_tailnet_identity=False), off_store))
    assert off.post("/mcp", headers=bearer(add_key(off_store, LOCAL_HARNESS))).status_code == 200


def test_the_trusted_peer_list_takes_addresses_and_ranges_and_ignores_bad_entries():
    from coordination.auth.middleware import is_trusted_peer

    assert is_trusted_peer("10.0.0.7", ("10.0.0.7",))
    assert is_trusted_peer("10.0.0.7", ("not-an-ip", "10.0.0.0/24"))
    assert not is_trusted_peer("10.0.1.7", ("10.0.0.0/24",))
    assert not is_trusted_peer("10.0.0.7", ())
    assert not is_trusted_peer(None, ("10.0.0.7",))
    assert not is_trusted_peer("testclient", ("10.0.0.7",))


# errors and headers --------------------------------------------------------------------------


def test_every_401_is_the_same_problem_document_whatever_the_reason():
    store, _, client = stack()
    cases = {
        "missing": {},
        "garbage": bearer("garbage"),
        "wrong scheme": {"Authorization": "Basic abc"},
        "unknown": bearer(make_record(LOCAL_HARNESS)[0]),
        "expired": bearer(add_key(store, LOCAL_HARNESS, expires_in=timedelta(seconds=-1))),
        "revoked": bearer(add_key(store, LOCAL_HARNESS, revoked=True)),
        "wrong env": bearer(add_key(store, LOCAL_HARNESS, env="live")),
    }
    seen = set()
    for name, headers in cases.items():
        r = client.post("/mcp", headers=headers)
        assert r.status_code == 401, name
        assert r.headers["www-authenticate"] == "Bearer"
        assert r.headers["content-type"].startswith("application/problem+json")
        assert r.headers["cache-control"] == "no-store"
        seen.add(r.content)
    assert len(seen) == 1  # byte for byte the same body
    body = json.loads(seen.pop())
    assert set(body) == {"type", "title", "status", "detail"} and body["status"] == 401


def test_a_403_says_nothing_about_what_the_key_could_do():
    store, _, client = stack()
    r = client.post("/mcp", headers=bearer(add_key(store, REMOTE_PEER)))
    assert r.status_code == 403 and r.headers["content-type"].startswith("application/problem+json")
    body = json.loads(r.content)
    assert set(body) == {"type", "title", "status", "detail"}
    text = r.text.lower()
    for word in ("scope", "remote-peer", "local-harness", "allowed", "mcp"):
        assert word not in text
    assert "www-authenticate" not in r.headers


def test_every_response_is_no_store_except_the_agent_cards():
    store, _, client = stack()
    local = bearer(add_key(store, LOCAL_HARNESS))
    for r in (
        client.get("/healthz"),
        client.post("/mcp", headers=local),  # the handler asked for max-age=5: overruled
        client.post("/mcp"),
        client.post("/nowhere"),
        client.post("/mcp", headers=bearer(add_key(store, REMOTE_PEER))),
    ):
        assert r.headers["cache-control"] == "no-store", r.status_code
    # the card handler's own Cache-Control stands (spec 3.2: max-age=60)
    root = client.get("/.well-known/agent-card.json?cc=max-age%3D60")
    assert root.headers["cache-control"] == "max-age=60"
    member = client.get("/agents/a@b/.well-known/agent-card.json?cc=max-age%3D60", headers=local)
    assert member.headers["cache-control"] == "max-age=60"
    # but a refused request for a member card is a problem document, no-store
    assert client.get("/agents/a@b/.well-known/agent-card.json").headers["cache-control"] == "no-store"


def test_a_store_failure_fails_closed_with_a_generic_503(caplog):
    class Broken(InMemoryApiKeyStore):
        async def get(self, key_id):
            raise RuntimeError("connection to db failed password=hunter2-canary")

    store = Broken()
    token, record = make_record(LOCAL_HARNESS)
    client = client_for(probe_app(make_config(), store))
    with caplog.at_level(logging.DEBUG):
        r = client.post("/mcp", headers=bearer(token))
    assert r.status_code == 503 and "hunter2" not in r.text and token not in r.text
    assert "hunter2" not in caplog.text and token not in caplog.text  # only the exception type is logged
    assert r.headers["content-type"].startswith("application/problem+json")


def test_last_used_is_recorded_but_not_on_every_request():
    store = InMemoryApiKeyStore()
    clock = FixedClock()
    token = add_key(store, LOCAL_HARNESS)
    key_id = token.split("_")[2]
    client = client_for(probe_app(make_config(), store, clock=clock))
    client.post("/mcp", headers=bearer(token))
    assert store.records[key_id].last_used_at == NOW
    clock.advance(seconds=30)
    client.post("/mcp", headers=bearer(token))
    assert store.records[key_id].last_used_at == NOW  # inside the resolution window: no write
    clock.advance(seconds=31)
    client.post("/mcp", headers=bearer(token))
    assert store.records[key_id].last_used_at == NOW + timedelta(seconds=61)


def test_a_client_cannot_plant_a_principal_in_the_scope():
    store, _, client = stack()
    # no header can set an ASGI scope key, so the answer for a keyless request stays 401
    r = client.post("/mcp", headers={"coordination.principal": "x", "X-Principal": "local-harness"})
    assert r.status_code == 401


def test_the_handler_sees_the_principal_and_never_the_key(caplog):
    store, _, client = stack()
    token = add_key(store, REMOTE_PEER, peer_id="peer-1", cards_allowed=("claude-code@box",))
    r = client.post("/a2a/v1", headers=bearer(token))
    assert r.json()["scope"] == REMOTE_PEER and r.json()["key_id"] == token.split("_")[2]
    assert token not in r.text


def test_websockets_are_refused():
    store, _, client = stack()
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/mcp"):
            pass


# auth failures are audited as a sampled count --------------------------------------------------


def test_auth_failures_go_to_the_audit_as_one_sampled_row_not_one_per_request():
    clock = FixedClock()
    audit_store = InMemoryAuditStore()
    audit = AuditLog(audit_store, clock)
    store = InMemoryApiKeyStore()
    client = client_for(probe_app(make_config(), store, clock=clock, audit=audit))
    good = bearer(add_key(store, LOCAL_HARNESS))
    for _ in range(4):
        client.post("/mcp")  # missing key
    client.post("/mcp", headers=bearer("garbage"))
    client.post("/mcp", headers=good)  # a success is not a failure
    client.post("/mcp", headers=bearer(add_key(store, REMOTE_PEER)))  # 403 is not an auth failure
    assert audit_store.rows == []  # the window is still open: nothing written per request
    asyncio.run(audit.flush_auth_failures(force=True))
    assert [r.event for r in audit_store.rows] == [AuditEvent.AUTH_FAILURE_SAMPLED]
    assert audit_store.rows[0].detail["count"] == 5


def test_a_broken_audit_sink_does_not_change_who_gets_in():
    class Exploding:
        async def append_audit(self, row):
            raise RuntimeError("audit down")

    clock = FixedClock()
    audit = AuditLog(Exploding(), clock, auth_failure_window_s=1)
    store = InMemoryApiKeyStore()
    client = client_for(probe_app(make_config(), store, clock=clock, audit=audit))
    for _ in range(3):
        clock.advance(seconds=2)
        assert client.post("/mcp").status_code == 401
    assert client.post("/mcp", headers=bearer(add_key(store, LOCAL_HARNESS))).status_code == 200


# composition with the S1-OBS middleware and the status route -----------------------------------


def test_the_redaction_stays_outermost_and_the_access_control_follows():
    store = InMemoryApiKeyStore()
    app = create_app(Config(), key_store=store)
    assert [m.cls.__name__ for m in app.user_middleware] == ["AuthorizationRedactionMiddleware", "AccessControlMiddleware"]


def test_without_a_key_store_the_app_is_as_before():
    app = create_app(Config())
    assert [m.cls.__name__ for m in app.user_middleware] == ["AuthorizationRedactionMiddleware"]


def test_the_server_app_that_main_serves_has_the_access_control(tmp_path):
    password_file = tmp_path / "pw"
    password_file.write_text("throwaway-not-a-real-password\n")
    password_file.chmod(0o600)
    app = build_server_app(make_config(db_password_file=str(password_file)))
    assert [m.cls.__name__ for m in app.user_middleware] == ["AuthorizationRedactionMiddleware", "AccessControlMiddleware"]


def test_the_handler_never_sees_the_authorization_header_value():
    store = InMemoryApiKeyStore()
    token = add_key(store, LOCAL_HARNESS)
    seen = {}
    app = probe_app(make_config(), store)
    from starlette.requests import Request
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    async def spy(request: Request):
        seen["authorization"] = request.headers.get("authorization")
        seen["scope"] = repr(request.scope["headers"])
        return JSONResponse({})

    app.router.routes.insert(0, Route("/mcp", spy, methods=["POST"]))
    assert client_for(app).post("/mcp", headers=bearer(token)).status_code == 200
    assert seen["authorization"] == "[redacted]" and token not in seen["scope"]


def test_status_needs_a_status_client_key_through_the_real_authorizer(tmp_path):
    store = InMemoryApiKeyStore()
    config = make_config(status_enabled=True, dump_last_ok_file=str(tmp_path / "missing"))
    app = create_app(config, key_store=store, clock=FixedClock())
    client = client_for(app)
    assert client.post("/status").status_code == 401
    assert client.post("/status", headers=bearer(add_key(store, LOCAL_HARNESS))).status_code == 403
    assert client.post("/status", headers=bearer(add_key(store, REMOTE_PEER))).status_code == 403
    ok = client.post("/status", headers=bearer(add_key(store, STATUS_CLIENT)))
    assert ok.status_code == 200 and ok.json() == {"dump_age_h": None}
    assert ok.headers["cache-control"] == "no-store"


def test_the_status_route_refuses_when_it_is_reached_without_a_status_client_principal():
    """Defence in depth: the route's own authorizer, with no middleware in front, finds no principal."""
    from coordination.app import status_client_authorizer

    app = create_app(make_config(status_enabled=True), status_authorizer=status_client_authorizer)
    assert TestClient(app).post("/status").status_code == 401
