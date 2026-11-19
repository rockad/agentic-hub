"""`IdentityService`: registering, resolving, listing and ending sessions (S1-ID).

One class behind both the HTTP routes (`POST /sessions`, `GET /sessions`, `POST /sessions/end`) and
the MCP tools (`a2a_hello` in `name` mode, the agy conversation binding), so the two cannot drift.
It sits on `SessionRegistry` (which S1-MCP started and S1-ID extended); it does not build a second
registry. The caller has already authenticated the request and passes the key's own card; this
class never reads a card, a handle or a conversation id from anything but its arguments, and every
lookup is scoped to the card it is given, so a key can only touch sessions of its own card.

Decision Z17 (2026-11-18), built here:

- A session that has ended and then resumes revives: the same harness session id brings back the
  same handle (`ended_at` cleared, `last_seen_at` now), and a task addressed to the handle, orphaned
  while it was ended, is offered again (spec 5.2). This is the only behaviour; there is no switch.
  It holds for `POST /sessions`, the agy conversation binding and `a2a_hello(handle)`.
- Lifecycle audit events, written here through the S1-OBS writer: `session_registered` (with `via`
  and `revived`), `session_ended` (with `via`), `session_rebound` and `alias_added`.
- Idle expiry (`end_idle`) ends each idle session by name, so the end hooks fire.
- The unnamed-session form: see `identity.handles` (the suffix is always present; the default name
  is the `<sid8>`; decided in Z17).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime

from coordination.audit import SYSTEM_ACTOR, AuditLog
from coordination.clock import Clock
from coordination.identity.errors import (
    InvalidRequest,
    UnknownHandle,
    WrongCard,
)
from coordination.identity.handles import HANDLE_RE, build_handle, derive_name, name_part
from coordination.identity.hooks import EndReport, SessionEndHooks
from coordination.identity.liveness import liveness_state
from coordination.identity.registry import SessionRegistry, SessionView
from coordination.service import ListenerView, NoListeners
from coordination.service.directory import Session
from coordination.service.types import card_of

log = logging.getLogger("coordination.identity")

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
        self, card_id: str, key_id: str, harness_session_id: str, name_hint: str = "", *, via: str = "hook"
    ) -> Registration:
        """Register or refresh the session (card, harness session id); idempotent.

        `via` says which route registered it, for the audit row: `hook` (`POST /sessions`),
        `hello` (`a2a_hello` in `name` mode) or `auto_agy` (an unseen agy conversation).

        - New: the server builds the handle from the card, the hint and the session id (never the
          caller), checks it is unique, and writes one `session_registered` audit row
          (`revived` false).
        - Known and live: returns the same handle and refreshes `last_seen_at`. A hint that derives
          a different name from the handle's own becomes an alias (a later `SessionStart` name,
          spec 5.4.1) and writes one `alias_added` row.
        - Known and ended: revived (Z17): same handle, `ended_at` cleared, `last_seen_at` now, one
          `session_registered` row with `revived` true; its orphaned tasks are offered again.
        - A conversation that was grouped under a root as a sub-invocation is not a session of its
          own: the root's handle comes back (revived if it had ended), `created` false, and no
          alias is added.
        Raises `HandleCollision` (409) when another session holds the handle."""
        existing = await self.registry.by_harness_session(card_id, harness_session_id)
        if existing is not None:
            return await self._known(card_id, key_id, existing, name_hint, via)
        link = await self.registry.conversation(card_id, harness_session_id)
        if link is not None:
            grouped = await self.registry.by_handle(link.handle)
            if grouped is not None:
                revived = grouped.ended and await self._revive(key_id, grouped, via)
                fresh = await self.registry.by_handle(grouped.handle) if revived else None
                return Registration(fresh or grouped, created=False, revived=revived)
        handle = build_handle(card_id, name_hint, harness_session_id)
        session, created = await self.registry.register(card_id, harness_session_id, handle)
        if created:
            await self._audit_registered(key_id, session, via, revived=False)
            return Registration(session, True)
        return await self._known(card_id, key_id, session, name_hint, via)  # a concurrent call won

    async def _known(
        self, card_id: str, key_id: str, session: Session, name_hint: str, via: str
    ) -> Registration:
        revived = False
        if session.ended:
            revived = await self._revive(key_id, session, via)
        else:
            await self.registry.refresh(session.handle)
        alias_added: str | None = None
        wanted = derive_name(name_hint)
        if wanted and wanted != name_part(session.handle):
            if await self.registry.add_alias(card_id, session.handle, wanted):
                alias_added = wanted
                await self._audit_alias(key_id, session.handle, wanted)
        fresh = await self.registry.by_handle(session.handle)
        return Registration(fresh or session, created=False, revived=revived, alias_added=alias_added)

    async def _revive(self, key_id: str, session: Session, via: str) -> bool:
        """Bring an ended session back (Z17). True only for the call that did it, which is also the
        one call that writes the `session_registered` row (`revived` true)."""
        if not await self.registry.revive(session.handle):
            return False
        await self._audit_registered(key_id, session, via, revived=True)
        return True

    async def bind_handle(self, card_id: str, key_id: str, handle: object) -> Session:
        """The session an `a2a_hello(handle)` names (spec 5.4, Z17): it must exist
        (`unknown_handle`) and belong to `card_id` (`wrong_card`). A handle that ended is revived,
        as a resumed registration would be (`session_registered`, `via` hello, `revived` true).
        A live one is returned as it is; binding it is the caller's."""
        if not isinstance(handle, str) or not HANDLE_RE.match(handle):
            raise UnknownHandle
        session = await self.registry.by_handle(handle)
        if session is None:
            raise UnknownHandle
        if session.card_id != card_id or card_of(handle) != card_id:
            raise WrongCard
        if session.ended and await self._revive(key_id, session, "hello"):
            return await self.registry.by_handle(handle) or session
        return session

    async def rebound(self, key_id: str, handle: str, from_binding: str, to_binding: str) -> None:
        """Record that `a2a_hello` moved `handle` from one `Mcp-Session-Id` to another (Z17). The
        ids are the 8-character prefixes of those values."""
        if self._audit is None:
            return
        try:
            await self._audit.session_rebound(
                actor=key_id, handle=handle, from_binding=from_binding, to_binding=to_binding
            )
        except Exception as exc:  # noqa: BLE001 - the rebind stands; only its log line failed
            log.warning("rebind audit failed", extra={"fields": {"error": type(exc).__name__}})

    async def _audit_registered(self, key_id: str, session: Session, via: str, *, revived: bool) -> None:
        if self._audit is None:
            return
        try:
            await self._audit.session_registered(
                actor=key_id, handle=session.handle, card_id=session.card_id, via=via, revived=revived
            )
        except Exception as exc:  # noqa: BLE001 - the registration stands; only its log line failed
            log.warning("registration audit failed", extra={"fields": {"error": type(exc).__name__}})

    async def _audit_alias(self, key_id: str, handle: str, alias: str) -> None:
        if self._audit is None:
            return
        try:
            await self._audit.alias_added(actor=key_id, handle=handle, alias=alias)
        except Exception as exc:  # noqa: BLE001 - the alias stands; only its log line failed
            log.warning("alias audit failed", extra={"fields": {"error": type(exc).__name__}})

    async def _audit_ended(self, actor: str, handle: str, via: str) -> None:
        if self._audit is None:
            return
        try:
            await self._audit.session_ended(actor=actor, handle=handle, via=via)
        except Exception as exc:  # noqa: BLE001 - the end stands; only its log line failed
            log.warning("end audit failed", extra={"fields": {"error": type(exc).__name__}})

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
        - An unseen conversation: registered on this first call (D30), one `session_registered`
          audit row with `via` auto_agy.
        An ended session is revived by the call (Z17), the same handle comes back: one
        `session_registered` row with `revived` true."""
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
                    session = (await self.register(card_id, key_id, root, via="auto_agy")).session
                session = await self._revived(key_id, session)
                await self.registry.link_conversation(
                    card_id,
                    conversation_id,
                    session.handle,
                    root_conversation_id=root,
                    parent_conversation_id=parent_conversation_id,
                )
            else:
                session = (await self.register(card_id, key_id, conversation_id, via="auto_agy")).session
        return await self._revived(key_id, session)

    async def _revived(self, key_id: str, session: Session) -> Session:
        """`session`, brought back first if it had ended (agy path, `via` auto_agy)."""
        if session.ended and await self._revive(key_id, session, "auto_agy"):
            return await self.registry.by_handle(session.handle) or session
        return session

    # -- listing -------------------------------------------------------------------------

    async def list_sessions(
        self,
        *,
        handle: str | None = None,
        card_id: str | None = None,
        include_ended: bool = False,
        limit: int = 100,
    ) -> list[ListedSession]:
        """Sessions with their liveness and pending count, newest-seen first. Live sessions only
        unless `include_ended` (Z17). A local-harness key sees every card on the server (spec 3.5:
        own machines only)."""
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
        self,
        card_id: str,
        *,
        handle: str | None = None,
        harness_session_id: str | None = None,
        key_id: str | None = None,
    ) -> EndResult:
        """Mark a session of the key's own card ended and close its parked listener (the end hooks
        WAKE registers answer it with 410). Idempotent: ending an ended session succeeds and still
        fires the hooks, so a listener that raced the first call is not left parked. Not reliable
        by design (spec 3.5): liveness never rests on it. The call that ends it writes one
        `session_ended` row (`via` explicit, actor `key_id`); a repeat writes none."""
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
        if ended_now:
            await self._audit_ended(key_id or SYSTEM_ACTOR, session.handle, "explicit")
        log.info(
            "session ended",
            extra={"fields": {"ended_now": ended_now, "listeners_closed": report.total_closed, "hooks_failed": len(report.failed)}},
        )
        return EndResult(session.handle, session.card_id, ended_now, report)

    async def end_idle(self, last_seen_before: datetime) -> list[EndResult]:
        """End every live session with no call since `last_seen_before` (`A2A_SESSION_IDLE_TTL_H`),
        one by one and by name (Z17): each gets the end hooks, so WAKE answers its parked listener
        with 410, and one `session_ended` row (`via` idle_ttl, actor `system`). A session that
        called in after the scan is left alone. Returns what it ended, oldest first.

        The app lifespan runs the sweep loop and `CoordinationService.sweep` calls this (Z18, bound
        with `bind_idle_ender`), so it is the only path that ends idle sessions in the server; the
        service layer's `Directory.end_idle` stays only for a service built without the binding."""
        out: list[EndResult] = []
        for handle in await self.registry.idle_handles(last_seen_before):
            if not await self.registry.end(handle, idle_before=last_seen_before):
                continue  # another call ended it, or it was seen again
            report = await self.end_hooks.fire(handle)
            await self._audit_ended(SYSTEM_ACTOR, handle, "idle_ttl")
            log.info(
                "session expired",
                extra={"fields": {"listeners_closed": report.total_closed, "hooks_failed": len(report.failed)}},
            )
            out.append(EndResult(handle, card_of(handle) or "", True, report))
        return out
