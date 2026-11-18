"""The audit writer: one typed method per event (S1-OBS).

`AuditLog` turns a decision into a validated `AuditRow` and hands it to an `AuditStore`. The
methods take named, identifier-shaped arguments only, so a caller has no parameter to put a
message body in; `events.validate` is the second check.

Auth failures are the one event that is not written per occurrence. `auth_failure()` counts
them and the writer emits a single `auth_failure_sampled` row per window with the count
(spec 2.1: "logged in `audit` as a sampled count, not one row per request"). A window's row is
written when the next failure arrives after the window has closed, or when `flush_auth_failures`
is called. The server should call `flush_auth_failures()` on a timer and at shutdown so the last
window of a burst is not left pending; that wiring belongs to the stream that owns the app
lifespan.

Actors are strings: a key id, a handle, `system` for the server's own timers, or the admin
socket's caller. What an actor looks like is [design] and not checked beyond "not empty".
"""

from __future__ import annotations

from datetime import datetime

from coordination.audit.events import ENDED_VIA, REGISTERED_VIA, AuditEvent, AuditRow, make_row
from coordination.audit.protocol import AuditStore
from coordination.clock import Clock

SYSTEM_ACTOR = "system"
#: Length of the auth-failure sampling window. [design]: the spec says "sampled count" only.
DEFAULT_AUTH_FAILURE_WINDOW_S = 60.0

#: Task states a transition may name: the A2A 1.0.1 enum names used here plus our `QUARANTINED`
#: extension (AGENTS.md). `TASK_STATE_AUTH_REQUIRED` is never produced. `from_state` may be None
#: for the row that records a task's creation [design].
TASK_STATES = frozenset(
    {
        "TASK_STATE_SUBMITTED",
        "TASK_STATE_WORKING",
        "TASK_STATE_INPUT_REQUIRED",
        "TASK_STATE_COMPLETED",
        "TASK_STATE_CANCELED",
        "TASK_STATE_FAILED",
        "TASK_STATE_REJECTED",
        "QUARANTINED",
    }
)


