"""S1-WAKE on real sockets: a real uvicorn server (in a thread, or a real `python -m coordination`
process) serving `build_server_app` against a real Postgres, driven by real HTTP clients.

What this proves that the in-process tests (`test_wake.py`) cannot:

- the regression of the SP5 D2 load: 200 parked listeners, and the wake latency measured (p50, p99,
  max) from the moment the wake machinery is told about a task to the moment the client has the
  `200`, plus the end-to-end figure from the start of the send. The gate is p99 under 500 ms;
- a client that hangs up leaves the table and is never woken (a handle killed mid-wake);
- key revocation through the real admin socket closes a parked listener with `403`;
- SIGTERM sent to a real server process answers a parked listener `503` with `Retry-After: 5` and the
  process exits.

Needs Docker like the rest of the Postgres suite.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import signal
import statistics
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field

import httpx
import pytest
import sqlalchemy as sa
import uvicorn
from auth_helpers import bearer
from conftest import free_port, run
from mcp_helpers import CARD_AGY, CARD_CLAUDE, H_AGY, local_caller, make_env
from wake_helpers import message

from coordination.app import build_server_app, make_server
from coordination.cli import main as admin_cli
from coordination.store.tables import sessions, wakes

P99_GATE_S = 0.5


def handle_of(i: int) -> str:
    return f"{CARD_CLAUDE}/w{i:03d}~{i:08x}"


def hsid_of(i: int) -> str:
    return f"{i:08x}-0000-4000-8000-000000000000"


@dataclass
class Served:
    env: object
    app: object
    server: uvicorn.Server
    loop: asyncio.AbstractEventLoop
    port: int
    notified: dict[str, float] = field(default_factory=dict)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def on_server(self, coro, timeout: float = 120):
        """Run a coroutine on the server's own event loop (the engine and the table live there)."""
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)


@pytest.fixture
def served(pg_db, sock_dir) -> Iterator[Served]:
    port = free_port()
    env = make_env(
        pg_db,
        allowed_hosts=(f"127.0.0.1:{port}",),
        listen=f"127.0.0.1:{port}",
        admin_socket=str(sock_dir / "admin.sock"),
        wake_budget_per_h=1000,
    )
    app = build_server_app(env.config)  # the app `main` serves, on the system clock
    server = make_server(app, uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, lifespan="on"))
    holder: dict[str, asyncio.AbstractEventLoop] = {}

    def target() -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        holder["loop"] = loop
        loop.run_until_complete(server.serve())

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    deadline = time.monotonic() + 30
    while not server.started:
        assert thread.is_alive() and time.monotonic() < deadline, "the server did not start"
        time.sleep(0.05)
    s = Served(env, app, server, holder["loop"], port)
    try:
        yield s
    finally:
        server.should_exit = True
        thread.join(timeout=30)
        run(env.engine.dispose())


def insert_sessions(env, count: int, first: int = 0) -> None:
    async def go() -> None:
        async with env.engine.begin() as conn:
            await conn.execute(
                sa.insert(sessions),
                [
                    {
                        "handle": handle_of(i),
                        "card_id": CARD_CLAUDE,
                        "harness_session_id": hsid_of(i),
                        "registered_at": env.clock.now(),
                        "last_seen_at": env.clock.now(),
                    }
                    for i in range(first, first + count)
                ],
            )

    run(go())


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def instrument(served: Served) -> None:
    """Note, per handle, when the wake machinery was told about a task (the start of 'wake
    latency'); the real method still runs."""
    wake = served.app.state.wake
    original = wake.notify_pending

    async def timed(handle: str) -> None:
        served.notified[handle] = time.perf_counter()
        await original(handle)

    wake.notify_pending = timed


async def park_all(served: Served, http: httpx.AsyncClient, indexes: range, key: str) -> list[asyncio.Task]:
    tasks = [
        asyncio.ensure_future(
            http.post("/wake/listen", headers={**bearer(key), "X-Coord-Session": hsid_of(i), "X-Coord-Wait": "120"})
        )
        for i in indexes
    ]
    deadline = time.monotonic() + 60
    while served.app.state.wake.table.count() < len(indexes):
        assert time.monotonic() < deadline, f"only {served.app.state.wake.table.count()} listeners parked"
        await asyncio.sleep(0.05)
    await asyncio.sleep(1.0)  # let every first look finish: after this they are plainly parked
    return tasks


