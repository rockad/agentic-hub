"""Builders shared by the S1-STATE service tests: a migrated database with cards and sessions, a
`CoordinationService` on a fake clock, and callers."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine

from a2a.types import a2a_pb2 as pb
from coordination.audit import AuditLog, SqlAuditStore
from coordination.config import Config
from coordination.service import (
    LOCAL_HARNESS,
    REMOTE_PEER,
    Caller,
    CoordinationService,
    Directory,
    ServiceSettings,
)
from coordination.store.tables import audit, cards, sessions
from coordination.store.task_store import CoordTaskStore
from store_helpers import FakeClock, migrated_engine

CARD_A = "claude-code@box"
CARD_B = "antigravity@box"
CARD_C = "claude-code@mac"
H_A1 = f"{CARD_A}/one~aaaaaaa1"
H_A2 = f"{CARD_A}/two~aaaaaaa2"
H_B1 = f"{CARD_B}/one~bbbbbbb1"
H_B2 = f"{CARD_B}/two~bbbbbbb2"


class FakeListeners:
    """The parked-listener table, by hand."""

    def __init__(self) -> None:
        self.by_card: dict[str, str] = {}

    def park(self, handle: str) -> None:
        self.by_card[handle.split("/", 1)[0]] = handle

    def unpark_all(self) -> None:
        self.by_card.clear()

    def is_listening(self, handle: str) -> bool:
        return handle in self.by_card.values()

    def newest_listening(self, card_id: str) -> str | None:
        return self.by_card.get(card_id)


class FakeNotifier:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def notify_pending(self, handle: str) -> None:
        self.calls.append(handle)


def local(card: str = CARD_A, handle: str | None = None, key_id: str = "k1234abcd") -> Caller:
    return Caller(LOCAL_HARNESS, key_id, card_id=card, handle=handle)


def remote(peer: str = "peer1", allowed: tuple[str, ...] = (CARD_A,), key_id: str = "r1234abcd") -> Caller:
    return Caller(REMOTE_PEER, key_id, peer_id=peer, cards_allowed=frozenset(allowed))


def msg(text: str = "hello", *, message_id: str | None = None, context_id: str = "", task_id: str = "") -> pb.Message:
    m = pb.Message(
        message_id=message_id or str(uuid.uuid4()), context_id=context_id, task_id=task_id, role=pb.Role.ROLE_USER
    )
    m.parts.add(text=text)
    return m


def to_meta(handle: str) -> dict:
    return {"coord": {"to": handle}}


@dataclass
class Env:
    engine: AsyncEngine
    store: CoordTaskStore
    service: CoordinationService
    clock: FakeClock
    listeners: FakeListeners
    notifier: FakeNotifier
    audit_log: AuditLog
    directory: Directory
    settings: ServiceSettings
    _handles: dict[str, str] = field(default_factory=dict)

    async def add_session(self, handle: str, *, ended: bool = False, last_seen: datetime | None = None) -> None:
        card = handle.split("/", 1)[0]
        now = self.clock.now()
        async with self.engine.begin() as conn:
            await conn.execute(
                sa.insert(sessions).values(
                    handle=handle,
                    card_id=card,
                    harness_session_id=str(uuid.uuid4()),
                    registered_at=now,
                    last_seen_at=last_seen or now,
                    ended_at=now if ended else None,
                )
            )

    async def end_session(self, handle: str) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(sa.update(sessions).where(sessions.c.handle == handle).values(ended_at=self.clock.now()))

    async def touch_session(self, handle: str) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(
                sa.update(sessions).where(sessions.c.handle == handle).values(last_seen_at=self.clock.now())
            )

    async def audit_rows(self, event: str | None = None) -> list[sa.Row]:
        stmt = sa.select(audit).order_by(audit.c.id)
        if event:
            stmt = stmt.where(audit.c.event == event)
        async with self.engine.connect() as conn:
            return list((await conn.execute(stmt)).all())

    async def transitions_of(self, task_id: str) -> list[tuple[str | None, str, str]]:
        """(from_state, to_state, actor) of every `state_transition` row naming `task_id`."""
        return [
            (r.detail_json["from_state"], r.detail_json["to_state"], r.actor)
            for r in await self.audit_rows("state_transition")
            if r.subject == task_id
        ]


@asynccontextmanager
async def service_env(config: Config, clock: FakeClock | None = None, **settings: int) -> AsyncIterator[Env]:
    clock = clock or FakeClock()
    cfg = ServiceSettings(**settings)
    async with migrated_engine(config) as engine:
        async with engine.begin() as conn:
            for card in (CARD_A, CARD_B, CARD_C):
                harness, machine = card.split("@")
                await conn.execute(
                    sa.insert(cards).values(card_id=card, harness=harness, machine=machine, card_json={"card": card})
                )
        store = CoordTaskStore(engine, clock=clock)
        audit_log = AuditLog(SqlAuditStore(engine), clock)
        listeners, notifier = FakeListeners(), FakeNotifier()
        directory = Directory(engine)
        service = CoordinationService(
            store, directory, audit_log, clock, cfg, listeners=listeners, notifier=notifier
        )
        yield Env(engine, store, service, clock, listeners, notifier, audit_log, directory, cfg)


def minutes(n: float) -> timedelta:
    return timedelta(minutes=n)
