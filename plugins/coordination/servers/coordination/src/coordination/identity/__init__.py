"""Identity and binding (S1-ID): handles, the session registry, liveness and `/sessions`.

- `handles`: the handle grammar `<card>/<name>~<sid8>` and the name derivation (spec 5.1).
- `registry`: `SessionRegistry`, the durable registry (S1-MCP's class, extended).
- `service`: `IdentityService`, registration, agy conversation binding, listing and ending.
- `liveness`: `listening`, `active`, `registered`, `ended` (spec 5.5).
- `hooks`: the registry S1-WAKE plugs its parked-listener close into (`410` on session end).
- `routes`: `POST /sessions`, `GET /sessions`, `POST /sessions/end` (spec 3.5).
- `errors`: constant-coded errors shared by the routes and the MCP tools.

Docs: docs/specs/identity.md.
"""

from __future__ import annotations

from coordination.identity.errors import (
    HandleCollision,
    IdentityError,
    InvalidRequest,
    SessionEnded,
    UnknownHandle,
    WrongCard,
)
from coordination.identity.handles import (
    AGY_CONVERSATION_KEY,
    AGY_HARNESS,
    AGY_PARENT_KEY,
    AGY_ROOT_KEY,
    build_handle,
    derive_name,
    is_agy_card,
    sid8_of,
    valid_session_id,
)
from coordination.identity.hooks import EndReport, SessionEndHooks
from coordination.identity.liveness import ACTIVE, ENDED, LISTENING, REGISTERED, liveness_state
from coordination.identity.registry import CardInfo, PeerSession, SessionRegistry, SessionView
from coordination.identity.routes import SessionsEndpoint
from coordination.identity.service import (
    EndResult,
    IdentityService,
    ListedSession,
    Registration,
)

__all__ = [
    "ACTIVE",
    "AGY_CONVERSATION_KEY",
    "AGY_HARNESS",
    "AGY_PARENT_KEY",
    "AGY_ROOT_KEY",
    "ENDED",
    "LISTENING",
    "REGISTERED",
    "CardInfo",
    "EndReport",
    "EndResult",
    "HandleCollision",
    "IdentityError",
    "IdentityService",
    "InvalidRequest",
    "ListedSession",
    "PeerSession",
    "Registration",
    "SessionEnded",
    "SessionEndHooks",
    "SessionRegistry",
    "SessionsEndpoint",
    "SessionView",
    "UnknownHandle",
    "WrongCard",
    "build_handle",
    "derive_name",
    "is_agy_card",
    "liveness_state",
    "sid8_of",
    "valid_session_id",
]
