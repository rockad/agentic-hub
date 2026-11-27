"""Invariants (api 9, D13; status-client 11): cognitive-engine boundary.

- `POST /status` accepts only the fixed fields, and `report_path` is never opened by the server.
- cognitive-engine never receives tasks, and the server never calls it.
- `audit.jsonl` stays the source of truth: the server neither reads nor writes it.

S1 state of the code: `POST /status` takes no body at all. The intake of the five fixed fields
(`run_id`, `run_scope`, `state`, `report_path`, `ts`), its schema and its tables are LT-SRV, built after S1
on the user's go; the route today answers only `{"dump_age_h": ...}` to a `status-client` key. So at S1
the invariant is the strong form of itself, and this file pins it:

1. Whatever a `status-client` key posts (the five fixed fields with a `report_path`, extra fields,
   prompts and transcripts as fields, invalid JSON, a body over the limit's neighbour), the answer is the
   same bytes, nothing is stored, no audit row is written, and the server touches no file, directory,
   socket or host that the body names. The path canaries are a real file, a directory, a traversal, a
   `file://` URL and an `http://` URL to a host that does not exist; an audit hook records every `open`,
   `os.listdir`, `os.scandir`, `socket.connect` and `socket.getaddrinfo` during the posts.
2. Static: no module under `src/coordination/` imports an outbound network client except those on the
   list below, each with its reason, and none names cognitive-engine, Jev, OpenRouter or `audit.jsonl`
   in code (docstrings and comments excepted).

LT-SRV adds the schema tests (422 for each rejected case, five fields only); the five-field acceptance
is deferred to it and listed as such in README.md.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

import pytest
from auth_helpers import add_key, bearer, client_for, make_config, probe_app

import coordination
from coordination.auth import STATUS_CLIENT, InMemoryApiKeyStore
from coordination.config import Config

SRC = Path(coordination.__file__).resolve().parent  # the imported package: what runs, wherever it was installed from


class Watch:
    """Records filesystem and network touches while `active` (audit hooks cannot be removed, so the
    one installed hook is switched on and off)."""

    def __init__(self) -> None:
        self.active = False
        self.events: list[tuple[str, str]] = []

    def __call__(self, event: str, args: tuple) -> None:
        if not self.active:
            return
        if event in ("open", "os.listdir", "os.scandir", "os.remove", "os.rename", "shutil.copyfile"):
            self.events.append((event, str(args[0])))
        elif event == "socket.getaddrinfo":
            self.events.append((event, str(args[0])))
        elif event in ("socket.connect", "socket.bind"):
            self.events.append((event, str(args[1])))


WATCH = Watch()
sys.addaudithook(WATCH)


def status_client(tmp_path, **config):
    store = InMemoryApiKeyStore()
    token = add_key(store, STATUS_CLIENT)
    app = probe_app(make_config(status_enabled=True, dump_last_ok_file=str(tmp_path / "last_ok"), **config), store)
    return client_for(app), token


def test_a_post_with_report_paths_opens_nothing_and_changes_nothing(tmp_path):
    report = tmp_path / "report.json"
    report.write_text("SECRET-REPORT-CONTENT")
    directory = tmp_path / "runs"
    directory.mkdir()
    paths = [str(report), str(directory), "../../../etc/passwd", "file:///etc/hostname", "http://report-canary.invalid/r.json", "/proc/self/environ", "~/.config/x"]
    client, token = status_client(tmp_path)
    baseline = client.post("/status", headers=bearer(token))
    assert baseline.status_code == 200 and baseline.json() == {"dump_age_h": None}
    WATCH.events.clear()
    WATCH.active = True
    try:
        answers = []
        for path in paths:
            five = {"run_id": "r1", "run_scope": "full", "state": "COMPLETED", "report_path": path, "ts": "2026-11-24T10:00:00Z"}
            for body in (five, {**five, "prompt": "model text", "transcript": "t", "denied_requests": 3}, {"report_path": path}):
                answers.append(client.post("/status", headers=bearer(token), json=body))
        answers.append(client.post("/status", headers=bearer(token), content=b"{not json"))
        answers.append(client.post("/status", headers=bearer(token), content=b"x" * 60000))
    finally:
        WATCH.active = False
    assert len(answers) == len(paths) * 3 + 2
    assert any(p == str(tmp_path / "last_ok") for e, p in WATCH.events if e == "open"), "the hook saw no open at all: it is not live in the request path"
    assert {(a.status_code, a.content) for a in answers} == {(baseline.status_code, baseline.content)}  # one answer for all of it
    mine = [(e, p) for e, p in WATCH.events if "report-canary" in p or str(tmp_path / "report.json") in p or p in paths or str(directory) in p]
    assert mine == [], mine  # the body named these; the server touched none of them
    assert not [e for e in WATCH.events if e[0] in ("socket.connect", "socket.getaddrinfo") and "canary" in e[1]]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["report.json", "runs"]  # nothing was written


def test_the_watch_would_see_an_open_and_a_lookup(tmp_path):
    """Positive control: the hook records what it is meant to record."""
    target = tmp_path / "x.txt"
    target.write_text("x")
    WATCH.events.clear()
    WATCH.active = True
    try:
        target.read_text()
        import socket

        with pytest.raises(OSError):
            socket.getaddrinfo("report-canary.invalid", 80)
    finally:
        WATCH.active = False
    assert ("open", str(target)) in WATCH.events
    assert any(e == "socket.getaddrinfo" and "report-canary" in p for e, p in WATCH.events)


def test_status_stores_nothing_and_the_audit_stays_empty(tmp_path):
    from coordination.audit import AuditLog, InMemoryAuditStore

    class Clock:
        def now(self):
            from auth_helpers import NOW

            return NOW

        def monotonic(self):
            return 0.0

    store = InMemoryApiKeyStore()
    token = add_key(store, STATUS_CLIENT)
    audit_store = InMemoryAuditStore()
    from coordination.app import create_app

    app = create_app(make_config(status_enabled=True, dump_last_ok_file=str(tmp_path / "x")), key_store=store, clock=Clock(), audit=AuditLog(audit_store, Clock()))
    client = client_for(app)
    for _ in range(3):
        assert client.post("/status", headers=bearer(token), json={"run_id": "r", "report_path": "/x"}).status_code == 200
    assert audit_store.rows == []  # a status post is not an audit event and writes none


# -- static: nothing goes out, nothing names the engine ---------------------------------------------------

#: module -> why it may import an outbound network client. Anything else may not.
NETWORK_IMPORTS = {
    "a2a/push.py": "push notification delivery (A2A_PUSH_ENABLED, off by default): the one outbound HTTP path, SSRF-screened (spec 3.3.4)",
    "a2a/__init__.py": "httpx appears in a type annotation of the push transport argument",
    "healthcheck.py": "the container health check calls the server's own /healthz on loopback",
    "cli/client.py": "the CLI client speaks to the admin Unix socket (AF_UNIX), never to a network",
    "admin/server.py": "the admin Unix socket server (AF_UNIX)",
}
NETWORK_MODULES = {"httpx", "aiohttp", "requests", "urllib3", "websockets", "websocket", "http.client", "urllib.request", "socket", "ssl", "smtplib", "ftplib", "telnetlib"}
FORBIDDEN_WORDS = re.compile(r"cognitive[-_ ]?engine|openrouter|\bjev\b|jev_|audit\.jsonl|stage1", re.I)


def _modules():
    for path in sorted(SRC.rglob("*.py")):
        yield path.relative_to(SRC).as_posix(), ast.parse(path.read_text())


def _imports(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            yield node.module
            for alias in node.names:
                yield f"{node.module}.{alias.name}"


def test_only_the_listed_modules_import_a_network_client():
    found = {}
    for name, tree in _modules():
        hits = sorted({i for i in _imports(tree) if i in NETWORK_MODULES or i.split(".")[0] in {"httpx", "aiohttp", "requests", "urllib3", "websockets"}})
        if hits:
            found[name] = hits
    assert set(found) == set(NETWORK_IMPORTS), {k: v for k, v in found.items() if k not in NETWORK_IMPORTS} or set(NETWORK_IMPORTS) - set(found)


def test_push_is_off_by_default_and_nothing_else_makes_a_request():
    assert Config.from_env({}).push_enabled is False


def test_no_code_names_cognitive_engine_jev_openrouter_or_the_audit_jsonl():
    hits = []
    for name, tree in _modules():
        docs = {id(n.value) for n in ast.walk(tree) if isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant)}
        for node in ast.walk(tree):
            text = None
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs:
                text = node.value
            elif isinstance(node, ast.Name):
                text = node.id
            elif isinstance(node, ast.Attribute):
                text = node.attr
            if text and FORBIDDEN_WORDS.search(text):
                hits.append((name, getattr(node, "lineno", 0), text[:60]))
    assert hits == []


@pytest.mark.parametrize(
    "snippet",
    ["import httpx\n", "from urllib.request import urlopen\n", "import socket\n", "import aiohttp as a\n"],
)
def test_the_import_scan_sees_a_network_client(snippet):
    assert {i for i in _imports(ast.parse(snippet))} & (NETWORK_MODULES | {"aiohttp", "httpx"})
