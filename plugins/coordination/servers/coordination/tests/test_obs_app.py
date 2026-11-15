"""S1-OBS at the app level: Authorization redaction, /healthz, /status and the canary scan."""

import asyncio
import io
import json
import logging
import os
import re
import secrets
from datetime import UTC, datetime, timedelta

import pytest
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from coordination import healthcheck
from coordination.app import create_app
from coordination.audit import AuditEvent, AuditLog, InMemoryAuditStore
from coordination.config import Config
from coordination.logging import configure_logging, credential_from_scope

NOW = datetime(2026, 11, 14, 12, 0, 0, tzinfo=UTC)


class FixedClock:
    def now(self):
        return NOW

    def monotonic(self):
        return 0.0


@pytest.fixture
def canaries(tmp_path_factory):
    """A throwaway API key and body string, written 0600 outside the repository, read back."""
    d = tmp_path_factory.mktemp("canary")
    key_file = d / "key"
    key_file.write_text(f"a2ak_dev_canary1_{secrets.token_urlsafe(24)}")
    os.chmod(key_file, 0o600)
    assert (key_file.stat().st_mode & 0o777) == 0o600
    return key_file.read_text(), f"BODY-CANARY-{secrets.token_hex(8)}"


@pytest.fixture
def log_stream():
    root = logging.getLogger()
    saved_handlers, saved_level = list(root.handlers), root.level
    stream = io.StringIO()
    configure_logging("debug", stream=stream)
    yield stream
    root.handlers[:] = saved_handlers
    root.setLevel(saved_level)


def with_probe_routes(app, seen):
    async def echo(request: Request):
        await request.body()  # read, never logged: the server code logs no bodies
        seen["headers"] = dict(request.headers)
        seen["scope_headers"] = repr(request.scope["headers"])
        seen["credential"] = credential_from_scope(request.scope)
        # a careless handler that dumps every header, as a debugging aid would
        logging.getLogger("coordination.probe").info(
            "request headers %s scope %s credential %s",
            dict(request.headers),
            request.scope["headers"],
            seen["credential"],
        )
        return JSONResponse({"has_credential": seen["credential"] is not None})

    async def boom(request: Request):
        try:
            raise RuntimeError(f"handler failed; headers={dict(request.headers)}")
        except RuntimeError:
            logging.getLogger("coordination.probe").exception("probe failed")
            raise

    app.router.routes.append(Route("/probe/echo", echo, methods=["POST"]))
    app.router.routes.append(Route("/probe/boom", boom, methods=["POST"]))
    return app


# middleware ---------------------------------------------------------------------------------


def test_downstream_sees_a_placeholder_and_a_credential_object(canaries):
    key, _ = canaries
    seen = {}
    client = TestClient(with_probe_routes(create_app(Config()), seen))
    r = client.post("/probe/echo", headers={"Authorization": f"Bearer {key}"})
    assert r.status_code == 200 and r.json() == {"has_credential": True}
    assert seen["headers"]["authorization"] == "[redacted]"
    assert key not in seen["scope_headers"]
    assert key not in repr(seen["credential"]) and key not in str(seen["credential"])
    assert seen["credential"].reveal() == f"Bearer {key}"  # the auth layer can still read it
    assert seen["credential"].bearer() == key


def test_no_header_means_no_credential():
    seen = {}
    client = TestClient(with_probe_routes(create_app(Config()), seen))
    assert client.post("/probe/echo").json() == {"has_credential": False}
    assert "authorization" not in seen["headers"]


def test_a_client_cannot_plant_a_credential_through_other_headers(canaries):
    seen = {}
    client = TestClient(with_probe_routes(create_app(Config()), seen))
    client.post("/probe/echo", headers={"coordination.credential": "x", "X-Other": "keep"})
    assert seen["credential"] is None
    assert seen["headers"]["x-other"] == "keep"


def test_every_authorization_header_is_masked_and_the_first_is_kept(canaries):
    key, _ = canaries
    seen = {}
    app = with_probe_routes(create_app(Config()), seen)
    client = TestClient(app)
    r = client.post("/probe/echo", headers=[("Authorization", f"Bearer {key}"), ("authorization", "Bearer second")])
    assert r.status_code == 200
    assert key not in seen["scope_headers"] and "second" not in seen["scope_headers"]
    assert seen["credential"].reveal() == f"Bearer {key}"