def report(label: str, wake_s: list[float], e2e_s: list[float]) -> str:
    def row(name: str, v: list[float]) -> str:
        return (
            f"{name}: n={len(v)} p50={statistics.median(v) * 1000:.1f} ms p99={percentile(v, 0.99) * 1000:.1f} ms "
            f"max={max(v) * 1000:.1f} ms"
        )

    return f"{label} | {row('wake', wake_s)} | {row('send-to-200', e2e_s)}"


def test_200_parked_listeners_wake_latency_p99_is_under_500_ms(served, capsys):
    """The regression of SP5 D2 on the real server: 200 parked listeners over real sockets, woken in
    a burst (all at once) and then one by one. Wake latency is measured from the moment the wake
    machinery is told about the task to the moment the client has its `200`; the send-to-200 figure
    includes creating the task. Both are printed (`-s`) and recorded in docs/specs/wake.md."""
    insert_sessions(served.env, 405)  # 400 listeners, then 5 more for the background agents
    instrument(served)
    sender = local_caller(CARD_AGY, H_AGY, key_id="feedfeed")
    service = served.app.state.service
    key = served.env.keys.claude
    results: dict[str, tuple[list[float], list[float]]] = {}

    async def send_to(i: int, started: dict[int, float]) -> None:
        started[i] = time.perf_counter()
        meta = {"coord": {"to": handle_of(i)}}
        await service.send_message(sender, CARD_CLAUDE, message(f"task {i}"), metadata=meta)

    async def phase(label: str, indexes: range, *, gap_s: float) -> None:
        limits = httpx.Limits(max_connections=None, max_keepalive_connections=0)
        async with httpx.AsyncClient(base_url=served.url, limits=limits, timeout=180) as http:
            listeners = await park_all(served, http, indexes, key)
            assert served.app.state.wake.table.count() == len(indexes)
            started: dict[int, float] = {}
            ended: dict[int, float] = {}
            served.notified.clear()

            async def watch(i: int, task: asyncio.Task) -> None:
                r = await task
                ended[i] = time.perf_counter()
                assert r.status_code == 200 and r.text == "1", (i, r.status_code, r.text)

            watchers = [asyncio.ensure_future(watch(i, t)) for i, t in zip(indexes, listeners, strict=True)]
            if gap_s == 0:  # the burst: every send is started at the same moment
                await asyncio.wrap_future(
                    asyncio.run_coroutine_threadsafe(
                        _gather([send_to(i, started) for i in indexes]), served.loop
                    )
                )
            else:
                for i in indexes:
                    await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(send_to(i, started), served.loop))
                    await asyncio.sleep(gap_s)
            await asyncio.wait_for(asyncio.gather(*watchers), 60)
            wake_s = [ended[i] - served.notified[handle_of(i)] for i in indexes]
            e2e_s = [ended[i] - started[i] for i in indexes]
            results[label] = (wake_s, e2e_s)

    background_ops = [0]

    async def background(stop: asyncio.Event) -> None:
        """The other traffic of SP5 D2: five agents sending, reading and answering tasks while the
        200 listeners stay parked."""

        async def agent(n: int) -> None:
            handle = handle_of(400 + n)
            owner = local_caller(CARD_CLAUDE, handle, key_id=served.env.keys.ids["claude"])
            while not stop.is_set():
                meta = {"coord": {"to": handle}}
                task = await service.send_message(sender, CARD_CLAUDE, message("background"), metadata=meta)
                await service.inbox(owner)
                await service.respond(owner, task.id, "working")
                await service.respond(owner, task.id, "completed", text="done")
                background_ops[0] += 4
                await asyncio.sleep(0.05)

        await asyncio.gather(*(agent(n) for n in range(5)))

    async def scenario() -> None:
        await phase("burst of 200 at once (stress, not gated at 500 ms)", range(200), gap_s=0)
        stop = await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(_event(), served.loop))
        load = asyncio.run_coroutine_threadsafe(background(stop), served.loop)
        try:
            await phase("200 wakes at 100 per second, with 5 agents of other traffic", range(200, 400), gap_s=0.01)
        finally:
            served.loop.call_soon_threadsafe(stop.set)
            await asyncio.wrap_future(load)

    asyncio.run(scenario())
    lines = [report(label, w, e) for label, (w, e) in results.items()]
    lines.append(f"background traffic during the second phase: {background_ops[0]} service calls")
    with capsys.disabled():
        print("\n" + "\n".join(lines))
    paced_wake, paced_e2e = results["200 wakes at 100 per second, with 5 agents of other traffic"]
    burst_wake, _ = results["burst of 200 at once (stress, not gated at 500 ms)"]
    # The gate: 200 parked listeners, wakes at 100 per second (about 30 times the task rate that
    # SP5 D2 ran at), other traffic running. The burst is a stress figure; it only has to finish.
    assert percentile(paced_wake, 0.99) < P99_GATE_S, lines
    assert percentile(paced_e2e, 0.99) < P99_GATE_S, lines
    assert max(burst_wake) < 30, lines
    assert background_ops[0] > 0, lines
    rows = run(_count_wakes(served.env))
    assert rows == 400  # one wake row per woken listener, none lost, none doubled


