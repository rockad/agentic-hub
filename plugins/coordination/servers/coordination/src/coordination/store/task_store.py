"""`CoordTaskStore`: our task store over the SDK `VersionedDatabaseTaskStore` (spec 1.2, D4, D37).

Why it exists. The plain SDK `DatabaseTaskStore` lost updates under a same-task race (299 of 300
on Postgres, SP5 D10), so every state change goes through the SDK versioned store's
compare-and-swap, and exactly one path writes a task:

- `create` writes the task row, its `task_versions` row (version 1) and its `task_index` row in
  ONE transaction. Seeding the version row at creation is the SP5 D10 cure: without it, the first
  two concurrent transitions both insert it and deadlock (22 retried deadlocks, p99 1031 ms; with
  the seed, none, p99 13.8 ms).
- `transition` reads the task with its version, checks the state, mutates, and writes the task, its
  version bump, the `task_index` change and the audit rows in ONE transaction (decision Z6,
  2026-11-15). The version bump is the same compare-and-swap as the SDK's versioned store
  (`UPDATE task_versions ... WHERE version = <read>`, version row locked before the task row), done
  on our own session so everything else can join it. A lost race raises the SDK's
  `ConcurrentTaskModificationError`, which `transition` turns into a re-read and a fresh check,
  so the loser sees the new state and is refused rather than overwriting it. Cancel is not
  special-cased as in the SDK (which overwrites a non-terminal task without checking the version):
  it too is a compare-and-swap, so a follow-up message appended a moment earlier is never lost.
- Because the SDK's own `save` opens a session of its own, `transition` no longer calls it. What it
  still takes from the SDK is the table layout, `_to_orm`/`_from_orm` and `_insert_version`,
  guarded by the exact `a2a-sdk==1.3.0` pin.
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

import asyncio
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.exc import DBAPIError, IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from a2a.server.cluster.database_task_store import VersionedDatabaseTaskStore
from a2a.server.cluster.task_store import ConcurrentTaskModificationError, StoredTask
from a2a.server.cluster.version import TaskVersion
from a2a.server.models import PushNotificationConfigModel, TaskEventModel, TaskVersionModel
from a2a.types import a2a_pb2 as pb
from a2a.utils.constants import DEFAULT_LIST_TASKS_PAGE_SIZE
from a2a.utils.errors import InvalidParamsError
from a2a.utils.task import decode_list_tasks_cursor, encode_list_tasks_cursor
from coordination.audit.events import AuditRow
from coordination.audit.sql import insert_audit
from coordination.clock import Clock, SystemClock
from coordination.store.tables import sessions, task_index

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

#: SQLSTATEs the SDK also retries: deadlock detected and serialization failure.
_TRANSIENT_SQLSTATES = frozenset({"40P01", "40001"})
_TRANSIENT_RETRY_DELAY_S = 0.02

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


class IndexConflict(Exception):
    """A `transition` carried an `index_expect` that the `task_index` row did not satisfy (for
    example, the atomic claim of a card task lost to another session). Nothing was written."""

    def __init__(self, task_id: str) -> None:
        super().__init__(f"task {task_id}: the task_index row no longer matches what was expected")
        self.task_id = task_id


#: Builds the audit rows of one transition from the task before and after it. It runs once per
#: compare-and-swap attempt, inside `transition`, and must be free of side effects.
AuditBuilder = Callable[[pb.Task, pb.Task], Sequence[AuditRow]]

#: Builds the `task_index` change of one transition from the task before and after it, for a
#: change that depends on what the transition found (it runs once per attempt, like `AuditBuilder`).
IndexUpdateBuilder = Callable[[pb.Task, pb.Task], Mapping[str, Any]]


@dataclass(frozen=True)
class Viewer:
    """Who is asking. `principal` is what `task_index.from_principal` holds for tasks it sent."""

    principal: str
    card_id: str | None = None  # local-harness keys carry their card; remote-peer keys do not
    #: True for local-harness keys only: tasks with `coord.origin = import` have no index row and
    #: are visible to every local-harness key and to nobody else (spec 3.3.3).
    sees_import: bool = False


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
    next_offer_at: datetime | None = None


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
    before: pb.Task  # the task as read, before `mutate`


@dataclass(frozen=True)
class PendingCounts:
    """What is waiting for one session, by SQL count (no task bodies). See `count_pending`."""

    own_submitted: int  # SUBMITTED tasks bound to the handle
    queued_card: int  # unclaimed SUBMITTED tasks of the handle's card
    own_wakeable: int  # of own_submitted: offer_count 0, or due again and under the offer cap
    queued_wakeable: int  # of queued_card: due and under the offer cap


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


def visible_to(viewer: Viewer, task_model: Any = None) -> sa.ColumnElement[bool]:
    """The SQL condition on `task_index` for "this viewer may see the task".

    `task_index` must be OUTER-joined to the tasks table: an import-origin task has no index row.
    `task_model` is needed only when `viewer.sees_import` is set.
    """
    clauses: list[sa.ColumnElement[bool]] = [task_index.c.from_principal == viewer.principal]
    if viewer.card_id is not None:
        clauses.append(sa.and_(task_index.c.to_card == viewer.card_id, task_index.c.hold.is_(None)))
    if viewer.sees_import:
        if task_model is None:
            raise ValueError("visible_to needs the task model to evaluate import visibility")
        clauses.append(
            sa.and_(
                task_index.c.task_id.is_(None),
                task_model.task_metadata["coord"]["origin"].as_string() == "import",
            )
        )
    return clauses[0] if len(clauses) == 1 else sa.or_(*clauses)


def _is_transient(error: DBAPIError) -> bool:
    return isinstance(error, OperationalError) or getattr(error.orig, "sqlstate", None) in _TRANSIENT_SQLSTATES


def _as_int(version: TaskVersion) -> int:
    value = version._value  # noqa: SLF001 - the SDK's own helper does the same
    if not isinstance(value, int):
        raise TypeError(f"integer task versions only, got {type(value).__name__}")
    return value


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

    async def create(
        self, task: pb.Task, entry: IndexEntry, *, audit_rows: Sequence[AuditRow] = ()
    ) -> TaskVersion:
        """Store a new task, its version row (1), its index row and its audit rows in one
        transaction (Z6): a failed audit insert leaves no task, no version and no index row.

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
                        next_offer_at=entry.next_offer_at,
                    )
                )
                for row in audit_rows:
                    await insert_audit(session, row)
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
            stmt = stmt.outerjoin(task_index, task_index.c.task_id == tm.id).where(visible_to(viewer, tm))
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

    async def get_indexes(self, task_ids: Collection[str]) -> dict[str, IndexRow]:
        """Index rows for several tasks at once (a task with none, an import, is absent)."""
        if not task_ids:
            return {}
        async with self._maker() as session:
            rows = (await session.execute(sa.select(task_index).where(task_index.c.task_id.in_(list(task_ids))))).all()
        return {r.task_id: IndexRow(**r._mapping) for r in rows}

    async def list(self, params: pb.ListTasksRequest, viewer: Viewer) -> pb.ListTasksResponse:
        """`ListTasks` restricted to what `viewer` may see, newest first, with the SDK's cursor."""
        tm = self._tm
        stamp = tm.last_updated
        base = (
            sa.select(tm)
            .outerjoin(task_index, task_index.c.task_id == tm.id)
            .where(tm.owner == OWNER, visible_to(viewer, tm))
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
        index_update: Mapping[str, Any] | IndexUpdateBuilder | None = None,
        index_expect: Mapping[str, Any] | None = None,
        audit: AuditBuilder | None = None,
    ) -> TransitionResult:
        """Move a task on, by compare-and-swap. The only way a stored task changes.

        Reads the task and its version, refuses unless its state is in `allowed_from`, applies
        `mutate` to a copy, stamps the status timestamp from the clock, and writes ONE transaction
        holding: the version bump (the compare-and-swap, on the version it read), the task, the
        `index_update` on `task_index` (a mapping, or a builder called with the task before and after) and the rows `audit(before, after)` returns (decision Z6,
        2026-11-15). Any failure in any of them, a failed audit insert included, rolls all of them
        back: state, version, index and audit are never out of step, and a crash cannot leave the
        new state with the old index row.

        If another writer got in first the version check fails, and this re-reads and checks again:
        a loser that finds the task terminal gets `TransitionRefused`, never a silent overwrite.
        `mutate` and `audit` therefore run once per attempt and must be free of side effects.

        `index_expect` makes the index change a compare-and-set inside the same transaction: if the
        index row does not hold the named values, nothing is written and `IndexConflict` is
        raised (the atomic claim of a card-addressed task, together with its state change).

        Raises `TaskNotFound`, `TransitionRefused` (carries the current state), `IndexConflict`
        or `TransitionContention`; whatever `mutate` or `audit` raises passes through untouched.
        """
        if isinstance(index_update, Mapping):
            self._check_index_columns(index_update)
        lost = transient = 0  # lost compare-and-swaps, and transient DB errors (own small allowance)
        while lost < self._max_cas_attempts:
            stored = await self.get(task_id, viewer)
            if stored is None:
                raise TaskNotFound(task_id)
            before_state = stored.task.status.state
            if before_state not in allowed_from:
                raise TransitionRefused(task_id, before_state)
            task = stored.task  # `get` builds a fresh message each time; safe to mutate
            before = pb.Task()
            before.CopyFrom(task)
            mutate(task)
            task.status.timestamp.FromDatetime(self._clock.now())
            rows = tuple(audit(before, task)) if audit is not None else ()
            index_values = index_update(before, task) if callable(index_update) else index_update
            if callable(index_update) and index_values:
                self._check_index_columns(index_values)
            try:
                version = await self._write_transition(task, stored.version, index_values, index_expect, rows)
            except ConcurrentTaskModificationError:
                lost += 1
                continue
            except DBAPIError as exc:
                transient += 1
                if _is_transient(exc) and transient <= 4:
                    await asyncio.sleep(_TRANSIENT_RETRY_DELAY_S * transient)
                    continue
                raise
            return TransitionResult(task, version, before_state, before)
        raise TransitionContention(f"task {task_id}: lost {self._max_cas_attempts} compare-and-swaps in a row")

    async def _write_transition(
        self,
        task: pb.Task,
        prev_version: TaskVersion,
        index_update: Mapping[str, Any] | None,
        index_expect: Mapping[str, Any] | None,
        audit_rows: Sequence[AuditRow],
    ) -> TaskVersion:
        """The one transaction of a transition. Raises `ConcurrentTaskModificationError` when the
        version moved since it was read, `IndexConflict` when `index_expect` is not met."""
        async with self._maker.begin() as session:
            # The version row is locked before the task row, as in the SDK's own save, so two
            # writers of one task cannot deadlock.
            if prev_version.is_missing:
                new_version = 1
                await self._versioned._insert_version(session, task.id, OWNER, new_version)  # noqa: SLF001
            else:
                new_version = _as_int(prev_version) + 1
                result = await session.execute(
                    sa.update(TaskVersionModel)
                    .where(
                        TaskVersionModel.task_id == task.id,
                        TaskVersionModel.owner == OWNER,
                        TaskVersionModel.version == _as_int(prev_version),
                    )
                    .values(version=new_version)
                )
                if result.rowcount == 0:
                    raise ConcurrentTaskModificationError(task.id)
            await session.merge(self._db._to_orm(task, OWNER))  # noqa: SLF001
            if index_update:
                if not await self._apply_index(session, task.id, index_update, index_expect):
                    raise IndexConflict(task.id)
            for row in audit_rows:
                await insert_audit(session, row)
        return TaskVersion(new_version)

    @staticmethod
    def _check_index_columns(values: Mapping[str, Any]) -> None:
        unknown = set(values) - MUTABLE_INDEX_COLUMNS
        if unknown:
            raise ValueError(f"task_index column(s) not changeable: {', '.join(sorted(unknown))}")

    @staticmethod
    async def _apply_index(
        session: AsyncSession,
        task_id: str,
        values: Mapping[str, Any],
        expect: Mapping[str, Any] | None,
    ) -> bool:
        stmt = sa.update(task_index).where(task_index.c.task_id == task_id).values(**values)
        for column, wanted in (expect or {}).items():
            col = task_index.c[column]
            stmt = stmt.where(col.is_(None) if wanted is None else col == wanted)
        return (await session.execute(stmt)).rowcount > 0

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
        `update_index(id, {"to_handle": me}, expect={"to_handle": None})`. This is for index-only
        changes (recording an offer, a claim, re-queueing); a change that goes with a state change
        belongs in `transition(index_update=...)`.
        """
        self._check_index_columns(values)
        if not values:
            return False
        async with self._maker.begin() as session:
            return await self._apply_index(session, task_id, values, expect)

    # -- service-layer queries --------------------------------------------------------------

    async def count_held(self, principal: str) -> int:
        """Tasks `principal` sent that are held right now (hold set, still `INPUT_REQUIRED`)."""
        stmt = (
            sa.select(sa.func.count())
            .select_from(task_index.join(self._tm.__table__, self._tm.id == task_index.c.task_id))
            .where(
                task_index.c.from_principal == principal,
                task_index.c.hold.is_not(None),
                self._tm.status["state"].as_string() == S.Name(S.TASK_STATE_INPUT_REQUIRED),
            )
        )
        async with self._maker() as session:
            return (await session.execute(stmt)).scalar_one()

    async def count_held_for_card(self, card_id: str) -> int:
        """Held tasks addressed to `card_id`, for the "held for review" count. No bodies."""
        stmt = (
            sa.select(sa.func.count())
            .select_from(task_index.join(self._tm.__table__, self._tm.id == task_index.c.task_id))
            .where(
                task_index.c.to_card == card_id,
                task_index.c.hold.is_not(None),
                self._tm.status["state"].as_string() == S.Name(S.TASK_STATE_INPUT_REQUIRED),
            )
        )
        async with self._maker() as session:
            return (await session.execute(stmt)).scalar_one()

    async def held_tasks(self, card_id: str | None = None, limit: int = 200) -> list[tuple[pb.Task, IndexRow]]:
        """Held tasks, oldest first, for the admin review. `viewer=None` trust: admin socket only."""
        stmt = (
            sa.select(self._tm, task_index)
            .join(task_index, task_index.c.task_id == self._tm.id)
            .where(
                task_index.c.hold.is_not(None),
                self._tm.status["state"].as_string() == S.Name(S.TASK_STATE_INPUT_REQUIRED),
            )
            .order_by(self._tm.last_updated, self._tm.id)
            .limit(limit)
        )
        if card_id is not None:
            stmt = stmt.where(task_index.c.to_card == card_id)
        return await self._rows_with_tasks(stmt)

    async def context_owners(self, context_id: str) -> set[tuple[str, str | None]]:
        """(originator principal, recipient card) pairs that already use `context_id`."""
        stmt = (
            sa.select(task_index.c.from_principal, task_index.c.to_card)
            .join(self._tm.__table__, self._tm.id == task_index.c.task_id)
            .where(self._tm.context_id == context_id)
            .distinct()
        )
        async with self._maker() as session:
            return {(r[0], r[1]) for r in (await session.execute(stmt)).all()}

    async def inbox_rows(self, handle: str, card_id: str, limit: int = 200) -> list[tuple[pb.Task, IndexRow]]:
        """What `a2a_inbox` may list for a session, oldest first, never a held task:

        - `SUBMITTED` tasks bound to `handle`;
        - unclaimed `SUBMITTED` card-addressed tasks of `card_id` (the card-level queue);
        - `WORKING` tasks bound to `handle` (the caller keeps the ones with unread follow-ups).
        """
        ix, tm = task_index, self._tm
        submitted = S.Name(S.TASK_STATE_SUBMITTED)
        state = tm.status["state"].as_string()
        own = sa.and_(ix.c.to_handle == handle, state.in_([submitted, S.Name(S.TASK_STATE_WORKING)]))
        queued = sa.and_(
            ix.c.to_card == card_id, ix.c.addressing == "card", ix.c.to_handle.is_(None), state == submitted
        )
        stmt = (
            sa.select(tm, ix)
            .join(ix, ix.c.task_id == tm.id)
            .where(ix.c.hold.is_(None), sa.or_(own, queued))
            .order_by(tm.last_updated, tm.id)
            .limit(limit)
        )
        return await self._rows_with_tasks(stmt)

    async def count_pending(self, handle: str, card_id: str, now: datetime, reoffer_max: int) -> PendingCounts:
        """Counts for `pending_count` and the wake rule (spec 7.4, 7.5), by SQL, no bodies."""
        ix, tm = task_index, self._tm
        submitted = tm.status["state"].as_string() == S.Name(S.TASK_STATE_SUBMITTED)
        own = sa.and_(ix.c.to_handle == handle, ix.c.hold.is_(None), submitted)
        queued = sa.and_(
            ix.c.to_card == card_id, ix.c.addressing == "card", ix.c.to_handle.is_(None), ix.c.hold.is_(None), submitted
        )
        under_cap = ix.c.offer_count < reoffer_max
        due = sa.or_(ix.c.next_offer_at.is_(None), ix.c.next_offer_at <= now)
        own_wake = sa.and_(own, sa.or_(ix.c.offer_count == 0, sa.and_(due, under_cap)))
        queued_wake = sa.and_(queued, due, under_cap)

        def count(cond: sa.ColumnElement[bool]) -> sa.ColumnElement[int]:
            return sa.func.coalesce(sa.func.sum(sa.case((cond, 1), else_=0)), 0)

        stmt = (
            sa.select(count(own), count(queued), count(own_wake), count(queued_wake))
            .select_from(ix.join(tm.__table__, tm.id == ix.c.task_id))
            .where(sa.or_(own, queued))
        )
        async with self._maker() as session:
            a, b, c, d = (await session.execute(stmt)).one()
        return PendingCounts(int(a), int(b), int(c), int(d))

    async def working_for_handle(self, handle: str) -> list[pb.Task]:
        """`WORKING` tasks bound to `handle` (a small set); the caller reads the unread flags."""
        stmt = (
            sa.select(self._tm)
            .join(task_index, task_index.c.task_id == self._tm.id)
            .where(
                task_index.c.to_handle == handle,
                task_index.c.hold.is_(None),
                self._tm.status["state"].as_string() == S.Name(S.TASK_STATE_WORKING),
            )
        )
        async with self._maker() as session:
            return [self._db._from_orm(r) for r in (await session.execute(stmt)).scalars()]  # noqa: SLF001

    # -- sweep queries ----------------------------------------------------------------------

    async def expired(self, now: datetime, limit: int) -> list[tuple[str, str | None]]:
        """(task id, hold) of tasks past their `expires_at`: unconfirmed `SUBMITTED` ones and held
        ones. A real `INPUT_REQUIRED` (a clarification question) has no expiry and is never named."""
        ix, tm = task_index, self._tm
        state = tm.status["state"].as_string()
        stmt = (
            sa.select(ix.c.task_id, ix.c.hold)
            .join(tm.__table__, tm.id == ix.c.task_id)
            .where(
                ix.c.expires_at.is_not(None),
                ix.c.expires_at <= now,
                sa.or_(
                    state == S.Name(S.TASK_STATE_SUBMITTED),
                    sa.and_(state == S.Name(S.TASK_STATE_INPUT_REQUIRED), ix.c.hold.is_not(None)),
                ),
            )
            .order_by(ix.c.expires_at)
            .limit(limit)
        )
        async with self._maker() as session:
            return [(r[0], r[1]) for r in (await session.execute(stmt)).all()]

    async def working_of_ended_sessions(self, ended_before: datetime, limit: int) -> list[str]:
        """Ids of `WORKING` tasks whose session ended before `ended_before` (spec 6.2: a WORKING
        task of an ended session becomes FAILED after `A2A_WORKING_TTL_H`)."""
        ix, tm = task_index, self._tm
        stmt = (
            sa.select(ix.c.task_id)
            .join(tm.__table__, tm.id == ix.c.task_id)
            .join(sessions, sessions.c.handle == ix.c.to_handle)
            .where(
                tm.status["state"].as_string() == S.Name(S.TASK_STATE_WORKING),
                sessions.c.ended_at.is_not(None),
                sessions.c.ended_at <= ended_before,
            )
            .order_by(sessions.c.ended_at)
            .limit(limit)
        )
        async with self._maker() as session:
            return list((await session.execute(stmt)).scalars())

    async def requeue_due(self, now: datetime, limit: int) -> list[tuple[str, str]]:
        """(task id, handle) of card-addressed `SUBMITTED` tasks routed to a session whose offer
        window has run out unconfirmed (`next_offer_at` passed): they go back to the card queue."""
        ix, tm = task_index, self._tm
        stmt = (
            sa.select(ix.c.task_id, ix.c.to_handle)
            .join(tm.__table__, tm.id == ix.c.task_id)
            .where(
                ix.c.addressing == "card",
                ix.c.to_handle.is_not(None),
                ix.c.hold.is_(None),
                ix.c.next_offer_at.is_not(None),
                ix.c.next_offer_at <= now,
                tm.status["state"].as_string() == S.Name(S.TASK_STATE_SUBMITTED),
            )
            .order_by(ix.c.next_offer_at)
            .limit(limit)
        )
        async with self._maker() as session:
            return [(r[0], r[1]) for r in (await session.execute(stmt)).all()]

    async def _rows_with_tasks(self, stmt: sa.Select[Any]) -> list[tuple[pb.Task, IndexRow]]:
        async with self._maker() as session:
            rows = (await session.execute(stmt)).all()
        out: list[tuple[pb.Task, IndexRow]] = []
        for row in rows:
            task_row, *rest = row
            index_values = dict(zip(task_index.c.keys(), rest, strict=True))
            out.append((self._db._from_orm(task_row), IndexRow(**index_values)))  # noqa: SLF001
        return out

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