def test_middleware_is_outermost(canaries):
    app = create_app(Config())
    assert app.user_middleware[0].cls.__name__ == "AuthorizationRedactionMiddleware"


# /healthz ------------------------------------------------------------------------------------


def test_healthz_is_exactly_ok_true_whatever_is_sent(canaries):
    key, body = canaries
    client = TestClient(create_app(Config()))
    for r in (
        client.get("/healthz"),
        client.get("/healthz", headers={"Authorization": f"Bearer {key}", "X-Probe": body}),
    ):
        assert r.status_code == 200
        assert r.content == b'{"ok":true}'
        assert key not in r.text and body not in r.text
        assert key not in str(r.headers) and body not in str(r.headers)


def test_healthz_accepts_get_only():
    client = TestClient(create_app(Config()))
    assert client.post("/healthz").status_code == 405


def test_healthcheck_prints_nothing_and_fails_on_bad_config(capsys, monkeypatch):
    monkeypatch.setenv("A2A_LISTEN", "127.0.0.1:1")
    assert healthcheck.check(timeout=0.5) is False
    monkeypatch.setenv("A2A_LOG_LEVEL", "nonsense")
    assert healthcheck.check(timeout=0.5) is False
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err == ""


# /status and dump_age_h ---------------------------------------------------------------------


def status_client(tmp_path, last_ok_text, authorizer="allow", enabled=True):
    last_ok = tmp_path / "last_ok"
    if last_ok_text is not None:
        last_ok.write_text(last_ok_text)

    async def allow(request):
        return True

    async def deny(request):
        return False

    config = Config(status_enabled=enabled, dump_last_ok_file=str(last_ok))
    app = create_app(
        config,
        clock=FixedClock(),
        status_authorizer={"allow": allow, "deny": deny, None: None}[authorizer],
    )
    return TestClient(app)


def test_status_is_absent_when_disabled(tmp_path):
    client = status_client(tmp_path, None, enabled=False)
    assert client.post("/status").status_code == 404


def test_status_fails_closed_without_an_authorizer(tmp_path):
    client = status_client(tmp_path, "2026-11-14T10:00:00Z\n", authorizer=None)
    r = client.post("/status")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.headers["www-authenticate"] == "Bearer"
    assert "dump_age_h" not in r.text
    assert set(r.json()) == {"type", "title", "status", "detail"}


def test_status_refuses_when_the_authorizer_says_no(tmp_path):
    r = status_client(tmp_path, "2026-11-14T10:00:00Z\n", authorizer="deny").post("/status")
    assert r.status_code == 401 and "dump_age_h" not in r.text


def test_dump_age_h_is_null_before_the_first_dump(tmp_path):
    r = status_client(tmp_path, None).post("/status")
    assert r.status_code == 200
    assert r.json() == {"dump_age_h": None}
    assert r.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("text", ["", "garbage\n", "2026-11-14T10:00:00\n"])
def test_dump_age_h_is_null_for_an_unusable_last_ok(tmp_path, text):
    assert status_client(tmp_path, text).post("/status").json() == {"dump_age_h": None}


def test_dump_age_h_is_a_number_of_hours(tmp_path):
    r = status_client(tmp_path, "2026-11-14T10:00:00Z\n").post("/status")
    assert r.json() == {"dump_age_h": 2.0}
    assert isinstance(r.json()["dump_age_h"], float)


def test_stale_dump_is_flagged_by_the_number_and_the_log(tmp_path, log_stream):
    fresh = status_client(tmp_path, (NOW - timedelta(hours=36)).isoformat()).post("/status")
    assert fresh.json() == {"dump_age_h": 36.0}
    assert "stale" not in log_stream.getvalue()  # exactly 36 h is not stale
    stale = status_client(tmp_path, (NOW - timedelta(hours=40)).isoformat()).post("/status")
    assert stale.json() == {"dump_age_h": 40.0}  # one field, no extra flag (spec 3.6)
    rows = [json.loads(line) for line in log_stream.getvalue().splitlines() if "stale" in line]
    assert len(rows) == 1 and rows[0]["level"] == "warning"
    assert rows[0]["fields"] == {"dump_age_h": 40.0, "stale_after_h": 36.0}