async def _event() -> asyncio.Event:
    return asyncio.Event()


async def _gather(coros):
    return await asyncio.gather(*coros)


async def _count_wakes(env) -> int:
    async with env.engine.connect() as conn:
        return int((await conn.execute(sa.select(sa.func.count()).select_from(wakes))).scalar_one())


def test_a_client_that_hangs_up_leaves_the_table_and_is_not_woken(served):
    insert_sessions(served.env, 2)
    key = served.env.keys.claude
    table = served.app.state.wake.table
    service = served.app.state.service
    sender = local_caller(CARD_AGY, H_AGY, key_id="feedfeed")

    async def scenario() -> None:
        async with httpx.AsyncClient(base_url=served.url, timeout=60) as http:
            gone = asyncio.ensure_future(
                http.post("/wake/listen", headers={**bearer(key), "X-Coord-Session": hsid_of(0), "X-Coord-Wait": "60"})
            )
            stays = asyncio.ensure_future(
                http.post("/wake/listen", headers={**bearer(key), "X-Coord-Session": hsid_of(1), "X-Coord-Wait": "60"})
            )
            deadline = time.monotonic() + 10
            while table.count() < 2:
                assert time.monotonic() < deadline
                await asyncio.sleep(0.02)
            gone.cancel()  # httpx closes the connection: the server sees the hang-up
            with pytest.raises(asyncio.CancelledError):
                await gone
            deadline = time.monotonic() + 10
            while table.is_listening(handle_of(0)):
                assert time.monotonic() < deadline, "the hung-up listener is still in the table"
                await asyncio.sleep(0.02)
            assert table.is_listening(handle_of(1))
            # a task for the dead listener's handle makes no wake row and nobody answers it
            before = await _count_wakes(served.env)
            meta = {"coord": {"to": handle_of(0)}}
            await asyncio.wrap_future(
                asyncio.run_coroutine_threadsafe(
                    service.send_message(sender, CARD_CLAUDE, message("for the dead one"), metadata=meta), served.loop
                )
            )
            assert await _count_wakes(served.env) == before
            assert not stays.done()  # the other listener is untouched
            stays.cancel()

    asyncio.run(scenario())


