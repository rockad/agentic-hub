"""`CoordTaskStore`: our task store over the SDK `VersionedDatabaseTaskStore` (spec 1.2, D4, D37).

Why it exists. The plain SDK `DatabaseTaskStore` lost updates under a same-task race (299 of 300
on Postgres, SP5 D10), so every state change goes through the SDK versioned store's
compare-and-swap, and exactly one path writes a task:

- `create` writes the task row, its `task_versions` row (version 1) and its `task_index` row in
  ONE transaction. Seeding the version row at creation is the SP5 D10 cure: without it, the first
  two concurrent transitions both insert it and deadlock (22 retried deadlocks, p99 1031 ms; with
  the seed, none, p99 13.8 ms).
- `transition` reads the task with its version, checks the state, mutates, and saves through
  `VersionedDatabaseTaskStore.save(prev_version=...)`. A lost race raises the SDK's
  `ConcurrentTaskModificationError`, which `transition` turns into a re-read and a fresh check,
  so the loser sees the new state and is refused rather than overwriting it.
- There is no public plain `save`. A direct write must never be mixed with the versioned path
  (SP5: a terminal state was overwritten by a direct write).

Composition, not subclassing. The spec calls this "a `TaskStore` subclass", but the SDK request
handler that would call a `TaskStore` is not used (BP16, SP5 D11: our own handler). This class
keeps only the SDK's types and its versioned store, and takes an explicit `Viewer` where the SDK
takes a `ServerCallContext`, so visibility cannot be skipped by passing the wrong context.

Visibility (spec 3.3.3, [design]). A viewer sees a task it originated (`from_principal`), or, when
it has a card, a task addressed to that card that is not held. A held (quarantined) task is never
visible to the recipient side. `remote-peer` viewers have no card and see only their own tasks.
Tasks with `coord.origin = import` have no index row and are an admin and GL matter, not here.

Owner. The SDK keeps an `owner` column on every row and filters by it. Our visibility is
"originator or recipient", which one owner value cannot express (SP5 D11), so every row has the
same constant owner and visibility lives in `task_index`.

SDK internals used, pinned by the exact `a2a-sdk==1.3.0` (a test fails on any bump): the
`DatabaseTaskStore` helpers `_to_orm`, `_from_orm`, `_after_cursor` and `_cursor_for`. The SDK's own
versioned store uses the first two the same way.
"""

from __future__ import annotations

from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from a2a.server.cluster.database_task_store import VersionedDatabaseTaskStore
from a2a.server.cluster.task_store import ConcurrentTaskModificationError, StoredTask
from a2a.server.cluster.version import TaskVersion
from a2a.server.context import ServerCallContext
from a2a.server.models import PushNotificationConfigModel, TaskEventModel, TaskVersionModel
from a2a.types import a2a_pb2 as pb
from a2a.utils.constants import DEFAULT_LIST_TASKS_PAGE_SIZE
from a2a.utils.errors import InvalidParamsError
from a2a.utils.task import decode_list_tasks_cursor, encode_list_tasks_cursor
from coordination.clock import Clock, SystemClock
from coordination.store.tables import task_index

#: The one `owner` value of every task row. Visibility is in `task_index`, not in `owner`.
OWNER = "coord"

S = pb.TaskState
TERMINAL_STATES: frozenset[int] = frozenset(
    {S.TASK_STATE_COMPLETED, S.TASK_STATE_FAILED, S.TASK_STATE_CANCELED, S.TASK_STATE_REJECTED}
)
TERMINAL_NAMES: tuple[str, ...] = tuple(sorted(S.Name(s) for s in TERMINAL_STATES))
REJECTED_NAME = S.Name(S.TASK_STATE_REJECTED)

#: SQLSTATE of a unique violation. asyncpg reports it as `sqlstate` on the DBAPI error.
_UNIQUE_VIOLATION = "23505"

_CTX = ServerCallContext()  # our owner resolver ignores the context

#: How many times `transition` re-reads after losing a compare-and-swap before it gives up.
MAX_CAS_ATTEMPTS = 8

#: `task_index` columns a caller may change after creation. The identity of a task (who sent it,
#: where it came from) never changes.
MUTABLE_INDEX_COLUMNS = frozenset(
    {"to_card", "to_handle", "addressing", "hold", "offer_count", "last_offered_at", "next_offer_at",
     "expires_at", "released_at"}
)


class TaskExists(Exception):
    """A task with this id is already stored."""

    def __init__(self, task_id: str) -> None:
        super().__init__(f"task {task_id} already exists")
        self.task_id = task_id


class TaskNotFound(LookupError):
    """No such task, or the viewer may not see it (the two are not told apart)."""

    def __init__(self, task_id: str) -> None:
        super().__init__(f"task {task_id} not found")
        self.task_id = task_id


