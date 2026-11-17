"""`IdentityService`: registering, resolving, listing and ending sessions (S1-ID).

One class behind both the HTTP routes (`POST /sessions`, `GET /sessions`, `POST /sessions/end`) and
the MCP tools (`a2a_hello` in `name` mode, the agy conversation binding), so the two cannot drift.
It sits on `SessionRegistry` (which S1-MCP started and S1-ID extended); it does not build a second
registry. The caller has already authenticated the request and passes the key's own card; this
class never reads a card, a handle or a conversation id from anything but its arguments, and every
lookup is scoped to the card it is given, so a key can only touch sessions of its own card.

Two defaults the spec leaves open, built conservatively and marked [design]:

- `REVIVE_ENDED_SESSIONS = False`. A session that has ended stays ended. A registration or an agy
  call for an ended (card, harness session id) is refused with `session_ended`, never revived, and
  a task addressed to its handle stays orphaned (spec 5.2). Spec 5.2 also says "if the same harness
  session resumes, the same handle comes back and the task is offered again", which reads as
  revival; the two sentences disagree and the owner has not decided. Setting this to True makes a
  registration of an ended session revive it (`ended_at` cleared, `last_seen_at` now). Note the
  cost of the default: a session expired by `A2A_SESSION_IDLE_TTL_H` (12 h) and then resumed cannot
  register again; the user starts a new session.
- The unnamed-session form: see `identity.handles` (the suffix is always present; the default name
  is the `<sid8>`).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from coordination.audit import AuditLog
from coordination.clock import Clock
from coordination.identity.errors import (
    InvalidRequest,
    SessionEnded,
    UnknownHandle,
    WrongCard,
)
from coordination.identity.handles import HANDLE_RE, build_handle, derive_name, name_part
from coordination.identity.hooks import EndReport, SessionEndHooks
from coordination.identity.liveness import liveness_state
from coordination.identity.registry import SessionRegistry, SessionView
from coordination.service import ListenerView, NoListeners
from coordination.service.directory import Session

log = logging.getLogger("coordination.identity")

#: [design] whether a registration of an ended session revives it. See the module docstring.
REVIVE_ENDED_SESSIONS = False

PendingCount = Callable[[str], Awaitable[int]]


@dataclass(frozen=True)
class Registration:
    session: Session
    created: bool
    revived: bool = False
    #: The alias this call recorded for a later `SessionStart` name, if any.
    alias_added: str | None = None


@dataclass(frozen=True)
class ListedSession:
    view: SessionView
    liveness: str
    pending: int


@dataclass(frozen=True)
class EndResult:
    handle: str
    card_id: str
    #: True if this call ended it; False if it had ended already.
    ended_now: bool
    report: EndReport


class IdentityService:
    def __init__(
        self,
        registry: SessionRegistry,
        clock: Clock,
        *,
        audit: AuditLog | None = None,
        listeners: ListenerView | None = None,
        pending: PendingCount | None = None,
        end_hooks: SessionEndHooks | None = None,
    ) -> None:
        self.registry = registry
        self._clock = clock
        self._audit = audit
        self._listeners: ListenerView = listeners if listeners is not None else NoListeners()
        self._pending = pending
        self.end_hooks = end_hooks if end_hooks is not None else SessionEndHooks()

    # -- registering ---------------------------------------------------------------------

    async def register(
        self, card_id: str, key_id: str, harness_session_id: str, name_hint: str = ""
    ) -> Registration:
        """Register or refresh the session (card, harness session id); idempotent.

        - New: the server builds the handle from the card, the hint and the session id (never the
          caller), checks it is unique, and writes one `registration` audit row.
        - Known and live: returns the same handle and refreshes `last_seen_at`. A hint that derives
          a different name from the handle's own becomes an alias (a later `SessionStart` name,
          spec 5.4.1).
        - Known and ended: `session_ended`, unless `REVIVE_ENDED_SESSIONS`.
        - A conversation that was grouped under a root as a sub-invocation is not a session of its
          own: the root's handle comes back, `created` false, and no alias is added.
        Raises `HandleCollision` (409) when another session holds the handle."""
        existing = await self.registry.by_harness_session(card_id, harness_session_id)
        if existing is not None:
            return await self._known(card_id, key_id, existing, name_hint)
        link = await self.registry.conversation(card_id, harness_session_id)
        if link is not None:
            grouped = await self.registry.by_handle(link.handle)
            if grouped is not None:
                if grouped.ended:
                    raise SessionEnded
                return Registration(grouped, created=False)
        handle = build_handle(card_id, name_hint, harness_session_id)
        session, created = await self.registry.register(card_id, harness_session_id, handle)
        if created:
            await self._log_registration(key_id, session)
            return Registration(session, True)
        return await self._known(card_id, key_id, session, name_hint)  # a concurrent call won

    async def _known(self, card_id: str, key_id: str, session: Session, name_hint: str) -> Registration:
        revived = False
        if session.ended:
            if not REVIVE_ENDED_SESSIONS:
                raise SessionEnded
            revived = await self.registry.revive(session.handle)
            if revived:
                await self._log_registration(key_id, session)
        else:
            await self.registry.refresh(session.handle)
        alias_added: str | None = None
        wanted = derive_name(name_hint)
        if wanted and wanted != name_part(session.handle):
            if await self.registry.add_alias(card_id, session.handle, wanted):
                alias_added = wanted
        fresh = await self.registry.by_handle(session.handle)
        return Registration(fresh or session, created=False, revived=revived, alias_added=alias_added)

    async def _log_registration(self, key_id: str, session: Session) -> None:
        if self._audit is None:
            return
        try:
            await self._audit.registration(actor=key_id, handle=session.handle, card_id=session.card_id)
        except Exception as exc:  # noqa: BLE001 - the registration stands; only its log line failed
            log.warning("registration audit failed", extra={"fields": {"error": type(exc).__name__}})

    # -- agy: bind by conversation id ----------------------------------------------------

    async def resolve_conversation(
        self,
        card_id: str,
        key_id: str,
        conversation_id: str,
        root_conversation_id: str | None = None,
        parent_conversation_id: str | None = None,
    ) -> Session:
        """The session an agy `tools/call` belongs to (spec 5.4.1). The ids come from `_meta` of a
        request that passed the `local-harness` check, already shape-checked by the caller, and are
        only ever matched within `card_id`.

        - A registered conversation: its session.
        - A known sub-invocation (a recorded link): its root's session.
        - A sub-invocation (`root_conversation_id` differs from the conversation): grouped under the
          root's session, registering the root if it is unseen (the subagent never becomes a
          top-level handle), and the link plus `parent_conversation_id` recorded for provenance.
        - An unseen conversation: registered on this first call (D30), one `registration` audit row.
        An ended session is `session_ended`, never revived here."""
        session = await self.registry.by_harness_session(card_id, conversation_id)
        if session is None:
            link = await self.registry.conversation(card_id, conversation_id)
            if link is not None:
                session = await self.registry.by_handle(link.handle)
        if session is None:
            root = root_conversation_id if root_conversation_id and root_conversation_id != conversation_id else None
            if root is not None:
                session = await self.registry.by_harness_session(card_id, root)
                if session is None:
                    session = (await self.register(card_id, key_id, root)).session
                if not session.ended:
                    await self.registry.link_conversation(
                        card_id,
                        conversation_id,
                        session.handle,
                        root_conversation_id=root,
                        parent_conversation_id=parent_conversation_id,
                    )
            else:
                session = (await self.register(card_id, key_id, conversation_id)).session
        if session.ended:
            raise SessionEnded
        return session

    # -- listing -------------------------------------------------------------------------

    async def list_sessions(
        self,
        *,
        handle: str | None = None,
        card_id: str | None = None,
        include_ended: bool = True,
        limit: int = 100,
    ) -> list[ListedSession]:
        """Sessions with their liveness and pending count, newest-seen first. A local-harness key
        sees every card on the server (spec 3.5: own machines only)."""
        now = self._clock.now()
        out: list[ListedSession] = []
        for view in await self.registry.list_sessions(
            handle=handle, card_id=card_id, include_ended=include_ended, limit=limit
        ):
            ended = view.ended_at is not None
            state = liveness_state(
                ended=ended,
                last_seen_at=view.last_seen_at,
                now=now,
                listening=(not ended) and self._listeners.is_listening(view.handle),
            )
            pending = 0 if ended or self._pending is None else await self._pending(view.handle)
            out.append(ListedSession(view, state, pending))
        return out

    # -- ending --------------------------------------------------------------------------

    async def end(
        self, card_id: str, *, handle: str | None = None, harness_session_id: str | None = None
    ) -> EndResult:
        """Mark a session of the key's own card ended and close its parked listener (the end hooks
        WAKE registers answer it with 410). Idempotent: ending an ended session succeeds and still
        fires the hooks, so a listener that raced the first call is not left parked. Not reliable
        by design (spec 3.5): liveness never rests on it."""
        if (handle is None) == (harness_session_id is None):
            raise InvalidRequest("Give either handle or harness_session_id.")
        if handle is not None:
            if not HANDLE_RE.match(handle):
                raise UnknownHandle
            session = await self.registry.by_handle(handle)
        else:
            assert harness_session_id is not None
            session = await self.registry.by_harness_session(card_id, harness_session_id)
        if session is None:
            raise UnknownHandle
        if session.card_id != card_id:
            raise WrongCard
        ended_now = await self.registry.end(session.handle)
        report = await self.end_hooks.fire(session.handle)
        log.info(
            "session ended",
            extra={"fields": {"ended_now": ended_now, "listeners_closed": report.total_closed, "hooks_failed": len(report.failed)}},
        )
        return EndResult(session.handle, session.card_id, ended_now, report)
