from starlette.testclient import TestClient

from coordination import healthcheck
from coordination.app import create_app
from coordination.config import Config


def test_healthz_ok():
    client = TestClient(create_app(Config()))
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.text == '{"ok":true}'


def test_healthz_needs_no_auth_or_host_check():
    client = TestClient(create_app(Config()), base_url="http://anything.invalid")
    assert client.get("/healthz").status_code == 200


def test_no_other_route_exists_yet():
    client = TestClient(create_app(Config()))
    assert client.get("/mcp").status_code == 404


def test_healthcheck_fails_when_nothing_listens(monkeypatch):
    monkeypatch.setenv("A2A_LISTEN", "127.0.0.1:1")
    assert healthcheck.check(timeout=0.5) is False
