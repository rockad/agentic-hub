"""`CoordinationService`: all task behaviour, called identically by `/a2a/v1` and `/mcp` (S1-STATE).

A plain async API. It knows nothing of HTTP, MCP sessions or JSON-RPC: the bindings authenticate,
build a `Caller` from the API key (never from the body), call a method here, and translate the
`ServiceError` it raises. Nothing here is wired into `app.py`.

Where each rule of the spec lives:

- State machine (6.2): `states.TRANSITIONS`; every state change goes through `_transition`, which
  checks the (from, to, actor) triple against that table INSIDE the compare-and-swap, so a race
  cannot sneak a change past it. A transition, its `task_index` change and its audit rows are one
  database transaction (decision Z6): see `CoordTaskStore.transition`.
- Trust by origin (6.3, D10, D19): local gives `SUBMITTED`; a remote-peer key gives a held task
  (`QUARANTINED`, stored as `INPUT_REQUIRED` plus `coord.hold`); the only way out of a hold is
  `release_hold` or `deny_hold`, called by the admin socket with a human actor, or the TTL sweep
  (expiry goes to `REJECTED`, never released). No agent, rule or timer releases a hold.
- Routing (5.2, D29, D38): a handle goes to that session only; a card goes to the newest
  `listening` session, then the newest `active` one, else it waits in the card queue; a
  card-routed task whose offer window runs out unconfirmed goes back to the queue, and the first
  session whose `inbox` sees it claims it (an atomic compare-and-set on `task_index.to_handle`).
- Offers (6.3): see `offers`. Listing a task in `inbox` records an offer.
- Visibility (3.3.3): originator or recipient card; a held task is never visible to the recipient
  side; a remote peer sees only its own; `coord.origin = import` is visible to local keys only.
  Enforced in SQL by `CoordTaskStore`, the one place a viewer filter lives.
- `message_id` idempotency (3.3): a new task's id is derived from (sender, card, context,
  message_id), so a repeat hits `TaskExists` and returns the first task; a follow-up is checked
  against the task's own history.

Not here, on purpose: the handle-guess counter (built with S2-LISTEN; the "not available" refusal
below is the path it will count), the blocking wait of `SendMessage` and `a2a_wait` (a binding
concern over `get_task`), the per-client-IP limit (the public listener), session registration
(S1-ID) and the wake endpoint (S1-WAKE; this layer only answers its two questions, `pending_count`
and `has_wake_pending`).
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Any

from google.protobuf import json_format

from a2a.types import a2a_pb2 as pb
from coordination.audit.events import AuditRow
from coordination.audit.log import SYSTEM_ACTOR, AuditLog
from coordination.clock import Clock
from coordination.service import coord as C
from coordination.service import offers
from coordination.service.directory import Directory
from coordination.service.errors import (
    AlreadyClaimed,
    CardNotAllowed,
    ContentTypeNotSupported,
    Forbidden,
    InvalidParams,
    InvalidTransition,
    QuotaExceeded,
    SessionNotLive,
    TaskNotCancelable,
    TaskNotFound,
    UnsupportedOperation,
)
from coordination.service.ports import ListenerView, NoListeners
from coordination.service.quotas import MAX_HELD_PER_PEER, SlidingWindowLimiter
from coordination.service.states import (
    AUDIT_NAME,
    HOLD_QUARANTINE,
    RAW,
    TERMINAL,
    Actor,
    State,
    is_allowed,
    logical_state,
    sources,
)
from coordination.service.types import (
    CARD_RE,
    HANDLE_RE,
    Caller,
    InboxItem,
    InboxResult,
    ServiceSettings,
    SweepResult,
    card_of,
    derive_task_id,
)
from coordination.store.task_store import (
    CoordTaskStore,
    IndexConflict,
    IndexEntry,
    IndexRow,
    TaskExists,
    TransitionRefused,
)
from coordination.store.task_store import TaskNotFound as StoreTaskNotFound
from coordination.wake.protocol import Notifier

log = logging.getLogger("coordination.service")

S = pb.TaskState

# Limits of spec 3.3 [design].
MAX_PARTS = 8
MAX_PART_BYTES = 32 * 1024
MAX_HISTORY = 200
MAX_REASON_BYTES = 1024
MAX_MESSAGE_ID = 128
#: `Retry-After` for the held-task quota (spec: "429 with Retry-After", the value is [design]).
HELD_QUOTA_RETRY_AFTER_S = 60

_ACCEPTED_MEDIA = frozenset({"", "text/plain", "application/json"})
_RESPOND_STATES = {
    "working": State.WORKING,
    "input_required": State.INPUT_REQUIRED,
    "completed": State.COMPLETED,
    "failed": State.FAILED,
    "rejected": State.REJECTED,
}


@dataclass(frozen=True)
class _Admission:
    """The first state of a new task and where it is addressed."""

    state: State
    to_card: str | None
    to_handle: str | None
    addressing: str | None  # "handle" or "card"
    hold: str | None = None
    reason: str | None = None
    next_offer_at: datetime | None = None
    expires_at: datetime | None = None


def _struct_dict(struct: Any) -> dict[str, Any]:
    return json_format.MessageToDict(struct) if struct is not None and len(struct) else {}


class CoordinationService:
    def __init__(
        self,
        store: CoordTaskStore,
        directory: Directory,
        audit: AuditLog,
        clock: Clock,
        settings: ServiceSettings | None = None,
        *,
        listeners: ListenerView | None = None,
        notifier: Notifier | None = None,
        limiter: SlidingWindowLimiter | None = None,
    ) -> None:
        self._store = store
        self._dir = directory
        self._audit = audit
        self._clock = clock
        self._s = settings if settings is not None else ServiceSettings()
        self._listeners: ListenerView = listeners if listeners is not None else NoListeners()
        self._notifier = notifier
        self._limiter = limiter if limiter is not None else SlidingWindowLimiter(clock)

    # ======================================================================================
    # SendMessage
    # ======================================================================================

    async def send_message(
        self,
        caller: Caller,
        tenant: str,
        message: pb.Message,
        *,
        metadata: Mapping[str, Any] | None = None,
    ) -> pb.Task:
        """`SendMessage` (spec 3.3.2) and `a2a_send`: create a task, or continue one (6.4).

        `tenant` is the card the request is addressed to; `metadata` is the request's metadata
        as a plain dict (the message's own metadata is read from `message`). Only `coord.to` is
        taken from either; every other `coord.*` a client supplied is dropped.
        """
        if not isinstance(tenant, str) or not CARD_RE.match(tenant):
            raise InvalidParams("tenant must be a card id")
        to = C.client_coord_to(metadata, _struct_dict(message.metadata))
        if to is not None and (not isinstance(to, str) or not HANDLE_RE.match(to)):
            raise InvalidParams("coord.to must be a handle: <card>/<name>~<sid8>")
        self._validate_message(message)
        if message.task_id:
            return await self._follow_up(caller, message)
        return await self._new_task(caller, tenant, message, to)

    def _validate_message(self, message: pb.Message) -> None:
        if message.role != pb.Role.ROLE_USER:
            raise InvalidParams("a client message has role ROLE_USER")
        if not message.message_id or len(message.message_id) > MAX_MESSAGE_ID:
            raise InvalidParams("message_id is required")
        if not 1 <= len(message.parts) <= MAX_PARTS:
            raise InvalidParams(f"a message has 1 to {MAX_PARTS} parts")
        for part in message.parts:
            kind = part.WhichOneof("content")
            if kind not in ("text", "data") or part.media_type not in _ACCEPTED_MEDIA:
                raise ContentTypeNotSupported("only text/plain and application/json parts are accepted")
            size = len(part.text.encode()) if kind == "text" else part.data.ByteSize()
            if size > MAX_PART_BYTES:
                raise InvalidParams(f"a part is at most {MAX_PART_BYTES} bytes")

    async def _new_task(self, caller: Caller, tenant: str, message: pb.Message, to: str | None) -> pb.Task:
        principal = caller.principal
        task_id = derive_task_id(principal, tenant, message.context_id, message.message_id)

        # A repeated `message_id` returns the first task and costs no quota.
        existing = await self._store.get(task_id, caller.viewer)
        if existing is not None:
            return await self._view_of(existing.task)

        if message.context_id:
            others = await self._store.context_owners(message.context_id) - {(principal, tenant)}
            if others:
                raise TaskNotFound("no such task or context")  # a context of someone else: not found

        now = self._clock.now()
        admission = await self._admit(caller, tenant, to, now)

        context_id = message.context_id or str(uuid.uuid4())
        task = pb.Task(id=task_id, context_id=context_id)
        task.status.state = RAW[admission.state]
        first = pb.Message()
        first.CopyFrom(message)
        first.task_id, first.context_id = task_id, context_id
        C.sanitize_message_metadata(first, to if admission.state is not State.REJECTED else None)
        task.history.append(first)
        if admission.state is State.QUARANTINED:
            task.status.message.CopyFrom(_agent_text(task_id, context_id, C.HOLD_STATUS_TEXT))
        elif admission.state is State.REJECTED:
            task.status.message.CopyFrom(_agent_text(task_id, context_id, C.NOT_AVAILABLE_TEXT))
        C.coord_set(
            task,
            **{
                "from": caller.sender_label,
                "origin": caller.origin,
                "hold": admission.hold,
                "to": to if admission.state is not State.REJECTED else None,
                "reason": admission.reason,
                "createdAt": C.iso_z(now),
            },
        )

        rows = [
            self._audit.state_transition_row(
                actor=caller.actor, task_id=task_id, from_state=None, to_state=AUDIT_NAME[admission.state]
            )
        ]
        if admission.state is State.QUARANTINED:
            rows.append(self._audit.hold_entered_row(actor=caller.actor, task_id=task_id, origin=caller.origin))
        entry = IndexEntry(
            from_principal=principal,
            origin=caller.origin,
            to_card=admission.to_card,
            to_handle=admission.to_handle,
            addressing=admission.addressing,
            hold=admission.hold,
            expires_at=admission.expires_at,
            next_offer_at=admission.next_offer_at,
        )
        try:
            await self._store.create(task, entry, audit_rows=rows)
        except TaskExists:  # a concurrent repeat of the same message_id won the insert
            again = await self._store.get(task_id, caller.viewer)
            if again is None:
                raise
            return await self._view_of(again.task)
        index = await self._store.get_index(task_id)
        if admission.state is State.SUBMITTED:
            await self._notify(index)
        return await self._view(task, index)

    async def _admit(self, caller: Caller, tenant: str, to: str | None, now: datetime) -> _Admission:
        """Decide the first state and routing of a new task from the caller and the address."""
        if not caller.local:
            return await self._admit_remote(caller, tenant, to, now)
        if not await self._dir.card_exists(tenant):
            raise InvalidParams("unknown card")
        submitted_expiry = now + timedelta(hours=self._s.submitted_ttl_h)
        if to is not None:
            if card_of(to) != tenant:
                raise InvalidParams("coord.to is not a session of the addressed card")
            if to == caller.handle:
                raise InvalidParams("a session cannot send to its own handle")
            if await self._dir.session(to) is None:
                raise InvalidParams("unknown handle")
            # An ended session is allowed: the task is orphaned (offered to nobody, never
            # redirected) and leaves by TTL or cancel (spec 5.2).
            return _Admission(State.SUBMITTED, tenant, to, "handle", expires_at=submitted_expiry)
        routed, next_offer = await self._route_card(tenant, now, exclude=caller.handle)
        return _Admission(
            State.SUBMITTED, tenant, routed, "card", next_offer_at=next_offer, expires_at=submitted_expiry
        )

    async def _admit_remote(self, caller: Caller, tenant: str, to: str | None, now: datetime) -> _Admission:
        # X3: a card outside `cards_allowed`, and a card that does not exist, are one answer.
        if tenant not in caller.cards_allowed or not await self._dir.card_exists(tenant):
            raise CardNotAllowed("card not allowed")
        wait = self._limiter.hit(caller.principal)
        if wait is not None:
            raise QuotaExceeded("SendMessage rate limit for this peer", wait)
        if to is not None:
            session = await self._dir.session(to)
            if session is None or session.ended or session.card_id != tenant:
                # D-H: unknown, ended and out-of-card handles are one constant refusal. The
                # guess counter (built with S2-LISTEN) counts exactly this path.
                return _Admission(
                    State.REJECTED, None, None, "handle", reason=C.REASON_NOT_ALLOWED
                )
        if await self._store.count_held(caller.principal) >= MAX_HELD_PER_PEER:
            raise QuotaExceeded("held-task quota for this peer", HELD_QUOTA_RETRY_AFTER_S)
        return _Admission(
            State.QUARANTINED,
            tenant,
            to,
            "handle" if to else "card",
            hold=HOLD_QUARANTINE,
            expires_at=now + timedelta(hours=self._s.quarantine_ttl_h),
        )

    async def _route_card(
        self, card_id: str, now: datetime, *, exclude: str | None = None
    ) -> tuple[str | None, datetime]:
        """D29: the newest `listening` session of the card, then the newest `active` one, else the
        card queue. Returns (handle or None, `next_offer_at`): for a routed task the end of the
        offer window (after which it goes back to the queue), for a queued one `now` (claimable)."""
        handle = self._listeners.newest_listening(card_id)
        if handle is None or handle == exclude:
            active = await self._dir.newest_active(card_id, now)
            handle = active.handle if active is not None and active.handle != exclude else None
        if handle is None:
            return None, now
        return handle, now + timedelta(seconds=self._s.reoffer_after_s)

    # -- follow-ups (6.4) ----------------------------------------------------------------

    async def _follow_up(self, caller: Caller, message: pb.Message) -> pb.Task:
        stored = await self._store.get(message.task_id, caller.viewer)
        if stored is None:
            raise TaskNotFound(message.task_id)
        index = await self._store.get_index(message.task_id)
        if index is None or index.from_principal != caller.principal:
            raise Forbidden("only the originator may send a follow-up")
        task = stored.task
        if message.context_id and message.context_id != task.context_id:
            raise InvalidParams("context_id does not match the task")
        state = logical_state(task)
        if state in TERMINAL or state is State.QUARANTINED:
            raise UnsupportedOperation("the task is held or finished")
        if any(m.message_id == message.message_id for m in task.history):
            return await self._view(task, index)  # idempotent repeat
        if len(task.history) >= MAX_HISTORY:
            raise InvalidParams(f"a task keeps at most {MAX_HISTORY} messages")
        if not caller.local:
            wait = self._limiter.hit(caller.principal)
            if wait is not None:
                raise QuotaExceeded("SendMessage rate limit for this peer", wait)

        now = self._clock.now()
        appended = pb.Message()
        appended.CopyFrom(message)
        appended.task_id, appended.context_id = task.id, task.context_id
        C.sanitize_message_metadata(appended, None)
        reoffer = state is State.INPUT_REQUIRED

        def mutate(t: pb.Task) -> None:
            cur = logical_state(t)
            if cur in TERMINAL or cur is State.QUARANTINED:
                raise UnsupportedOperation("the task is held or finished")
            if len(t.history) >= MAX_HISTORY:
                raise InvalidParams(f"a task keeps at most {MAX_HISTORY} messages")
            t.history.append(appended)
            if cur is State.WORKING:
                C.coord_set(t, unread=C.coord_unread(t) + 1)
            elif cur is State.INPUT_REQUIRED:
                # The originator answered a real question: back to SUBMITTED, offered again.
                if not is_allowed(cur, State.SUBMITTED, Actor.ORIGINATOR):
                    raise InvalidTransition("INPUT_REQUIRED to SUBMITTED by originator")
                t.status.state = RAW[State.SUBMITTED]
                t.status.ClearField("message")

        def index_update(before: pb.Task, after: pb.Task) -> Mapping[str, Any]:
            if logical_state(after) is not State.SUBMITTED or logical_state(before) is State.SUBMITTED:
                return {}
            routed = index.addressing == "card" and index.to_handle is not None
            return {
                "offer_count": 0,
                "last_offered_at": None,
                "next_offer_at": now + timedelta(seconds=self._s.reoffer_after_s) if routed else None,
                "expires_at": now + timedelta(hours=self._s.submitted_ttl_h),
            }

        def audit(before: pb.Task, after: pb.Task) -> Sequence[AuditRow]:
            if logical_state(before) is logical_state(after):
                return ()
            return (self._state_row(caller.actor, task.id, before, after),)

        result = await self._guarded_transition(
            task.id,
            allowed_from={S.TASK_STATE_SUBMITTED, S.TASK_STATE_WORKING, S.TASK_STATE_INPUT_REQUIRED},
            mutate=mutate,
            viewer=caller.viewer,
            index_update=index_update if reoffer else None,
            audit=audit,
        )
        fresh = await self._store.get_index(task.id)
        after = logical_state(result.task)
        if after is State.WORKING or (after is State.SUBMITTED and reoffer):
            await self._notify(fresh)
        return await self._view(result.task, fresh)

    # ======================================================================================
    # Reads
    # ======================================================================================

    async def get_task(self, caller: Caller, task_id: str, *, history_length: int | None = None) -> pb.Task:
        """`GetTask` / `a2a_get`. A task the caller may not see is `TaskNotFound`, never a hint."""
        stored = await self._store.get(task_id, caller.viewer)
        if stored is None:
            raise TaskNotFound(task_id)
        view = await self._view_of(stored.task)
        if history_length is not None and history_length >= 0 and len(view.history) > history_length:
            kept = list(view.history)[len(view.history) - history_length :] if history_length else []
            del view.history[:]
            view.history.extend(kept)
        return view

    async def list_tasks(self, caller: Caller, request: pb.ListTasksRequest) -> pb.ListTasksResponse:
        """`ListTasks`: only what the caller may see, newest first, with the SDK's page token."""
        page = request.page_size
        if page and page > 100:
            raise InvalidParams("page_size is at most 100")
        response = await self._store.list(request, caller.viewer)
        indexes = await self._store.get_indexes([t.id for t in response.tasks])
        views = [await self._view(t, indexes.get(t.id)) for t in response.tasks]
        del response.tasks[:]
        response.tasks.extend(views)
        return response

    async def held_tasks(self, card_id: str | None = None) -> list[pb.Task]:
        """Held tasks for the admin review (`a2a-coord review`), oldest first. Admin socket only:
        it is a method of its own, not a `Caller` read, so no API key can reach a held task of
        someone else through it."""
        rows = await self._store.held_tasks(card_id)
        return [await self._view(task, index) for task, index in rows]

    # ======================================================================================
    # Inbox, offers, claims
    # ======================================================================================

    async def inbox(self, caller: Caller, *, limit: int = 10, include_followups: bool = True) -> InboxResult:
        """`a2a_inbox` (spec 4.3): this session's `SUBMITTED` tasks, then the card queue, then
        unread follow-ups. Listing a new task records an offer; listing a queued card task claims
        it first (D29: the first session to call `a2a_inbox` claims it). Held tasks are never
        listed, only counted."""
        handle, card = await self._live_session(caller)
        if not 1 <= limit <= 50:
            raise InvalidParams("limit is 1 to 50")
        now = self._clock.now()
        rows = await self._store.inbox_rows(handle, card)
        own = [(t, i) for t, i in rows if t.status.state == S.TASK_STATE_SUBMITTED and i.to_handle == handle]
        queued = [(t, i) for t, i in rows if t.status.state == S.TASK_STATE_SUBMITTED and i.to_handle is None]
        followups = (
            [(t, i) for t, i in rows if t.status.state == S.TASK_STATE_WORKING and C.coord_unread(t) > 0]
            if include_followups
            else []
        )
        items: list[InboxItem] = []
        for task, index in [*own, *queued, *followups]:
            if len(items) >= limit:
                break
            kind = "followup" if task.status.state == S.TASK_STATE_WORKING else "new"
            if kind == "new":
                n, next_at = offers.after_offer(index.offer_count, now, self._s.reoffer_after_s, self._s.reoffer_max)
                values: dict[str, Any] = {"offer_count": n, "last_offered_at": now, "next_offer_at": next_at}
                expect: dict[str, Any] = {"offer_count": index.offer_count, "hold": None}
                if index.to_handle is None:
                    values["to_handle"] = handle  # the claim
                    expect["to_handle"] = None
                if not await self._store.update_index(task.id, values, expect=expect):
                    continue  # another session claimed it or recorded the offer first
                index = replace(index, offer_count=n, last_offered_at=now, next_offer_at=next_at, to_handle=handle)
            items.append(
                InboxItem(
                    task=await self._view(task, index),
                    kind=kind,
                    addressed_to=index.addressing or "handle",
                    offer_count=index.offer_count,
                    received_at=C.coord_get(task).get("createdAt"),
                    expires_at=index.expires_at,
                )
            )
        return InboxResult(
            items=items,
            pending_total=await self.pending_count(handle),
            held_for_review=await self._store.count_held_for_card(card),
        )

    async def claim(self, caller: Caller, task_id: str) -> pb.Task:
        """Claim an unclaimed card-addressed task for the calling session, atomically. One of two
        concurrent claims wins; the other gets `AlreadyClaimed`. `respond` and `inbox` use the same
        compare-and-set."""
        handle, card = await self._live_session(caller)
        stored = await self._store.get(task_id, caller.viewer)
        index = await self._store.get_index(task_id)
        if stored is None or index is None or index.to_card != card:
            raise TaskNotFound(task_id)
        if index.addressing != "card":
            raise Forbidden("only card-addressed tasks are claimed")
        if index.to_handle == handle:
            return await self._view(stored.task, index)
        if stored.task.status.state != S.TASK_STATE_SUBMITTED:
            raise InvalidTransition("only a SUBMITTED task is claimed")
        won = await self._store.update_index(
            task_id, {"to_handle": handle}, expect={"to_handle": None, "hold": None}
        )
        if not won:
            raise AlreadyClaimed(task_id)
        return await self._view(stored.task, await self._store.get_index(task_id))

    async def pending_count(self, handle: str) -> int:
        """Tasks waiting for `handle`, no bodies (spec 7.5): its `SUBMITTED` tasks, the unclaimed
        tasks of its card, and its `WORKING` tasks with unread follow-ups. An unknown or ended
        session has none: its tasks are orphaned and offered to nobody."""
        card = card_of(handle)
        session = await self._dir.session(handle) if card else None
        if card is None or session is None or session.ended:
            return 0
        counts = await self._store.count_pending(handle, card, self._clock.now(), self._s.reoffer_max)
        unread = sum(1 for t in await self._store.working_for_handle(handle) if C.coord_unread(t) > 0)
        return counts.own_submitted + counts.queued_card + unread

    async def has_wake_pending(self, handle: str) -> bool:
        """Spec 7.4: does `handle` have a wake pending. True for a `SUBMITTED` task bound to it
        that is new or due for a re-offer under `A2A_REOFFER_MAX`, an unread follow-up, or an
        unclaimed due card task when `handle` is the newest parked listener of its card. Held,
        orphaned and expired tasks are never wakeable. The anti-loop rule and the budget are the
        wake endpoint's."""
        card = card_of(handle)
        session = await self._dir.session(handle) if card else None
        if card is None or session is None or session.ended:
            return False
        counts = await self._store.count_pending(handle, card, self._clock.now(), self._s.reoffer_max)
        if counts.own_wakeable > 0:
            return True
        if any(C.coord_unread(t) > 0 for t in await self._store.working_for_handle(handle)):
            return True
        return counts.queued_wakeable > 0 and self._listeners.newest_listening(card) == handle

    # ======================================================================================
    # Recipient: respond
    # ======================================================================================

    async def respond(
        self,
        caller: Caller,
        task_id: str,
        state: str,
        *,
        text: str | None = None,
        artifacts: Sequence[Mapping[str, str]] = (),
    ) -> pb.Task:
        """`a2a_respond` (spec 4.9). `working` on a `SUBMITTED` task is the confirmation; any other
        state from `SUBMITTED` confirms and moves in one step. The caller must be the session the
        task is bound to, or, for an unclaimed card task, a live session of that card, which
        claims it in the same transaction. A pair not in the table is `invalid_transition`."""
        to_state = _RESPOND_STATES.get(state)
        if to_state is None:
            raise InvalidParams("state is one of working, input_required, completed, failed, rejected")
        if len(artifacts) > 8:
            raise InvalidParams("at most 8 artifacts")
        handle, card = await self._live_session(caller)
        stored = await self._store.get(task_id, caller.viewer)
        if stored is None:
            raise TaskNotFound(task_id)
        index = await self._store.get_index(task_id)
        if index is None:
            raise Forbidden("not a task of this session")
        claim = False
        if index.to_handle == handle:
            pass
        elif index.to_handle is None and index.addressing == "card" and index.to_card == card:
            claim = True
        elif index.addressing == "card" and index.to_handle is not None and index.to_card == card:
            raise AlreadyClaimed(task_id)
        else:
            raise Forbidden("the task is bound to another session")

        message = _agent_message(task_id, stored.task.context_id, text) if text else None
        art = [_artifact(a) for a in artifacts]
        current = logical_state(stored.task)
        if to_state is State.WORKING and current is State.WORKING:
            return await self._progress(caller, task_id, message, art)

        def extra(task: pb.Task, _was: State) -> None:
            if message is not None:
                if len(task.history) >= MAX_HISTORY:
                    raise InvalidParams(f"a task keeps at most {MAX_HISTORY} messages")
                task.history.append(message)
                task.status.message.CopyFrom(message)
            task.artifacts.extend(art)
            C.coord_set(task, unread=None)
            if to_state is State.REJECTED:
                C.coord_set(task, reason=C.REASON_RECIPIENT_DECLINED)

        values: dict[str, Any] = {"expires_at": None, "next_offer_at": None}
        if claim:
            values["to_handle"] = handle
        try:
            result = await self._transition(
                task_id,
                to=to_state,
                actor=Actor.RECIPIENT,
                who=caller.actor,
                viewer=caller.viewer,
                mutate=extra,
                index_update=lambda _b, _a: values,
                index_expect={"to_handle": None} if claim else None,
            )
        except InvalidTransition:
            if claim:
                # A concurrent claimer won the compare-and-swap and moved the task on, so the
                # state check failed first; a lost claim race is `already_claimed` (spec 4.9).
                after = await self._store.get_index(task_id)
                if after is not None and after.to_handle is not None and after.to_handle != handle:
                    raise AlreadyClaimed(task_id) from None
            raise
        return await self._view(result.task, await self._store.get_index(task_id))

    async def _progress(
        self, caller: Caller, task_id: str, message: pb.Message | None, art: list[pb.Artifact]
    ) -> pb.Task:
        """`working` on a `WORKING` task: a progress message, and the follow-ups are confirmed."""

        def mutate(task: pb.Task) -> None:
            if message is not None:
                if len(task.history) >= MAX_HISTORY:
                    raise InvalidParams(f"a task keeps at most {MAX_HISTORY} messages")
                task.history.append(message)
                task.status.message.CopyFrom(message)
            task.artifacts.extend(art)
            C.coord_set(task, unread=None)

        try:
            result = await self._store.transition(
                task_id, allowed_from={S.TASK_STATE_WORKING}, mutate=mutate, viewer=caller.viewer
            )
        except TransitionRefused as exc:
            raise InvalidTransition(f"task is {S.Name(exc.state)}") from None
        except StoreTaskNotFound:
            raise TaskNotFound(task_id) from None
        return await self._view(result.task, await self._store.get_index(task_id))

    # ======================================================================================
    # Originator: cancel
    # ======================================================================================

    async def cancel_task(self, caller: Caller, task_id: str, *, reason: str | None = None) -> pb.Task:
        """`CancelTask` / `a2a_cancel` (spec 4.10): originator only; allowed on a held task, which
        it ends; a finished task is `TaskNotCancelable`."""
        if reason is not None and len(reason.encode()) > MAX_REASON_BYTES:
            raise InvalidParams("reason is at most 1 KiB")
        stored = await self._store.get(task_id, caller.viewer)
        if stored is None:
            raise TaskNotFound(task_id)
        index = await self._store.get_index(task_id)
        if index is None or index.from_principal != caller.principal:
            raise Forbidden("only the originator may cancel")
        if logical_state(stored.task) in TERMINAL:
            raise TaskNotCancelable(task_id)

        def extra(task: pb.Task, _was: State) -> None:
            C.coord_set(task, unread=None)
            if reason:
                task.status.message.CopyFrom(_agent_text(task.id, task.context_id, reason))

        try:
            result = await self._transition(
                task_id,
                to=State.CANCELED,
                actor=Actor.ORIGINATOR,
                who=caller.actor,
                viewer=caller.viewer,
                mutate=extra,
                index_update=lambda _b, _a: {"expires_at": None, "next_offer_at": None},
            )
        except InvalidTransition:
            raise TaskNotCancelable(task_id) from None  # it finished while we were cancelling
        return await self._view(result.task, await self._store.get_index(task_id))

    # ======================================================================================
    # Admin: the only release of a hold (D10, D19)
    # ======================================================================================

    async def release_hold(self, task_id: str, *, actor: str) -> pb.Task:
        """`a2a-coord review release`: `QUARANTINED` to `SUBMITTED`. This is the ONLY way a held
        task becomes `SUBMITTED`. The caller is the admin socket after a typed human decision on a
        real TTY; this layer cannot check that and takes `actor` (the human) only for the audit."""
        _require_actor(actor)
        stored = await self._store.get(task_id)
        index = await self._store.get_index(task_id)
        if stored is None or index is None:
            raise TaskNotFound(task_id)
        now = self._clock.now()
        handle, next_offer = index.to_handle, None
        if index.addressing == "card":
            handle, next_offer = await self._route_card(index.to_card or "", now)
        values = {
            "hold": None,
            "released_at": now,
            "expires_at": now + timedelta(hours=self._s.submitted_ttl_h),
            "to_handle": handle,
            "next_offer_at": next_offer,
            "offer_count": 0,
            "last_offered_at": None,
        }
        result = await self._transition(
            task_id,
            to=State.SUBMITTED,
            actor=Actor.ADMIN,
            who=actor,
            mutate=lambda _t, _was: None,
            index_update=lambda _b, _a: values,
            extra_rows=lambda: [self._audit.hold_released_row(actor=actor, task_id=task_id)],
        )
        fresh = await self._store.get_index(task_id)
        await self._notify(fresh)
        return await self._view(result.task, fresh)

    async def deny_hold(self, task_id: str, *, actor: str) -> pb.Task:
        """`a2a-coord review deny`: `QUARANTINED` to `REJECTED`, reason `denied_by_human`. The index
        keeps `hold`, so the task stays invisible to the recipient side."""
        _require_actor(actor)
        if await self._store.get(task_id) is None:
            raise TaskNotFound(task_id)
        result = await self._transition(
            task_id,
            to=State.REJECTED,
            actor=Actor.ADMIN,
            who=actor,
            mutate=lambda t, _was: C.coord_set(t, reason=C.REASON_DENIED),
            index_update=lambda _b, _a: {"expires_at": None},
            extra_rows=lambda: [self._audit.hold_denied_row(actor=actor, task_id=task_id)],
        )
        return await self._view(result.task, await self._store.get_index(task_id))

    # ======================================================================================
    # TTL sweeps
    # ======================================================================================

    async def sweep(self) -> SweepResult:
        """One pass of the TTL rules (spec 1.5, 6.2). Safe to run at any rate; each step is its own
        compare-and-swap, and a task that changed under the sweep is skipped, never forced."""
        now = self._clock.now()
        ended = await self._dir.end_idle(now - timedelta(hours=self._s.session_idle_ttl_h), now)
        submitted = held = failed = 0
        for task_id, hold in await self._store.expired(now, 500):
            to_reason = C.REASON_QUARANTINE_EXPIRED if hold else C.REASON_EXPIRED
            if await self._system_transition(task_id, State.REJECTED, to_reason, expect_held=bool(hold)):
                if hold:
                    held += 1
                else:
                    submitted += 1
        cutoff = now - timedelta(hours=self._s.working_ttl_h)
        for task_id in await self._store.working_of_ended_sessions(cutoff, 500):
            if await self._system_transition(task_id, State.FAILED, C.REASON_EXPIRED, expect_held=False):
                failed += 1
        requeued = 0
        for task_id, handle in await self._store.requeue_due(now, 500):
            if await self._store.update_index(task_id, {"to_handle": None}, expect={"to_handle": handle, "hold": None}):
                requeued += 1
                await self._notify(await self._store.get_index(task_id))
        return SweepResult(ended, submitted, held, failed, requeued)

    async def _system_transition(self, task_id: str, to: State, reason: str, *, expect_held: bool) -> bool:
        def mutate(task: pb.Task, was: State) -> None:
            if (was is State.QUARANTINED) != expect_held:
                raise InvalidTransition("the task changed under the sweep")
            C.coord_set(task, reason=reason, unread=None)

        try:
            await self._transition(
                task_id,
                to=to,
                actor=Actor.SYSTEM,
                who=SYSTEM_ACTOR,
                mutate=mutate,
                index_update=lambda _b, _a: {"expires_at": None, "next_offer_at": None},
            )
        except (InvalidTransition, TaskNotFound):
            return False
        return True

    async def run_forever(
        self, interval_s: float = 60.0, *, sleep: Callable[[float], Any] = asyncio.sleep
    ) -> None:
        """Run `sweep` every `interval_s` seconds until cancelled. A failed pass is logged without
        task data and retried next round."""
        while True:
            try:
                result = await self.sweep()
                if result.total:
                    log.info(
                        "sweep: %d sessions ended, %d submitted and %d held expired, %d working failed, %d requeued",
                        result.sessions_ended,
                        result.submitted_expired,
                        result.quarantine_expired,
                        result.working_failed,
                        result.requeued,
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("sweep failed: %s", type(exc).__name__)
            await sleep(interval_s)

    # ======================================================================================
    # Internals
    # ======================================================================================

    async def _live_session(self, caller: Caller) -> tuple[str, str]:
        """(handle, card) of the calling session, which must be a registered, not-ended
        local-harness session."""
        if not caller.local or not caller.handle or caller.card_id is None:
            raise Forbidden("this needs a bound local session")
        session = await self._dir.session(caller.handle)
        if session is None or session.ended or session.card_id != caller.card_id:
            raise SessionNotLive(caller.handle)
        return caller.handle, caller.card_id

    def _state_row(self, who: str, task_id: str, before: pb.Task, after: pb.Task) -> AuditRow:
        return self._audit.state_transition_row(
            actor=who,
            task_id=task_id,
            from_state=AUDIT_NAME[logical_state(before)],
            to_state=AUDIT_NAME[logical_state(after)],
        )

    async def _transition(
        self,
        task_id: str,
        *,
        to: State,
        actor: Actor,
        who: str,
        mutate: Callable[[pb.Task, State], None],
        index_update: Callable[[pb.Task, pb.Task], Mapping[str, Any]] | None = None,
        index_expect: Mapping[str, Any] | None = None,
        viewer: Any = None,
        extra_rows: Callable[[], Sequence[AuditRow]] | None = None,
    ):
        """One state change, checked against the table of spec 6.2 inside the compare-and-swap.

        `mutate(task, was)` runs after the state, the status message and the hold marker have been
        set for the new state, with `was` the logical state the task had; it adds the rest.
        """
        allowed_raw = {RAW[s] for s in sources(to, actor)}

        def do_mutate(task: pb.Task) -> None:
            current = logical_state(task)
            if not is_allowed(current, to, actor):
                raise InvalidTransition(f"{current.value} to {to.value} by {actor.value} is not allowed")
            task.status.state = RAW[to]
            task.status.ClearField("message")
            if current is State.QUARANTINED:
                C.coord_set(task, hold=None)
            mutate(task, current)

        def audit(before: pb.Task, after: pb.Task) -> Sequence[AuditRow]:
            return [self._state_row(who, task_id, before, after), *(extra_rows() if extra_rows else ())]

        try:
            return await self._store.transition(
                task_id,
                allowed_from=allowed_raw,
                mutate=do_mutate,
                viewer=viewer,
                index_update=index_update,
                index_expect=index_expect,
                audit=audit,
            )
        except TransitionRefused as exc:
            raise InvalidTransition(f"task is {S.Name(exc.state)}; {to.value} by {actor.value} is not allowed") from None
        except StoreTaskNotFound:
            raise TaskNotFound(task_id) from None
        except IndexConflict:
            raise AlreadyClaimed(task_id) from None

    async def _guarded_transition(self, task_id: str, **kwargs: Any):
        """`store.transition` with the store's errors turned into service errors."""
        try:
            return await self._store.transition(task_id, **kwargs)
        except TransitionRefused as exc:
            raise UnsupportedOperation(f"task is {S.Name(exc.state)}") from None
        except StoreTaskNotFound:
            raise TaskNotFound(task_id) from None

    async def _notify(self, index: IndexRow | None) -> None:
        """Tell the wake machinery work is pending. No content; a failure never fails the call."""
        if self._notifier is None or index is None:
            return
        handle = index.to_handle
        if handle is None and index.addressing == "card" and index.to_card:
            handle = self._listeners.newest_listening(index.to_card)
        if handle is None:
            return
        try:
            await self._notifier.notify_pending(handle)
        except Exception as exc:  # noqa: BLE001
            log.warning("notify_pending failed: %s", type(exc).__name__)

    # -- views ---------------------------------------------------------------------------

    async def _view_of(self, task: pb.Task) -> pb.Task:
        return await self._view(task, await self._store.get_index(task.id))

    async def _view(self, task: pb.Task, index: IndexRow | None) -> pb.Task:
        """The task as a caller sees it: the stored task plus the computed `coord` fields
        (`delivery`, `recipientListening`, `expiresAt`, `orphaned`); the internal follow-up
        counter is removed. An import task has no index row and is shown as stored."""
        out = pb.Task()
        out.CopyFrom(task)
        C.coord_set(out, unread=None)
        if index is None:
            return out
        state = logical_state(out)
        delivery = None
        if state in (State.SUBMITTED, State.QUARANTINED):
            delivery = "queued" if index.offer_count == 0 else "offered"
        elif state in (State.WORKING, State.INPUT_REQUIRED, State.COMPLETED, State.FAILED):
            delivery = "accepted"
        listening = orphaned = None
        if state not in TERMINAL:
            if index.to_handle:
                listening = self._listeners.is_listening(index.to_handle)
            elif index.to_card:
                listening = self._listeners.newest_listening(index.to_card) is not None
            if state is State.SUBMITTED and index.addressing == "handle" and index.to_handle:
                session = await self._dir.session(index.to_handle)
                orphaned = session is None or session.ended
        C.coord_set(
            out,
            delivery=delivery,
            recipientListening=listening,
            expiresAt=C.iso_z(index.expires_at) if index.expires_at else None,
            orphaned=True if orphaned else None,
        )
        return out


# -- message builders ---------------------------------------------------------------------


def _agent_text(task_id: str, context_id: str, text: str) -> pb.Message:
    return _agent_message(task_id, context_id, text)


def _agent_message(task_id: str, context_id: str, text: str) -> pb.Message:
    msg = pb.Message(
        message_id=str(uuid.uuid4()), context_id=context_id, task_id=task_id, role=pb.Role.ROLE_AGENT
    )
    msg.parts.add(text=text)
    return msg


def _artifact(spec: Mapping[str, str]) -> pb.Artifact:
    name, text = spec.get("name"), spec.get("text")
    if not isinstance(name, str) or not isinstance(text, str) or not name:
        raise InvalidParams("an artifact needs a name and text")
    if len(text.encode()) > MAX_PART_BYTES:
        raise InvalidParams(f"artifact text is at most {MAX_PART_BYTES} bytes")
    artifact = pb.Artifact(artifact_id=str(uuid.uuid4()), name=name)
    artifact.parts.add(text=text)
    return artifact


def _require_actor(actor: str) -> None:
    if not isinstance(actor, str) or not actor.strip():
        raise InvalidParams("an admin action names its human actor")
