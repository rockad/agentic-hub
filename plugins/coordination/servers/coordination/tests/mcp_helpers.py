"""Builders shared by the S1-MCP tests: the real app (real access-control middleware over the SQL key
store, the real service layer, a real Postgres), a JSON-RPC client over the test client, and keys.

Nothing here fakes the thing under test. The only stand-ins are the clock (a hand-moved `FixedClock`,
so TTLs and waits run in virtual time) and `sleep` (which advances that clock instead of waiting).
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import tempfile
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import sqlalchemy as sa
from a2a.types import a2a_pb2 as pb
from auth_helpers import FixedClock, bearer, make_record
from conftest import run
from sqlalchemy import URL
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool
from starlette.testclient import TestClient

from coordination.app import create_app
from coordination.audit import AuditLog, SqlAuditStore
from coordination.auth import LOCAL_HARNESS, REMOTE_PEER, STATUS_CLIENT, SqlApiKeyStore
from coordination.config import Config
from coordination.mcp import build_endpoint
from coordination.service import Caller, CoordinationService, Directory, ServiceSettings
from coordination.store import schema
from coordination.store.connect import params_from_config
from coordination.store.tables import audit, cards, sessions
from coordination.store.task_store import CoordTaskStore

HOST = "127.0.0.1:8120"
CARD_CLAUDE = "claude-code@box"
CARD_AGY = "antigravity@box"
CARD_MAC = "claude-code@mac"
H_CLAUDE = f"{CARD_CLAUDE}/one~aaaaaaa1"
H_CLAUDE2 = f"{CARD_CLAUDE}/two~aaaaaaa2"
H_AGY = f"{CARD_AGY}/one~bbbbbbb1"
H_MAC = f"{CARD_MAC}/one~ccccccc1"
CONV_KEY = "antigravity.google/conversation_id"
ROOT_KEY = "antigravity.google/root_conversation_id"
NOT_BOUND = "Not bound. Call a2a_hello."


def null_pool_engine(config: Config) -> AsyncEngine:
    """An engine without a pool: the tests use it from several event loops (asyncio.run and the test
    client's own loop), and a pooled asyncpg connection is bound to the loop that made it."""
    p = params_from_config(config)
    url = URL.create("postgresql+asyncpg", username=p.user, host=p.host, port=p.port, database=p.database)
    return create_async_engine(url, poolclass=NullPool, connect_args={"password": p.password}, hide_parameters=True)


@dataclass
class Keys:
    claude: str
    claude_other: str  # a second key for the same card
    agy: str
    mac: str  # another card's local key
    peer: str
    status: str
    ids: dict[str, str] = field(default_factory=dict)


@dataclass
class McpEnv:
    config: Config
    engine: AsyncEngine
    clock: FixedClock
    service: CoordinationService
    store: CoordTaskStore
    audit_log: AuditLog
    keys: Keys
    sleeps: list[float]
    on_sleep: list[Callable[[float], Any]]

    def app(self, **kwargs: Any):
        """A fresh app over the same database: what a server restart gives (empty in-memory state)."""

        async def sleep(seconds: float) -> None:
            self.sleeps.append(seconds)
            self.clock.advance(seconds=seconds)
            for hook in list(self.on_sleep):
                result = hook(self.clock.monotonic())
                if asyncio.iscoroutine(result):
                    await result
            await asyncio.sleep(0)

        mcp = build_endpoint(
            self.config, self.service, self.engine, self.clock, audit=self.audit_log, sleep=sleep,
            poll_s=kwargs.pop("poll_s", 1.0), listeners=kwargs.pop("listeners", None),
        )
        return create_app(
            self.config,
            clock=self.clock,
            audit=self.audit_log,
            key_store=SqlApiKeyStore(self.engine),
            mcp=mcp,
            identity=mcp.identity,  # S1-ID: `/sessions` over the same service the tools use
            **kwargs,
        )

    def client(self, app=None, *, peer: str = "127.0.0.1") -> McpClient:
        return McpClient(TestClient(app or self.app(), base_url=f"http://{HOST}", client=(peer, 50000), raise_server_exceptions=False))

    # database helpers ---------------------------------------------------------------------

    def add_session(self, handle: str, *, harness_session_id: str | None = None, ended: bool = False) -> None:
        card = handle.split("/", 1)[0]

        async def go() -> None:
            async with self.engine.begin() as conn:
                await conn.execute(
                    sa.insert(sessions).values(
                        handle=handle,
                        card_id=card,
                        harness_session_id=harness_session_id or str(uuid.uuid4()),
                        registered_at=self.clock.now(),
                        last_seen_at=self.clock.now(),
                        ended_at=self.clock.now() if ended else None,
                    )
                )

        run(go())

    def end_session(self, handle: str) -> None:
        async def go() -> None:
            async with self.engine.begin() as conn:
                await conn.execute(sa.update(sessions).where(sessions.c.handle == handle).values(ended_at=self.clock.now()))

        run(go())

    def session_rows(self) -> list[sa.Row]:
        async def go():
            async with self.engine.connect() as conn:
                return list((await conn.execute(sa.select(sessions).order_by(sessions.c.registered_at, sessions.c.handle))).all())

        return run(go())

    def audit_rows(self, event: str | None = None) -> list[sa.Row]:
        async def go():
            stmt = sa.select(audit).order_by(audit.c.id)
            if event:
                stmt = stmt.where(audit.c.event == event)
            async with self.engine.connect() as conn:
                return list((await conn.execute(stmt)).all())

        return run(go())

    # service helpers ----------------------------------------------------------------------

    def send(self, sender: Caller, to: str, text: str = "hello", *, message_id: str | None = None) -> pb.Task:
        """A task through the real service layer: what another session's `a2a_send`, or the A2A
        binding, would create."""
        message = pb.Message(message_id=message_id or str(uuid.uuid4()), role=pb.Role.ROLE_USER)
        message.parts.add(text=text)
        tenant = to.split("/", 1)[0]
        meta = {"coord": {"to": to}} if "/" in to else None
        return run(self.service.send_message(sender, tenant, message, metadata=meta))


def local_caller(card: str = CARD_CLAUDE, handle: str | None = None, key_id: str = "feedfeed") -> Caller:
    return Caller(LOCAL_HARNESS, key_id, card_id=card, handle=handle)


def peer_caller(allowed: tuple[str, ...] = (CARD_CLAUDE,), peer: str = "peer1") -> Caller:
    return Caller(REMOTE_PEER, "9eeeeeee", peer_id=peer, cards_allowed=frozenset(allowed))


def make_env(pg_db, **config_overrides: Any) -> McpEnv:
    """A migrated database with cards, a key of every kind, and the service on it."""
    # S1-ADMIN: `build_server_app` opens the admin socket when the app starts and the server does not
    # start without it, so a test that serves the real app needs a path it may write (the default,
    # /run/a2a, exists only in the container). A short one: AF_UNIX paths are limited to ~108 bytes.
    socket_path = f"{tempfile.gettempdir()}/a2a-t-{uuid.uuid4().hex[:10]}.sock"
    config = pg_db(**{"allow_writes": True, "allowed_hosts": (HOST,), "admin_socket": socket_path, **config_overrides})
    engine = null_pool_engine(config)
    run(schema.migrate_all(engine))
    clock = FixedClock()

    async def seed() -> Keys:
        async with engine.begin() as conn:
            for card in (CARD_CLAUDE, CARD_AGY, CARD_MAC):
                harness, machine = card.split("@")
                await conn.execute(sa.insert(cards).values(card_id=card, harness=harness, machine=machine, card_json={"card": card}))
        store = SqlApiKeyStore(engine)
        tokens: dict[str, str] = {}
        ids: dict[str, str] = {}
        for name, scope, extra in (
            ("claude", LOCAL_HARNESS, {"card_id": CARD_CLAUDE}),
            ("claude_other", LOCAL_HARNESS, {"card_id": CARD_CLAUDE}),
            ("agy", LOCAL_HARNESS, {"card_id": CARD_AGY}),
            ("mac", LOCAL_HARNESS, {"card_id": CARD_MAC}),
            ("peer", REMOTE_PEER, {"peer_id": "peer1", "cards_allowed": (CARD_CLAUDE,)}),
            ("status", STATUS_CLIENT, {}),
        ):
            token, record = make_record(scope, **extra)
            await store.insert(record)
            tokens[name] = token
            ids[name] = record.key_id
        return Keys(**tokens, ids=ids)

    keys = run(seed())
    audit_log = AuditLog(SqlAuditStore(engine), clock)
    task_store = CoordTaskStore(engine, clock=clock)
    service = CoordinationService(task_store, Directory(engine), audit_log, clock, ServiceSettings.from_config(config))
    return McpEnv(config, engine, clock, service, task_store, audit_log, keys, sleeps=[], on_sleep=[])


class McpClient:
    """JSON-RPC over `/mcp` with one key; keeps the session id like a real client."""

    def __init__(self, http: TestClient) -> None:
        self.http = http
        self.session_id: str | None = None
        self._id = 0

    def raw(self, token: str | None, body: Any, *, method: str = "POST", session: str | None = "keep", headers: dict | None = None):
        h = dict(bearer(token)) if token else {}
        h.update(headers or {})
        sid = self.session_id if session == "keep" else session
        if sid:
            h["Mcp-Session-Id"] = sid
        if method == "POST":
            h.setdefault("Content-Type", "application/json")
            h.setdefault("Accept", "application/json, text/event-stream")
            # UTF-8, as a real client sends it (JSON.stringify does not escape non-ASCII).
            data = body if isinstance(body, (bytes, str)) else json.dumps(body, ensure_ascii=False).encode()
            return self.http.request("POST", "/mcp", content=data, headers=h)
        return self.http.request(method, "/mcp", headers=h)

    def rpc(self, token: str, method: str, params: dict | None = None, *, session: str | None = "keep") -> dict:
        self._id += 1
        body: dict[str, Any] = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            body["params"] = params
        response = self.raw(token, body, session=session)
        assert response.status_code == 200, (response.status_code, response.text[:300])
        return response.json()

    def initialize(self, token: str, version: str = "2025-11-25") -> dict:
        self._id += 1
        response = self.raw(
            token,
            {
                "jsonrpc": "2.0", "id": self._id, "method": "initialize",
                "params": {"protocolVersion": version, "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}},
            },
            session=None,
        )
        assert response.status_code == 200, response.text
        self.session_id = response.headers["mcp-session-id"]
        notified = self.raw(token, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        assert notified.status_code == 202
        return response.json()

    def tools(self, token: str) -> list[dict]:
        return self.rpc(token, "tools/list")["result"]["tools"]

    def call(self, token: str, name: str, arguments: dict | None = None, *, meta: dict | None = None) -> ToolResult:
        params: dict[str, Any] = {"name": name, "arguments": arguments or {}}
        if meta is not None:
            params["_meta"] = meta
        reply = self.rpc(token, "tools/call", params)
        assert "result" in reply, reply
        return ToolResult(reply["result"])


@dataclass
class ToolResult:
    raw: dict

    @property
    def is_error(self) -> bool:
        return bool(self.raw["isError"])

    @property
    def text(self) -> str:
        return self.raw["content"][0]["text"]

    @property
    def data(self) -> dict:
        return self.raw["structuredContent"]

    @property
    def tasks(self) -> list[dict]:
        return self.data["tasks"]


def agy_meta(conv: str, root: str | None = None) -> dict:
    meta = {CONV_KEY: conv}
    if root:
        meta[ROOT_KEY] = root
    return meta


def replace_config(config: Config, **changes: Any) -> Config:
    return dataclasses.replace(config, **changes)
