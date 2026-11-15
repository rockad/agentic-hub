"""Builders shared by the store tests."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

from a2a.types import a2a_pb2 as pb
from coordination.config import Config
from coordination.store import schema
from coordination.store.engine import make_engine
from coordination.store.task_store import CoordTaskStore, IndexEntry

S = pb.TaskState


class FakeClock:
    """A `Clock` the test moves by hand."""

    def __init__(self, start: datetime | None = None) -> None:
        self._now = start or datetime(2026, 11, 14, 12, 0, 0, tzinfo=UTC)
        self._mono = 0.0

    def now(self) -> datetime:
        return self._now

    def monotonic(self) -> float:
        return self._mono

    def advance(self, **kwargs: float) -> datetime:
        delta = timedelta(**kwargs)
        self._now += delta
        self._mono += delta.total_seconds()
        return self._now


def new_task(
    state: int = S.TASK_STATE_SUBMITTED,
    *,
    task_id: str | None = None,
    context_id: str | None = None,
    text: str = "hello",
    stamp: datetime | None = None,
) -> pb.Task:
    task = pb.Task(id=task_id or str(uuid.uuid4()), context_id=context_id or str(uuid.uuid4()))
    task.status.state = state
    if stamp is not None:
        task.status.timestamp.FromDatetime(stamp)
    message = task.history.add(message_id=str(uuid.uuid4()), context_id=task.context_id, task_id=task.id, role=pb.Role.ROLE_USER)
    message.parts.add(text=text)
    return task


def entry(
    *,
    sender: str = "key-a",
    to_card: str | None = "claude-code@box",
    origin: str = "local",
    **kw: object,
) -> IndexEntry:
    return IndexEntry(from_principal=sender, origin=origin, to_card=to_card, **kw)  # type: ignore[arg-type]


def set_state(state: int):
    def mutate(task: pb.Task) -> None:
        task.status.state = state

    return mutate


@asynccontextmanager
async def migrated_store(config: Config, clock: FakeClock | None = None) -> AsyncIterator[CoordTaskStore]:
    """A migrated database, an engine on it and a `CoordTaskStore`; disposed on exit."""
    engine = make_engine(config)
    try:
        await schema.migrate_all(engine)
        yield CoordTaskStore(engine, clock=clock)
    finally:
        await engine.dispose()


@asynccontextmanager
async def migrated_engine(config: Config):
    engine = make_engine(config)
    try:
        await schema.migrate_all(engine)
        yield engine
    finally:
        await engine.dispose()
