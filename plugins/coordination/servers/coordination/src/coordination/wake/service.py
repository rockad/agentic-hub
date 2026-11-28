"""`WakeService`: the server side of the wake protocol (S1-WAKE; spec 7).

What it does, in one place, behind the HTTP routes and the notifier the service layer calls:

- parks a listener (`listen`) and answers it `200` with a count when a wake is due, `408` at the
  round end, or whatever ends it first (superseded, key revoked, session ended, shutdown);
- decides a wake (`try_wake`): the handle must have a wake pending (spec 7.4), no wake of its own
  may be in flight (sent and neither confirmed nor older than 120 s), it must be inside the budget
  of `A2A_WAKE_BUDGET_PER_H` per rolling hour (spec 7.3), and the anti-loop rule must not have
  stopped this pending set (spec 7.4);
- confirms a wake (`confirm`, spec 7.5) when the same handle shows up;
- answers `/wake/pending` with the count and the `announce` dedupe (spec 7.5).

No task text ever reaches this module's output: a wake answer is an integer, `/wake/pending` a
count, and the hook string is a constant with one integer in it.

[design] points, each the most conservative reading of a spec that is silent:

- A wake in flight blocks a second `200`. Spec 7.5 says an unconfirmed wake counts as lost after
  120 s and "the next listener then gets an immediate 200"; read the other way round, a listener
  that parks while a wake is in flight (inside 120 s) is not answered at once. It stays parked and
  is checked again when the wake would count as lost. This is what keeps the immediate-`exit 2`
  loop of spec 7.3 from re-waking a session once a second.
- A parked listener is re-checked every `recheck_s` (a task whose re-offer became due, or a wake
  that just counted as lost, sends no notification), and each re-check refreshes the session's
  `last_seen_at` through the registry's throttled `touch`, so a session with a parked listener
  never expires by the idle TTL (identity.md section 6).
- Session resolution for `X-Coord-Session` and `?session=`: the harness session id registered under
  the key's own card, or an agy sub-invocation conversation recorded under it. Never across cards.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import timedelta

from starlette.types import Receive

from coordination.audit import SYSTEM_ACTOR, AuditLog
from coordination.clock import Clock
from coordination.config import Config
from coordination.identity.registry import SessionRegistry
from coordination.service.directory import Session
from coordination.service.protocol import TaskService
from coordination.wake.outcomes import ENDED, GONE, MAX_COUNT, ROUND_END, Release, woken
from coordination.wake.rules import (
    ANTI_LOOP_STREAK,
    MAX_TRACKED,
    Announcer,
    ParkLimiter,
    anti_loop_blocked,
    fingerprint,
)
from coordination.wake.store import BUDGET_WINDOW, WakeStore
from coordination.wake.table import ListenerTable, Parked

log = logging.getLogger("coordination.wake")

#: Spec 7.5: a wake with no confirmation inside this window counts as lost.
CONFIRM_WINDOW = timedelta(seconds=120)
#: [design] How often a parked listener looks again for a wake that no notification announced.
RECHECK_S = 20.0


@dataclass(frozen=True)
class PendingView:
    """What `/wake/pending` says about one handle."""

    pending: int
    announce: bool
    held_for_review: int
    #: AW1 (Z23): a listener of this handle is parked right now.
    listening: bool = False
    #: AW1 (Z23): the session has opted in to idle wake (`sessions.wake_opted_in` is set).
    wake_opted_in: bool = False
    #: AW1 (Z23): with `announce=1`, tell the session to re-arm its listener now (opted in, not
    #: listening, not told within the announce window).
    rearm: bool = False


class WakeService:
    def __init__(
        self,
        config: Config,
        clock: Clock,
        store: WakeStore,
        registry: SessionRegistry,
        table: ListenerTable,
        *,
        audit: AuditLog | None = None,
        recheck_s: float = RECHECK_S,
        announcer: Announcer | None = None,
        park_limiter: ParkLimiter | None = None,
    ) -> None:
        self._config = config
        self._clock = clock
        self._store = store
        self._registry = registry
        self.table = table
        self._audit = audit
        self._recheck_s = recheck_s
        self._announcer = announcer if announcer is not None else Announcer()
        self._parks = park_limiter if park_limiter is not None else ParkLimiter()
        self._service: TaskService | None = None
        self._exhausted: set[str] = set()  # handles whose budget exhaustion is already in `audit`
        self._stopped: set[tuple[str, str]] = set()  # (handle, set key) anti-loop stops already logged

    def bind(self, service: TaskService) -> None:
        """Give the wake service the task service. It is built after the notifier (the service
        takes the notifier at construction), so this is the second half of the wiring."""
        self._service = service

    @property
    def _svc(self) -> TaskService:
        if self._service is None:
            raise RuntimeError("WakeService is not bound to a task service")
        return self._service

    # -- sessions --------------------------------------------------------------------------

    async def resolve(self, card_id: str, harness_session_id: str) -> Session | None:
        """The session a hook's session id names, under the key's own card: a registered session,
        else an agy sub-invocation recorded under its root. None if it is unknown."""
        session = await self._registry.by_harness_session(card_id, harness_session_id)
        if session is None:
            link = await self._registry.conversation(card_id, harness_session_id)
            if link is not None:
                session = await self._registry.by_handle(link.handle)
        return session

    # -- the notifier (service layer -> wake) ----------------------------------------------

    async def notify_pending(self, handle: str) -> None:
        """`Notifier`: work arrived for `handle`. Wakes its parked listener if the rules allow;
        otherwise nothing happens (no listener, over budget, in flight, stopped). No content."""
        entry = self.table.get(handle)
        if entry is not None:
            await self.try_wake(entry)

    # -- deciding a wake -------------------------------------------------------------------

    async def try_wake(self, entry: Parked) -> float | None:
        """Answer `entry` `200` if a wake is due. Returns None when there is nothing time-based
        to wait for, else the seconds after which the decision may change (a wake in flight)."""
        async with entry.lock:
            if entry.done:
                return None
            handle = entry.handle
            snapshot = await self._svc.wake_snapshot(handle)
            wake_set = snapshot.ids
            if not wake_set:
                return None
            now = self._clock.now()
            rows = await self._store.recent(handle, now - BUDGET_WINDOW)
            if rows and rows[0].confirmed_at is None:
                remaining = (rows[0].at + CONFIRM_WINDOW - now).total_seconds()
                if remaining > 0:
                    return remaining  # a wake is in flight; it may still be confirmed
            if len(rows) >= self._config.wake_budget_per_h:
                await self._budget_exhausted(handle)
                return None
            self._exhausted.discard(handle)
            key = fingerprint(wake_set)
            if anti_loop_blocked(await self._store.latest(handle, ANTI_LOOP_STREAK), key, now):
                if (handle, key) not in self._stopped:
                    if len(self._stopped) >= MAX_TRACKED:
                        self._stopped.clear()
                    self._stopped.add((handle, key))
                    log.warning("wakes stopped for an unconfirmed pending set")  # no handle in the log, as in identity
                return None
            self._stopped.discard((handle, key))
            count = min(max(snapshot.pending, len(wake_set)), MAX_COUNT)
            if entry.done:
                return None
            await self._store.insert(handle, now, count, key)
            entry.release(woken(count))
            await self._audit_wake(handle, count)
            return None

    async def _budget_exhausted(self, handle: str) -> None:
        if len(self._exhausted) >= MAX_TRACKED:
            self._exhausted.clear()  # bounded; at worst one exhaustion is logged twice
        already = handle in self._exhausted
        self._exhausted.add(handle)
        if already or self._audit is None:
            return
        try:
            await self._audit.budget_exhausted(actor=SYSTEM_ACTOR, handle=handle, budget_per_h=self._config.wake_budget_per_h)
        except Exception as exc:  # noqa: BLE001 - the decision stands; only its log line failed
            log.warning("budget audit failed", extra={"fields": {"error": type(exc).__name__}})

    async def _audit_wake(self, handle: str, count: int) -> None:
        if self._audit is None:
            return
        try:
            await self._audit.wake_sent(actor=SYSTEM_ACTOR, handle=handle, pending_n=count)
        except Exception as exc:  # noqa: BLE001 - the wake is already sent
            log.warning("wake audit failed", extra={"fields": {"error": type(exc).__name__}})

    # -- parking ---------------------------------------------------------------------------

    def park_delay(self, handle: str) -> float | None:
        """None if `handle` may park now (and the park is counted), else the `Retry-After`."""
        return self._parks.check(handle, self._clock.monotonic())

    async def listen(self, entry: Parked, wait_s: float, receive: Receive) -> Release:
        """Hold `entry` for up to `wait_s` real seconds and return the `Release` that ends it.

        Answers at once if a wake is already due, re-checks every `recheck_s`, and gives up quietly
        (returns `GONE`) if the client hangs up. The entry always leaves the table."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait_s
        gone = asyncio.ensure_future(_until_disconnect(receive))
        try:
            hint = await self._check(entry)
            while True:
                if entry.done:
                    return entry.future.result()
                remaining = deadline - loop.time()
                if remaining <= 0:
                    entry.release(ROUND_END)
                    return entry.future.result()
                step = min(remaining, self._recheck_s, hint if hint is not None else remaining)
                await asyncio.wait({entry.future, gone}, timeout=max(step, 0.0), return_when=asyncio.FIRST_COMPLETED)
                if entry.done:
                    return entry.future.result()
                if gone.done():
                    entry.release(GONE)
                    return GONE
                hint = await self._check(entry)
        finally:
            self.table.remove(entry)
            gone.cancel()

    async def _check(self, entry: Parked) -> float | None:
        """One look for a parked listener: alive and refreshed, still a live session, a wake due."""
        try:
            session = await self._registry.by_handle(entry.handle)
            if session is None or session.ended:
                entry.release(ENDED)
                return None
            await self._registry.touch(entry.handle)
            return await self.try_wake(entry)
        except Exception as exc:  # noqa: BLE001 - a failed look must not drop a parked listener
            log.warning("wake check failed", extra={"fields": {"error": type(exc).__name__}})
            return None

    # -- confirmation ----------------------------------------------------------------------

    async def confirm(self, handle: str) -> int:
        """Spec 7.5: the handle called `a2a_inbox`, `a2a_wait` or `a2a_hello`, or hit
        `/wake/pending`. Marks its unconfirmed wakes of the last 120 s confirmed; returns how many.
        Never raises into the caller's request: a failure is logged and counts as zero."""
        now = self._clock.now()
        try:
            n = await self._store.confirm(handle, now, CONFIRM_WINDOW)
        except Exception as exc:  # noqa: BLE001
            log.warning("wake confirmation failed", extra={"fields": {"error": type(exc).__name__}})
            return 0
        return n

    # -- /wake/pending ---------------------------------------------------------------------

    async def pending(self, session: Session, *, announce: bool) -> PendingView:
        """The count for `session`, no bodies, no offers recorded (spec 7.5). Counts as showing
        up: the session is touched and its in-flight wake is confirmed."""
        handle = session.handle
        await self._registry.touch(handle)
        await self.confirm(handle)
        count = await self._svc.pending_count(handle)
        held = await self._svc.held_count(session.card_id)
        say = self._announcer.check(handle, count, self._clock.now(), record=announce) if announce else False
        listening = self.table.is_listening(handle)
        opted_in = session.wake_opted_in is not None
        rearm = False
        if announce:
            # AW1 (Z23): an opted-in session whose listener is gone is told to re-arm it, at most once per
            # announce window; a parked listener (or no opt-in) clears the memory so the next lapse is
            # announced afresh. The count is a constant 1: only the window matters.
            key = handle + "|rearm"
            now = self._clock.now()
            rearm = self._announcer.check(key, 1 if opted_in and not listening else 0, now, record=True)
        return PendingView(count, say, held, listening=listening, wake_opted_in=opted_in, rearm=rearm)

    async def opt_in(self, session: Session) -> None:
        """AW1 (Z23): record the session's first successful park as its opt-in to idle wake. A no-op
        once set. Never raises into the listener's request: a failure is logged and the park goes on."""
        if session.wake_opted_in is not None:
            return
        try:
            await self._registry.set_wake_opted_in(session.handle)
        except Exception as exc:  # noqa: BLE001 - the park must not fail because the flag could not be set
            log.warning("wake opt-in failed", extra={"fields": {"error": type(exc).__name__}})

    def pending_stub(self, count: int) -> str:
        """The hook text: a server constant with one validated integer (spec 7.5, security
        invariants)."""
        return f"[a2a] {min(max(int(count), 1), MAX_COUNT)} pending. Call a2a_inbox."


async def _until_disconnect(receive: Receive) -> None:
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return
