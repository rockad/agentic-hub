"""Builders shared by the S1-WAKE tests: the real app as `main` builds it (`build_server_app`: the
real middleware over the SQL key store, the real service layer, the real listener table and wake
service, the real hooks), on a real Postgres, driven in one event loop through httpx's ASGI
transport so a parked `/wake/listen` request is just a pending task.

The only stand-ins are the clock (a hand-moved `FixedClock`, so the budget hour and the 120 s
confirmation window pass at once) and a short wake re-check (`recheck_s`), so a re-check does not
take 20 real seconds. Round ends use real time, with `X-Coord-Wait: 1`.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
import sqlalchemy as sa
from a2a.types import a2a_pb2 as pb
from auth_helpers import bearer
from conftest import run
from mcp_helpers import (
    CARD_AGY,
    CARD_CLAUDE,
    CARD_MAC,
    H_AGY,
    H_CLAUDE,
    H_CLAUDE2,
    HOST,
    McpEnv,
    local_caller,
    make_env,
    peer_caller,
)
from starlette.applications import Starlette

from coordination.app import build_server_app
from coordination.service import Caller
from coordination.store.tables import audit, sessions, wakes
from coordination.wake.service import WakeService

# Harness session ids for the handles of `mcp_helpers` (the id a hook would send).
HS_CLAUDE = "aaaaaaa1-1111-4111-8111-111111111111"
HS_CLAUDE2 = "aaaaaaa2-2222-4222-8222-222222222222"
HS_AGY = "bbbbbbb1-3333-4333-8333-333333333333"
HS_MAC = "ccccccc1-4444-4444-8444-444444444444"
H_MAC1 = f"{CARD_MAC}/one~ccccccc1"

__all__ = [
    "CARD_AGY",
    "CARD_CLAUDE",
    "HS_AGY",
    "HS_CLAUDE",
    "HS_CLAUDE2",
    "HS_MAC",
    "H_AGY",
    "H_CLAUDE",
    "H_CLAUDE2",
    "H_MAC1",
    "WakeEnv",
    "make_wake_env",
    "message",
    "run_wake",
]


def message(text: str = "hello") -> pb.Message:
    msg = pb.Message(message_id=str(uuid.uuid4()), role=pb.Role.ROLE_USER)
    msg.parts.add(text=text)
    return msg


@dataclass
class WakeEnv:
    env: McpEnv
    app: Starlette

    @property
    def clock(self):
        return self.env.clock

    @property
    def keys(self):
        return self.env.keys

    @property
    def wake(self) -> WakeService:
        return self.app.state.wake

    @property
    def table(self):
        return self.app.state.wake.table

    def restarted(self, *, recheck_s: float = 0.05) -> WakeEnv:
        """A fresh app on the same database and clock: a server restart. Nothing in memory carries
        over (the listener table, the announce memory, the park counters); the caller disposes
        `.app.state.engine` of the result."""
        app = build_server_app(self.env.config, clock=self.env.clock, wake_recheck_s=recheck_s)
        return WakeEnv(self.env, app)

    @asynccontextmanager
    async def client(self):
        transport = httpx.ASGITransport(app=self.app, client=("127.0.0.1", 50000))
        async with httpx.AsyncClient(transport=transport, base_url=f"http://{HOST}", timeout=60) as http:
            try:
                yield http
            finally:
                self.table.begin_shutdown()  # never leave a parked request behind

    # -- sessions and tasks ---------------------------------------------------------------

    async def add_session(self, handle: str, harness_session_id: str, *, ended: bool = False) -> None:
        card = handle.split("/", 1)[0]
        async with self.env.engine.begin() as conn:
            await conn.execute(
                sa.insert(sessions).values(
                    handle=handle,
                    card_id=card,
                    harness_session_id=harness_session_id,
                    registered_at=self.clock.now(),
                    last_seen_at=self.clock.now(),
                    ended_at=self.clock.now() if ended else None,
                )
            )

    async def send(self, to: str, text: str = "hello", *, sender: Caller | None = None) -> pb.Task:
        """A task through the real task service the bindings use: `to` is a handle or a card id."""
        sender = sender or local_caller(CARD_AGY, H_AGY, key_id="feedfeed")
        tenant = to.split("/", 1)[0]
        meta = {"coord": {"to": to}} if "/" in to else None
        return await self.app.state.service.send_message(sender, tenant, message(text), metadata=meta)

    async def send_from_peer(self, to_card: str, text: str = "hello") -> pb.Task:
        return await self.app.state.service.send_message(peer_caller((to_card,)), to_card, message(text))

    def caller(self, handle: str) -> Caller:
        return local_caller(handle.split("/", 1)[0], handle, key_id=self.keys.ids["claude"])

    async def inbox(self, handle: str):
        return await self.app.state.service.inbox(self.caller(handle), limit=50)  # offer every pending task

    # -- the wake endpoint ----------------------------------------------------------------

    def listen(
        self, http: httpx.AsyncClient, token: str, session: str, *, wait: int | None = 30, headers: dict[str, str] | None = None
    ) -> asyncio.Task[httpx.Response]:
        h = dict(bearer(token))
        h["X-Coord-Session"] = session
        if wait is not None:
            h["X-Coord-Wait"] = str(wait)
        h.update(headers or {})
        return asyncio.ensure_future(http.post("/wake/listen", headers=h))

    async def parked(self, handle: str, *, timeout: float = 10.0) -> None:
        """Wait until the table shows a live listener for `handle`."""
        async with asyncio.timeout(timeout):
            while not self.table.is_listening(handle):
                await asyncio.sleep(0.005)

    async def parked_and_checked(self, handle: str, *, settle: float = 0.15) -> None:
        """Parked, and the first look for a due wake has run (it runs before the first wait)."""
        await self.parked(handle)
        await asyncio.sleep(settle)

    async def wake_rows(self, handle: str | None = None):
        stmt = sa.select(wakes).order_by(wakes.c.wake_id)
        if handle is not None:
            stmt = stmt.where(wakes.c.handle == handle)
        async with self.env.engine.connect() as conn:
            return list((await conn.execute(stmt)).all())

    async def audit_events(self, event: str):
        async with self.env.engine.connect() as conn:
            return list((await conn.execute(sa.select(audit).where(audit.c.event == event).order_by(audit.c.id))).all())

    async def settle(self, task: asyncio.Task[Any], timeout: float = 10.0):
        return await asyncio.wait_for(task, timeout)

    async def not_done(self, task: asyncio.Task[Any], seconds: float = 0.3) -> bool:
        """True if `task` is still pending after `seconds`."""
        await asyncio.sleep(seconds)
        return not task.done()

    # -- the MCP endpoint over the same app -----------------------------------------------

    def mcp(self, http: httpx.AsyncClient, token: str) -> McpAsync:
        return McpAsync(http, token)


class McpAsync:
    """A minimal async `/mcp` client: one key, one `Mcp-Session-Id`."""

    def __init__(self, http: httpx.AsyncClient, token: str) -> None:
        self._http, self._token = http, token
        self._sid: str | None = None
        self._n = 0

    async def _post(self, body: dict[str, Any]) -> httpx.Response:
        headers = {**bearer(self._token), "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self._sid:
            headers["Mcp-Session-Id"] = self._sid
        return await self._http.post("/mcp", content=json.dumps(body).encode(), headers=headers)

    async def initialize(self) -> None:
        self._n += 1
        r = await self._post(
            {"jsonrpc": "2.0", "id": self._n, "method": "initialize",
             "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}}
        )
        assert r.status_code == 200, r.text
        self._sid = r.headers["mcp-session-id"]
        assert (await self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})).status_code == 202

    async def call(self, name: str, arguments: dict[str, Any] | None = None, *, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._sid is None:
            await self.initialize()
        self._n += 1
        params: dict[str, Any] = {"name": name, "arguments": arguments or {}}
        if meta is not None:
            params["_meta"] = meta
        r = await self._post({"jsonrpc": "2.0", "id": self._n, "method": "tools/call", "params": params})
        assert r.status_code == 200, r.text
        return r.json()["result"]


def make_wake_env(
    pg_db: Callable[..., Any], *, recheck_s: float = 0.05, sweep_interval_s: float | None = None, **config_overrides: Any
) -> WakeEnv:
    """Seeds a migrated database (cards, keys of every kind) and builds the real server app on it
    with the hand-moved clock. Call it outside the event loop (the seeding runs its own loop); the
    app's engine connects lazily, inside the loop of `run_wake`. The TTL sweep runs only inside the
    app's lifespan, which the ASGI transport does not start; `sweep_interval_s` is for a test that
    does start it."""
    env = make_env(pg_db, **config_overrides)
    app = build_server_app(env.config, clock=env.clock, wake_recheck_s=recheck_s, sweep_interval_s=sweep_interval_s)
    return WakeEnv(env, app)


def run_wake(wk: WakeEnv, scenario: Callable[[WakeEnv], Awaitable[Any]]) -> Any:
    """Run `scenario(wk)` in one event loop, then answer any parked listener and dispose both
    engines."""

    async def go() -> Any:
        try:
            return await scenario(wk)
        finally:
            wk.table.begin_shutdown()
            await wk.app.state.engine.dispose()
            await wk.env.engine.dispose()

    return run(go())