def test_revoking_a_key_over_the_admin_socket_closes_the_parked_request_with_403(served):
    insert_sessions(served.env, 1)
    key = served.env.keys.claude
    key_id = served.env.keys.ids["claude"]
    table = served.app.state.wake.table

    async def scenario() -> None:
        async with httpx.AsyncClient(base_url=served.url, timeout=60) as http:
            parked = asyncio.ensure_future(
                http.post("/wake/listen", headers={**bearer(key), "X-Coord-Session": hsid_of(0), "X-Coord-Wait": "60"})
            )
            deadline = time.monotonic() + 10
            while table.count() < 1:
                assert time.monotonic() < deadline
                await asyncio.sleep(0.02)
            out, err = io.StringIO(), io.StringIO()
            environ = {"A2A_ADMIN_SOCKET": served.env.config.admin_socket}
            status = io.StringIO()
            assert await asyncio.to_thread(admin_cli, ["status", "--json"], environ=environ, out=status, err=err) == 0, err.getvalue()
            assert json.loads(status.getvalue())["listeners"] == {"parked": 1}
            code = await asyncio.to_thread(admin_cli, ["key", "revoke", key_id], environ=environ, out=out, err=err)
            assert code == 0, (out.getvalue(), err.getvalue())
            r = await asyncio.wait_for(parked, 10)
            assert r.status_code == 403 and r.content == b""
            # the revoked key is refused for everything from now on
            again = await http.post("/wake/listen", headers={**bearer(key), "X-Coord-Session": hsid_of(0)})
            assert again.status_code == 401

    asyncio.run(scenario())


# =============================================================================================
# SIGTERM on a real server process
# =============================================================================================


def test_sigterm_answers_a_parked_listener_503_with_retry_after_5_and_the_process_exits(pg_db, sock_dir, tmp_path):
    port = free_port()
    env = make_env(pg_db, allowed_hosts=(f"127.0.0.1:{port}",), listen=f"127.0.0.1:{port}")
    cards_file = tmp_path / "cards.yaml"
    cards_file.write_text(f"cards:\n  - name: {CARD_CLAUDE}\n  - name: {CARD_AGY}\n")
    cfg = env.config
    child_env = {
        "PATH": os.environ.get("PATH", ""),
        "A2A_DB_URL": cfg.db_url,
        "A2A_DB_PASSWORD_FILE": cfg.db_password_file,
        "A2A_CARDS_FILE": str(cards_file),
        "A2A_LISTEN": f"127.0.0.1:{port}",
        "A2A_ALLOWED_HOSTS": f"127.0.0.1:{port}",
        "A2A_ADMIN_SOCKET": str(sock_dir / "admin.sock"),
        "A2A_PUBLIC_URL": f"http://127.0.0.1:{port}",
    }
    err_log = tmp_path / "server.err"
    proc = subprocess.Popen(
        [sys.executable, "-m", "coordination"],
        env=child_env,
        stdout=subprocess.DEVNULL,
        stderr=err_log.open("w"),
    )
    key = env.keys.claude
    try:
        deadline = time.monotonic() + 60
        while True:
            assert proc.poll() is None, f"the server exited early: {err_log.read_text()[-500:]}"
            try:
                if httpx.get(f"http://127.0.0.1:{port}/healthz", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            assert time.monotonic() < deadline, "the server did not come up"
            time.sleep(0.2)
        base = f"http://127.0.0.1:{port}"
        # register the session through the real route, then park
        reg = httpx.post(
            f"{base}/sessions",
            json={"card": CARD_CLAUDE, "harness_session_id": hsid_of(7), "name_hint": "sigterm"},
            headers=bearer(key),
            timeout=10,
        )
        assert reg.status_code == 201, reg.text

        async def scenario() -> tuple[int, str | None, bytes, float]:
            async with httpx.AsyncClient(timeout=60) as http:
                task = asyncio.ensure_future(
                    http.post(
                        f"{base}/wake/listen",
                        headers={**bearer(key), "X-Coord-Session": hsid_of(7), "X-Coord-Wait": "120"},
                    )
                )
                await asyncio.sleep(1.5)  # parked
                assert not task.done()
                t0 = time.monotonic()
                proc.send_signal(signal.SIGTERM)
                r = await asyncio.wait_for(task, 20)
                return r.status_code, r.headers.get("retry-after"), r.content, time.monotonic() - t0

        status, retry_after, body, took = asyncio.run(scenario())
        assert status == 503 and retry_after == "5" and body == b""
        assert took < 5, f"the parked listener waited {took:.1f} s for the answer"
        # uvicorn finishes its graceful shutdown and then re-raises the signal it captured, so the
        # process ends "by SIGTERM" (-15); an exit code of 0 is as good. A hang or a crash is not.
        assert proc.wait(timeout=30) in (0, -signal.SIGTERM)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)
        run(env.engine.dispose())
