"""Plain types the service API is called with and returns."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime

from a2a.types import a2a_pb2 as pb
from coordination.config import Config
from coordination.store.task_store import Viewer

LOCAL_HARNESS = "local-harness"
REMOTE_PEER = "remote-peer"

#: Card id, spec 5.1.
CARD_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}@[a-z0-9][a-z0-9-]{0,31}$")
#: Handle, spec 5.1 (X1): `<card-id>/<name>~<sid8>`.
HANDLE_RE = re.compile(
    r"^[a-z0-9][a-z0-9-]{0,31}@[a-z0-9][a-z0-9-]{0,31}/[a-z0-9][a-z0-9._-]{0,38}~[0-9a-f]{8}$"
)

#: Namespace of the task ids derived for idempotency (see `CoordinationService.send_message`).
_TASK_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "urn:agentic-hub:coordination:v1:task")


def card_of(handle: str) -> str | None:
    """The card part of a well-formed handle, else None."""
    return handle.split("/", 1)[0] if HANDLE_RE.match(handle) else None


def derive_task_id(principal: str, tenant: str, context_id: str, message_id: str) -> str:
    """The id a NEW task gets, from who sent it, to which card, in which context, with which
    `message_id`. A repeated `message_id` therefore derives the same id and `create` refuses the
    second insert (`TaskExists`): idempotency with no lookup and no race (spec 3.3, [design])."""
    return str(uuid.uuid5(_TASK_NAMESPACE, "\x1f".join((principal, tenant, context_id, message_id))))


@dataclass(frozen=True)
class Caller:
    """Who is calling, as `/a2a/v1` and `/mcp` establish it from the API key (never from the body).

    - `local-harness`: `card_id` is the key's card; `handle` is the calling session when one is
      bound (MCP) or announced and registered (`X-Coord-Handle`), else None.
    - `remote-peer`: `peer_id` and `cards_allowed` come from the key (the allowlist entry, D18).

    `status-client` keys never reach the service layer.
    """

    scope: str
    key_id: str
    card_id: str | None = None
    handle: str | None = None
    peer_id: str | None = None
    cards_allowed: frozenset[str] = field(default_factory=frozenset)

    def __post_init__(self) -> None:
        if self.scope == LOCAL_HARNESS:
            if not self.card_id:
                raise ValueError("a local-harness caller needs its card")
        elif self.scope == REMOTE_PEER:
            if not self.peer_id:
                raise ValueError("a remote-peer caller needs its peer id")
        else:
            raise ValueError(f"the service layer serves local-harness and remote-peer keys, not {self.scope!r}")
        if not self.key_id:
            raise ValueError("a caller needs a key id")

    @property
    def local(self) -> bool:
        return self.scope == LOCAL_HARNESS

    @property
    def principal(self) -> str:
        """What `task_index.from_principal` holds for tasks this caller sent. Card level for a
        local key (sessions that share a key are mutually trusted, spec 5.1), `peer:<id>` for a peer."""
        return self.card_id if self.local and self.card_id else f"peer:{self.peer_id}"

    @property
    def actor(self) -> str:
        """The audit actor: the session handle when there is one, else the key id."""
        return self.handle or self.key_id

    @property
    def origin(self) -> str:
        return "local" if self.local else "remote"

    @property
    def sender_label(self) -> str:
        """`coord.from` on the task: for display, never an authorization input."""
        return self.handle or self.principal

    @property
    def viewer(self) -> Viewer:
        return Viewer(self.principal, self.card_id if self.local else None, sees_import=self.local)


@dataclass(frozen=True)
class ServiceSettings:
    """The tunables of spec 1.5 the state machine reads."""

    reoffer_after_s: int = 600
    reoffer_max: int = 5
    submitted_ttl_h: int = 168
    quarantine_ttl_h: int = 72
    working_ttl_h: int = 24
    session_idle_ttl_h: int = 12

    @classmethod
    def from_config(cls, config: Config) -> ServiceSettings:
        return cls(
            reoffer_after_s=config.reoffer_after_s,
            reoffer_max=config.reoffer_max,
            submitted_ttl_h=config.submitted_ttl_h,
            quarantine_ttl_h=config.quarantine_ttl_h,
            working_ttl_h=config.working_ttl_h,
            session_idle_ttl_h=config.session_idle_ttl_h,
        )


@dataclass(frozen=True)
class InboxItem:
    """One entry of `a2a_inbox` (spec 4.3). The task is the server's view of it; the binding frames
    the text as untrusted data (4.1)."""

    task: pb.Task
    kind: str  # "new" or "followup"
    addressed_to: str  # "handle" or "card"
    offer_count: int
    received_at: str | None
    expires_at: datetime | None


@dataclass(frozen=True)
class InboxResult:
    items: list[InboxItem]
    pending_total: int
    held_for_review: int


@dataclass(frozen=True)
class WakeSnapshot:
    """What one wake decision needs (S1-WAKE): the ids of the tasks that make a wake pending (empty:
    nothing is wakeable) and the pending count. Ids and a number only, never content."""

    ids: frozenset[str]
    pending: int


@dataclass(frozen=True)
class SweepResult:
    sessions_ended: int = 0
    submitted_expired: int = 0
    quarantine_expired: int = 0
    working_failed: int = 0
    requeued: int = 0

    @property
    def total(self) -> int:
        return (
            self.sessions_ended + self.submitted_expired + self.quarantine_expired + self.working_failed + self.requeued
        )