class AuditLog:
    def __init__(
        self,
        store: AuditStore,
        clock: Clock,
        *,
        auth_failure_window_s: float = DEFAULT_AUTH_FAILURE_WINDOW_S,
    ) -> None:
        if auth_failure_window_s <= 0:
            raise ValueError("auth_failure_window_s must be positive")
        self._store = store
        self._clock = clock
        self._window_s = auth_failure_window_s
        self._failures = 0
        self._window_start_m = 0.0
        self._window_start_at: datetime | None = None

    async def _write(
        self, event: AuditEvent, actor: str, subject: str | None = None, **detail: object
    ) -> AuditRow:
        row = make_row(self._clock.now(), event, actor, subject, **detail)
        await self._store.append_audit(row)
        return row

    # key lifecycle -------------------------------------------------------------------------

    async def key_created(self, *, actor: str, key_id: str, scope: str) -> AuditRow:
        return await self._write(AuditEvent.KEY_CREATED, actor, key_id, key_id=key_id, scope=scope)

    async def key_rotated(self, *, actor: str, key_id: str, new_key_id: str) -> AuditRow:
        return await self._write(
            AuditEvent.KEY_ROTATED, actor, key_id, key_id=key_id, new_key_id=new_key_id
        )

    async def key_revoked(self, *, actor: str, key_id: str) -> AuditRow:
        return await self._write(AuditEvent.KEY_REVOKED, actor, key_id, key_id=key_id)

    # sessions and wakes --------------------------------------------------------------------

    async def session_registered(
        self, *, actor: str, handle: str, card_id: str, via: str, revived: bool = False
    ) -> AuditRow:
        """A session was created (`revived` false) or an ended one came back (`revived` true).
        `via` is `hook` (`POST /sessions`), `hello` (`a2a_hello`) or `auto_agy` (an unseen agy
        conversation's first call)."""
        if via not in REGISTERED_VIA:
            raise ValueError(f"unknown registration route {via!r}")
        return await self._write(
            AuditEvent.SESSION_REGISTERED, actor, handle, card_id=card_id, via=via, revived=bool(revived)
        )

    async def session_ended(self, *, actor: str, handle: str, via: str) -> AuditRow:
        """`via` is `explicit` (`POST /sessions/end`) or `idle_ttl` (the idle expiry, actor `system`)."""
        if via not in ENDED_VIA:
            raise ValueError(f"unknown end route {via!r}")
        return await self._write(AuditEvent.SESSION_ENDED, actor, handle, via=via)

    async def session_rebound(
        self, *, actor: str, handle: str, from_binding: str, to_binding: str
    ) -> AuditRow:
        """`a2a_hello` moved `handle` from one `Mcp-Session-Id` to another. The two ids are the
        8-character prefixes of the `Mcp-Session-Id` values, never the full values."""
        return await self._write(
            AuditEvent.SESSION_REBOUND, actor, handle, from_binding=from_binding, to_binding=to_binding
        )

    async def alias_added(self, *, actor: str, handle: str, alias: str) -> AuditRow:
        return await self._write(AuditEvent.ALIAS_ADDED, actor, handle, alias=alias)

    async def wake_sent(self, *, actor: str, handle: str, pending_n: int) -> AuditRow:
        return await self._write(AuditEvent.WAKE_SENT, actor, handle, pending_n=pending_n)

    async def budget_exhausted(
        self, *, actor: str, handle: str, budget_per_h: int
    ) -> AuditRow:
        return await self._write(
            AuditEvent.BUDGET_EXHAUSTED, actor, handle, budget_per_h=budget_per_h
        )

    # holds ---------------------------------------------------------------------------------

    async def hold_entered(self, *, actor: str, task_id: str, origin: str) -> AuditRow:
        return await self._write(AuditEvent.HOLD_ENTERED, actor, task_id, origin=origin)

    async def hold_released(self, *, actor: str, task_id: str) -> AuditRow:
        return await self._write(AuditEvent.HOLD_RELEASED, actor, task_id)

    async def hold_denied(self, *, actor: str, task_id: str) -> AuditRow:
        return await self._write(AuditEvent.HOLD_DENIED, actor, task_id)

    # tasks ---------------------------------------------------------------------------------

    async def state_transition(
        self, *, actor: str, task_id: str, from_state: str | None, to_state: str
    ) -> AuditRow:
        """The one row for one transition. `actor` is who caused it; it is required."""
        row = self.state_transition_row(
            actor=actor, task_id=task_id, from_state=from_state, to_state=to_state
        )
        await self._store.append_audit(row)
        return row

    # Row builders. They validate and stamp a row but write nothing, so the state machine can hand
    # the rows to `CoordTaskStore`, which writes them in the same transaction as the task (Z6).

    def state_transition_row(
        self, *, actor: str, task_id: str, from_state: str | None, to_state: str
    ) -> AuditRow:
        if to_state not in TASK_STATES or (from_state is not None and from_state not in TASK_STATES):
            raise ValueError(f"unknown task state in transition {from_state!r} -> {to_state!r}")
        return make_row(
            self._clock.now(),
            AuditEvent.STATE_TRANSITION,
            actor,
            task_id,
            task_id=task_id,
            from_state=from_state,
            to_state=to_state,
        )

    def hold_entered_row(self, *, actor: str, task_id: str, origin: str) -> AuditRow:
        return make_row(self._clock.now(), AuditEvent.HOLD_ENTERED, actor, task_id, origin=origin)

    def hold_released_row(self, *, actor: str, task_id: str) -> AuditRow:
        return make_row(self._clock.now(), AuditEvent.HOLD_RELEASED, actor, task_id)

    def hold_denied_row(self, *, actor: str, task_id: str) -> AuditRow:
        return make_row(self._clock.now(), AuditEvent.HOLD_DENIED, actor, task_id)

    async def handle_probe_limited(
        self, *, actor: str, key_id: str, window_count: int
    ) -> AuditRow:
        """Guess counter trip for a remote-peer key: one row per trip (spec 1.3, 5.2)."""
        return await self._write(
            AuditEvent.HANDLE_PROBE_LIMITED, actor, key_id, key_id=key_id, window_count=window_count
        )

    # sampled auth failures -----------------------------------------------------------------

    def _take_due_window(self, *, force: bool = False) -> AuditRow | None:
        """Close the open window if it is due and build its row. Synchronous, so no await can
        interleave between reading and resetting the counter."""
        if self._failures == 0:
            return None
        if not force and self._clock.monotonic() - self._window_start_m < self._window_s:
            return None
        assert self._window_start_at is not None
        row = make_row(
            self._clock.now(),
            AuditEvent.AUTH_FAILURE_SAMPLED,
            SYSTEM_ACTOR,
            None,
            count=self._failures,
            window_s=self._window_s,
            window_started_at=self._window_start_at.isoformat(),
        )
        self._failures = 0
        self._window_start_at = None
        return row

    async def auth_failure(self) -> AuditRow | None:
        """Count one failed authentication. Returns the sampled row if this call closed a
        window (and wrote it), otherwise None. Never writes one row per failure."""
        due = self._take_due_window()
        if self._failures == 0:
            self._window_start_m = self._clock.monotonic()
            self._window_start_at = self._clock.now()
        self._failures += 1
        if due is not None:
            await self._store.append_audit(due)
        return due

    async def flush_auth_failures(self, *, force: bool = False) -> AuditRow | None:
        """Write the open window's row if it is due (or `force`, for shutdown)."""
        due = self._take_due_window(force=force)
        if due is not None:
            await self._store.append_audit(due)
        return due