class TransitionRefused(Exception):
    """The task is not in a state this transition may start from. Carries the state it is in."""

    def __init__(self, task_id: str, state: int) -> None:
        super().__init__(f"task {task_id} is {S.Name(state)}, transition refused")
        self.task_id = task_id
        self.state = state


class TransitionContention(RuntimeError):
    """`MAX_CAS_ATTEMPTS` compare-and-swaps in a row were lost to other writers."""


@dataclass(frozen=True)
class Viewer:
    """Who is asking. `principal` is what `task_index.from_principal` holds for tasks it sent."""

    principal: str
    card_id: str | None = None  # local-harness keys carry their card; remote-peer keys do not


@dataclass(frozen=True)
class IndexEntry:
    """What the caller says about a new task, for its `task_index` row."""

    from_principal: str
    origin: str  # "local" or "remote"
    to_card: str | None = None
    to_handle: str | None = None
    addressing: str | None = None  # "handle" or "card" [design]
    hold: str | None = None
    expires_at: datetime | None = None


@dataclass(frozen=True)
class IndexRow:
    task_id: str
    from_principal: str
    origin: str
    to_card: str | None
    to_handle: str | None
    addressing: str | None
    hold: str | None
    offer_count: int
    last_offered_at: datetime | None
    next_offer_at: datetime | None
    expires_at: datetime | None
    released_at: datetime | None


@dataclass(frozen=True)
class TransitionResult:
    task: pb.Task
    version: TaskVersion
    previous_state: int


@dataclass(frozen=True)
class Integrity:
    """Row-count cross-checks between the SDK tables and our index. All four must be 0."""

    tasks_without_version: int  # a task the CAS path cannot protect: the SP5 D10 hazard
    tasks_without_index: int  # SP5b "orphan tasks" (an import-origin task legitimately has none)
    index_without_task: int  # SP5b "orphan index rows"
    versions_without_task: int

    @property
    def ok(self) -> bool:
        return not (
            self.tasks_without_version or self.tasks_without_index or self.index_without_task or self.versions_without_task
        )


def visible_to(viewer: Viewer) -> sa.ColumnElement[bool]:
    """The SQL condition on `task_index` for "this viewer may see the task"."""
    own = task_index.c.from_principal == viewer.principal
    if viewer.card_id is None:
        return own
    return sa.or_(own, sa.and_(task_index.c.to_card == viewer.card_id, task_index.c.hold.is_(None)))


