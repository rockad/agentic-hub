"""The A2A TCK (`a2aproject/a2a-tck`) run against the real server, gated by a reviewed allowlist.

What runs: a real uvicorn server serving `build_server_app` (real access-control middleware, real
service layer, a real Postgres), behind `TckFront`, and the TCK as a subprocess on its own Python
(it needs 3.15). A failure of a TCK test that is not in `tck/allowlist.yaml` fails this test. An
allowlist entry that did not fail fails it too, so the list cannot hide a deviation that was fixed.

Why a front: the TCK takes one `--sut-host`, reads `{host}/.well-known/agent-card.json` and has no
option that sends an API key, and the root card here is the public front desk, which takes no
tasks (decisions D31, D32, Z13). `TckFront` is the smallest adaptation on the SUT side, and it is
test code only: it adds the bearer key of a local-harness card, adds the tenant the member card
names and serves that member card at the root path. Nothing in `src/` changes for the TCK. What it
hides is that a real client reads the member card from its own path, with a key, and sends the
tenant itself.

Skipped unless `A2A_TCK_DIR` names a checkout of the TCK at `TCK_COMMIT` (the CI job sets it).
`A2A_TCK_REQUIRE=1` turns the skip into a failure.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
import uvicorn
from a2a_helpers import CARDS_YAML
from conftest import free_port, run
from mcp_helpers import CARD_AGY, make_env
from tck_support import TCK_COMMIT, gate, load_allowlist, parse_junit

from coordination.app import build_server_app

TCK_TIMEOUT_S = 1200
# The TCK sends blocking requests to tasks that stay parked, so each one waits out the cap. The
# production cap is 60 s (decision 22); this run uses 2 s so it takes minutes, not an hour. The
# 60 s cap itself is covered by test_a2a_jsonrpc.py.
TCK_BLOCK_MAX_S = 2


def _tck_dir() -> Path:
    value = os.environ.get("A2A_TCK_DIR")
    if not value:
        if os.environ.get("A2A_TCK_REQUIRE") == "1":
            pytest.fail("A2A_TCK_REQUIRE=1 but A2A_TCK_DIR is not set", pytrace=False)
        pytest.skip("A2A_TCK_DIR is not set (a checkout of a2aproject/a2a-tck)")
    path = Path(value)
    if not (path / "run_tck.py").is_file():
        pytest.fail(f"A2A_TCK_DIR={value} has no run_tck.py", pytrace=False)
    return path


REST_PREFIX = "/a2a/v1"
REST_PATHS = ("/message:send", "/message:stream", "/tasks", "/extendedAgentCard")


class TckFront:
    """ASGI wrapper, test code only. It does for the TCK what a client that follows the card does:

    - serves the member card of `card` at the root card path (the TCK reads only that path);
    - adds the bearer key the card declares to every request (the TCK has no option for one);
    - adds the tenant the card's interface names (the TCK sends none): `params.tenant` on JSON-RPC
      when absent, a `/<tenant>` path segment on REST when absent.
    """

    def __init__(self, app, token: str, card: str) -> None:
        self.app, self._auth, self._card = app, f"Bearer {token}".encode(), card

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        scope = dict(scope)
        path = scope["path"]
        if path == "/.well-known/agent-card.json":
            path = f"/agents/{self._card}/.well-known/agent-card.json"
        elif path.startswith(REST_PREFIX + "/") and path[len(REST_PREFIX):].startswith(REST_PATHS):
            path = f"{REST_PREFIX}/{self._card}{path[len(REST_PREFIX):]}"
        scope["path"], scope["raw_path"] = path, path.encode()
        scope["headers"] = [(k, v) for k, v in scope["headers"] if k != b"authorization"] + [
            (b"authorization", self._auth)
        ]
        if path == REST_PREFIX and scope["method"] == "POST":
            receive, scope = await self._with_tenant(scope, receive)
        await self.app(scope, receive, send)

    async def _with_tenant(self, scope, receive):
        body = b""
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body"):
                break
        try:
            doc = json.loads(body)
            if isinstance(doc, dict) and isinstance(doc.get("params"), dict) and "tenant" not in doc["params"]:
                doc["params"]["tenant"] = self._card
                body = json.dumps(doc).encode()
        except ValueError:
            pass  # not JSON: pass it on as it is, the server answers it
        scope["headers"] = [(k, v) for k, v in scope["headers"] if k != b"content-length"] + [
            (b"content-length", str(len(body)).encode())
        ]
        sent = False

        async def replay():
            nonlocal sent
            if sent:
                return await receive()  # what is left is the server's own disconnect signal
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        return replay, scope


@pytest.fixture
def tck_sut(pg_db, tmp_path) -> Iterator[str]:
    port = free_port()
    cards_file = tmp_path / "cards.yaml"
    cards_file.write_text(CARDS_YAML)
    env = make_env(
        pg_db,
        allowed_hosts=(f"127.0.0.1:{port}",),
        listen=f"127.0.0.1:{port}",
        public_url=f"http://127.0.0.1:{port}",
        cards_file=str(cards_file),
        send_block_max_s=TCK_BLOCK_MAX_S,
    )
    app = TckFront(build_server_app(env.config), env.keys.claude, CARD_AGY)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, lifespan="on"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 20
    while not server.started:
        assert thread.is_alive() and time.monotonic() < deadline, "the server did not start"
        time.sleep(0.05)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=20)
        run(env.engine.dispose())


def test_the_tck_passes_with_only_the_reviewed_deviations(tck_sut):
    tck = _tck_dir()
    allowlist = load_allowlist()
    assert allowlist.tck_commit == TCK_COMMIT, "the allowlist was written for another TCK commit"
    if shutil.which("uv") is None:
        pytest.fail("uv is not installed", pytrace=False)
    reports = tck / "reports"
    shutil.rmtree(reports, ignore_errors=True)
    proc = subprocess.run(
        ["uv", "run", "--python", "3.15", "./run_tck.py", "--sut-host", tck_sut],
        cwd=tck, capture_output=True, text=True, timeout=TCK_TIMEOUT_S, check=False,
    )
    junit = reports / "junitreport.xml"
    assert junit.is_file(), f"the TCK wrote no report (exit {proc.returncode}):\n{proc.stdout[-2000:]}\n{proc.stderr[-2000:]}"
    outcomes = parse_junit(junit.read_text(encoding="utf-8"))
    result = gate(outcomes, allowlist)
    print(result.report())
    print(f"TCK allowlist: {len(allowlist.entries)} entries, {len(allowlist.unreviewed)} not yet reviewed by the user")
    outcomes_by_status = {s: sum(o.status == s for o in outcomes) for s in ("passed", "failed", "skipped", "xfailed")}
    print(f"TCK outcomes: {outcomes_by_status}")
    assert result.ok, result.report()