def test_null_dump_age_does_not_warn(tmp_path, log_stream):
    status_client(tmp_path, None).post("/status")
    assert "stale" not in log_stream.getvalue()


def test_status_takes_post_only(tmp_path):
    assert status_client(tmp_path, None).get("/status").status_code == 405


# the canary scan ----------------------------------------------------------------------------


def scan(haystack: str, needles):
    return [n for n in needles if n in haystack]


def test_scanner_has_a_positive_control(canaries):
    key, body = canaries
    assert scan(f"x {key} y", [key, body]) == [key]  # the scanner does find a leak


def test_canary_yields_zero_hits_in_logs_audit_rows_and_healthcheck(canaries, log_stream, capsys):
    key, body = canaries
    seen = {}
    store = InMemoryAuditStore()
    audit = AuditLog(store, FixedClock())
    app = with_probe_routes(create_app(Config(status_enabled=True), clock=FixedClock(), audit=audit), seen)
    client = TestClient(app, raise_server_exceptions=False)
    auth = {"Authorization": f"Bearer {key}"}

    responses = [
        client.post("/probe/echo", headers=auth, content=body),
        client.post("/probe/boom", headers=auth, content=body),  # unhandled error: 500
        client.post("/status", headers=auth, content=body),
        client.get("/healthz", headers=auth),
        client.get("/no-such-route", headers=auth),
    ]

    async def go():
        # what the other streams will do on these paths; the canary is only in the request
        for _ in range(3):
            await audit.auth_failure()
        await audit.flush_auth_failures(force=True)
        await audit.key_created(actor="admin", key_id="canary1", scope="local-harness")
        await audit.state_transition(
            actor="canary1", task_id="t1", from_state=None, to_state="TASK_STATE_SUBMITTED"
        )

    asyncio.run(go())

    responses_text = "".join(r.text + str(r.headers) for r in responses)
    audit_text = "\n".join(f"{r.actor}|{r.subject}|{r.event}|{r.detail_json()}" for r in store.rows)
    health_out = capsys.readouterr()
    log_text = log_stream.getvalue()

    assert [r.status_code for r in responses] == [200, 500, 401, 200, 404]
    assert log_text.count("\n") >= 1  # the probe route did log (control: the log is not empty)
    assert "[redacted]" in log_text or "[REDACTED]" in log_text  # and the header was masked, not dropped
    assert store.rows and {r.event for r in store.rows} >= {AuditEvent.AUTH_FAILURE_SAMPLED}
    # The secret part is cut at the fixed prefix, not at the last "_": token_urlsafe can contain
    # "_", so splitting on it made this needle empty or one character on some runs (flaky).
    secret = key.removeprefix("a2ak_dev_canary1_")
    assert len(secret) >= 24
    needles = [key, secret, body]
    for name, text in {
        "log": log_text,
        "audit": audit_text,
        "healthcheck": health_out.out + health_out.err,
        "responses": responses_text,
    }.items():
        assert scan(text, needles) == [], name


def test_log_scan_over_the_raw_header_dump_without_the_middleware_would_leak(canaries):
    """Negative control: a plain Starlette app, no middleware, no redaction, shows the key."""
    from starlette.applications import Starlette

    key, _ = canaries
    leaked = {}

    async def echo(request: Request):
        leaked["h"] = str(dict(request.headers))
        return PlainTextResponse("ok")

    client = TestClient(Starlette(routes=[Route("/x", echo, methods=["POST"])]))
    client.post("/x", headers={"Authorization": f"Bearer {key}"})
    assert key in leaked["h"]


def test_audit_row_refuses_what_the_canary_would_be(canaries):
    key, body = canaries
    store = InMemoryAuditStore()
    audit = AuditLog(store, FixedClock())
    from coordination.audit import AuditError

    with pytest.raises(AuditError):
        asyncio.run(audit.registration(actor="k1", handle=key, card_id="c"))
    with pytest.raises(AuditError):
        asyncio.run(audit.registration(actor=f"Bearer {key}", handle="h", card_id="c"))
    assert re.search(r"a2ak_", "".join(map(str, store.rows))) is None
    assert store.rows == []