class CoordTaskStore:
    def __init__(
        self,
        engine: AsyncEngine,
        *,
        clock: Clock | None = None,
        max_cas_attempts: int = MAX_CAS_ATTEMPTS,
    ) -> None:
        self._versioned = VersionedDatabaseTaskStore(
            engine, create_table=False, owner_resolver=lambda _ctx: OWNER
        )
        self._db = self._versioned.as_task_store  # the underlying, unversioned reader and mapper
        self._maker = self._db.async_session_maker
        self._tm = self._db.task_model
        self._clock = clock if clock is not None else SystemClock()
        self._max_cas_attempts = max_cas_attempts

    # -- create -----------------------------------------------------------------------------

    async def create(self, task: pb.Task, entry: IndexEntry) -> TaskVersion:
        """Store a new task, its version row (1) and its index row in one transaction.

        The status timestamp is set from the clock when the caller left it unset, so retention can
        age every task. Raises `TaskExists` if the id is taken; nothing is written then.
        """
        if not task.status.HasField("timestamp"):
            task.status.timestamp.FromDatetime(self._clock.now())
        model = self._db._to_orm(task, OWNER)  # noqa: SLF001 - SDK helper, pinned version
        try:
            async with self._maker.begin() as session:
                # Same lock order as the SDK's own save: the version row before the task row.
                await session.execute(sa.insert(TaskVersionModel).values(task_id=task.id, owner=OWNER, version=1))
                session.add(model)
                await session.flush()
                await session.execute(
                    sa.insert(task_index).values(
                        task_id=task.id,
                        from_principal=entry.from_principal,
                        origin=entry.origin,
                        to_card=entry.to_card,
                        to_handle=entry.to_handle,
                        addressing=entry.addressing,
                        hold=entry.hold,
                        expires_at=entry.expires_at,
                    )
                )
        except IntegrityError as exc:
            if getattr(exc.orig, "sqlstate", None) == _UNIQUE_VIOLATION:
                raise TaskExists(task.id) from None
            raise
        return TaskVersion(1)

    # -- read -------------------------------------------------------------------------------

    async def get(self, task_id: str, viewer: Viewer | None = None) -> StoredTask | None:
        """The task and its version, or None. With a `viewer`, only if the viewer may see it.

        `viewer=None` is the trusted internal read (service layer, admin socket, retention): the
        caller has already decided who is asking.
        """
        tm, vm = self._tm, TaskVersionModel
        stmt = (
            sa.select(tm, vm.version)
            .outerjoin(vm, sa.and_(vm.task_id == tm.id, vm.owner == tm.owner))
            .where(tm.id == task_id, tm.owner == OWNER)
        )
        if viewer is not None:
            stmt = stmt.join(task_index, task_index.c.task_id == tm.id).where(visible_to(viewer))
        async with self._maker() as session:
            found = (await session.execute(stmt)).one_or_none()
        if found is None:
            return None
        row, version = found
        # A missing version row is the hazard `create` prevents. Report it as MISSING: the next
        # versioned write inserts it, and `check_integrity` counts it.
        return StoredTask(
            self._db._from_orm(row),  # noqa: SLF001
            TaskVersion(version) if version is not None else TaskVersion.MISSING,
        )

    async def get_index(self, task_id: str) -> IndexRow | None:
        async with self._maker() as session:
            row = (await session.execute(sa.select(task_index).where(task_index.c.task_id == task_id))).one_or_none()
        return IndexRow(**row._mapping) if row is not None else None

    async def list(self, params: pb.ListTasksRequest, viewer: Viewer) -> pb.ListTasksResponse:
        """`ListTasks` restricted to what `viewer` may see, newest first, with the SDK's cursor."""
        tm = self._tm
        stamp = tm.last_updated
        base = (
            sa.select(tm)
            .join(task_index, task_index.c.task_id == tm.id)
            .where(tm.owner == OWNER, visible_to(viewer))
        )
        if params.context_id:
            base = base.where(tm.context_id == params.context_id)
        if params.status:
            base = base.where(tm.status["state"].as_string() == S.Name(params.status))
        if params.HasField("status_timestamp_after"):
            base = base.where(stamp >= params.status_timestamp_after.ToDatetime())
        page_size = params.page_size or DEFAULT_LIST_TASKS_PAGE_SIZE
        ordered = base.order_by(sa.case((stamp.is_(None), 1), else_=0).asc(), stamp.desc(), tm.id.desc())
        if params.page_token:
            cursor = decode_list_tasks_cursor(params.page_token)
            if cursor is None:
                raise InvalidParamsError("Invalid page token")
            ordered = ordered.where(self._db._after_cursor(cursor))  # noqa: SLF001
        async with self._maker() as session:
            total = (await session.execute(sa.select(sa.func.count()).select_from(base.alias()))).scalar_one()
            rows = (await session.execute(ordered.limit(page_size + 1))).scalars().all()
        page = rows[:page_size]
        token = (
            encode_list_tasks_cursor(self._db._cursor_for(page[-1]))  # noqa: SLF001
            if len(rows) == page_size + 1
            else None
        )
        return pb.ListTasksResponse(
            tasks=[self._db._from_orm(r) for r in page],  # noqa: SLF001
            total_size=total,
            next_page_token=token,
            page_size=page_size,
        )

    # -- write ------------------------------------------------------------------------------

    async def transition(
        self,
        task_id: str,
        *,
        allowed_from: Collection[int],
        mutate: Callable[[pb.Task], None],
        viewer: Viewer | None = None,
        index_update: Mapping[str, Any] | None = None,
    ) -> TransitionResult:
        """Move a task on, by compare-and-swap. The only way a stored task changes.

        Reads the task and its version, refuses unless its state is in `allowed_from`, applies
        `mutate` to a copy, stamps the status timestamp from the clock, and saves with the version
        it read. If another writer got in first the SDK raises, and this re-reads and checks again:
        a loser that finds the task terminal gets `TransitionRefused`, never a silent overwrite.
        `mutate` therefore runs once per attempt and must be free of side effects.

        Raises `TaskNotFound`, `TransitionRefused` (carries the current state) or
        `TransitionContention`.

        `index_update` is applied right after the task write succeeds, in its own transaction:
        the SDK's save opens its own, so the two cannot share one. The window is [design]: a crash
        between them leaves the new task state with the old index row. Order the fields so the old
        row is the safe one (for example clear `hold` here, never set it afterwards).
        """
        for _ in range(self._max_cas_attempts):
            stored = await self.get(task_id, viewer)
            if stored is None:
                raise TaskNotFound(task_id)
            before = stored.task.status.state
            if before not in allowed_from:
                raise TransitionRefused(task_id, before)
            task = stored.task  # `get` builds a fresh message each time; safe to mutate
            mutate(task)
            task.status.timestamp.FromDatetime(self._clock.now())
            try:
                version = await self._versioned.save(
                    task, event=None, prev=None, prev_version=stored.version, context=_CTX
                )
            except ConcurrentTaskModificationError:
                continue
            if index_update:
                await self.update_index(task_id, index_update)
            return TransitionResult(task, version, before)
        raise TransitionContention(f"task {task_id}: lost {self._max_cas_attempts} compare-and-swaps in a row")

    async def update_index(
        self,
        task_id: str,
        values: Mapping[str, Any],
        *,
        expect: Mapping[str, Any] | None = None,
    ) -> bool:
        """Change `task_index` columns. True if a row matched.

        `expect` makes it a compare-and-set on the index: it only applies when every named column
        holds the given value (None means NULL). The atomic claim of a card-addressed task is
        `update_index(id, {"to_handle": me}, expect={"to_handle": None})`.
        """
        unknown = set(values) - MUTABLE_INDEX_COLUMNS
        if unknown:
            raise ValueError(f"task_index column(s) not changeable: {', '.join(sorted(unknown))}")
        if not values:
            return False
        stmt = sa.update(task_index).where(task_index.c.task_id == task_id).values(**values)
        for column, wanted in (expect or {}).items():
            col = task_index.c[column]
            stmt = stmt.where(col.is_(None) if wanted is None else col == wanted)
        async with self._maker.begin() as session:
            return (await session.execute(stmt)).rowcount > 0

    async def delete_tasks(self, task_ids: Sequence[str]) -> int:
        """Remove tasks and everything keyed to them, in one transaction. Returns tasks removed.

        The task row goes last so a reader never sees a task without its version row.
        """
        if not task_ids:
            return 0
        ids = list(task_ids)
        async with self._maker.begin() as session:
            for model in (PushNotificationConfigModel, TaskEventModel, TaskVersionModel):
                await session.execute(sa.delete(model).where(model.task_id.in_(ids)))
            await session.execute(sa.delete(task_index).where(task_index.c.task_id.in_(ids)))
            result = await session.execute(sa.delete(self._tm).where(self._tm.id.in_(ids)))
        return result.rowcount

    # -- retention queries ------------------------------------------------------------------

    async def terminal_ids_older_than(self, cutoff: datetime, limit: int) -> list[str]:
        """Ids of terminal tasks whose last status change is before `cutoff` (aware, UTC)."""
        stmt = (
            sa.select(self._tm.id)
            .where(self._tm.status["state"].as_string().in_(TERMINAL_NAMES), self._tm.last_updated < _naive_utc(cutoff))
            .order_by(self._tm.last_updated)
            .limit(limit)
        )
        async with self._maker() as session:
            return list((await session.execute(stmt)).scalars())

    async def remote_rejected_ids_older_than(self, cutoff: datetime, limit: int) -> list[str]:
        """Ids of `REJECTED` tasks of remote origin, last changed before `cutoff` (aware, UTC)."""
        stmt = (
            sa.select(self._tm.id)
            .join(task_index, task_index.c.task_id == self._tm.id)
            .where(
                task_index.c.origin == "remote",
                self._tm.status["state"].as_string() == REJECTED_NAME,
                self._tm.last_updated < _naive_utc(cutoff),
            )
            .order_by(self._tm.last_updated)
            .limit(limit)
        )
        async with self._maker() as session:
            return list((await session.execute(stmt)).scalars())

    # -- integrity --------------------------------------------------------------------------

    async def check_integrity(self) -> Integrity:
        tm, vm, ix = self._tm, TaskVersionModel, task_index

        def count(from_clause: Any, where: Any) -> sa.ScalarSelect[int]:
            return sa.select(sa.func.count()).select_from(from_clause).where(where).scalar_subquery()

        stmt = sa.select(
            count(tm.__table__.outerjoin(vm.__table__, sa.and_(vm.task_id == tm.id, vm.owner == tm.owner)), vm.task_id.is_(None)),
            count(tm.__table__.outerjoin(ix, ix.c.task_id == tm.id), ix.c.task_id.is_(None)),
            count(ix.outerjoin(tm.__table__, tm.id == ix.c.task_id), tm.id.is_(None)),
            count(vm.__table__.outerjoin(tm.__table__, tm.id == vm.task_id), tm.id.is_(None)),
        )
        async with self._maker() as session:
            a, b, c, d = (await session.execute(stmt)).one()
        return Integrity(a, b, c, d)


def _naive_utc(moment: datetime) -> datetime:
    """The SDK stores `last_updated` as a naive UTC datetime."""
    if moment.tzinfo is None:
        raise ValueError("expected a timezone-aware datetime")
    return moment.astimezone(UTC).replace(tzinfo=None)
