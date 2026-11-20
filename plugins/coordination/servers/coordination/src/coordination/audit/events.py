"""Audit event types and the rules a row must satisfy (S1-OBS; spec 1.3 "Rules", plan S1-OBS).

The `audit` table is a security log: it records decisions, never content. Columns (spec 1.3):
`at`, `actor`, `event`, `subject`, `detail_json`. This module is the single place that decides
what may go into those columns, so no caller can store a message body or a key secret by
accident. The table itself belongs to S1-STORE.

Only `handle_probe_limited` is named by the spec. The other event names, the required detail
fields below and the detail rules are [design] choices of S1-OBS, listed in
`docs/specs/audit-events.md`.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any

from coordination.logging.redact import contains_secret


class AuditError(ValueError):
    """A row broke the audit rules. It is raised before anything reaches the store."""


class AuditEvent(StrEnum):
    KEY_CREATED = "key_created"
    KEY_ROTATED = "key_rotated"
    KEY_REVOKED = "key_revoked"
    AUTH_FAILURE_SAMPLED = "auth_failure_sampled"  # one row per window, with a count
    # Session lifecycle (S1-ID, decision Z17). `session_registered` replaces the S1-OBS name
    # `registration`; nothing but the identity service wrote it.
    SESSION_REGISTERED = "session_registered"
    SESSION_ENDED = "session_ended"
    SESSION_REBOUND = "session_rebound"
    ALIAS_ADDED = "alias_added"
    WAKE_SENT = "wake_sent"
    HOLD_ENTERED = "hold_entered"
    HOLD_RELEASED = "hold_released"
    HOLD_DENIED = "hold_denied"
    STATE_TRANSITION = "state_transition"
    BUDGET_EXHAUSTED = "budget_exhausted"
    HANDLE_PROBE_LIMITED = "handle_probe_limited"  # guess counter trip, spec 1.3 and 5.2


#: Detail fields an event must carry. `handle_probe_limited` is from the spec (`key_id`,
#: `window_count`); the others are [design].
REQUIRED_DETAIL: dict[AuditEvent, frozenset[str]] = {
    AuditEvent.HANDLE_PROBE_LIMITED: frozenset({"key_id", "window_count"}),
    AuditEvent.STATE_TRANSITION: frozenset({"task_id", "from_state", "to_state"}),
    AuditEvent.AUTH_FAILURE_SAMPLED: frozenset({"count", "window_s", "window_started_at"}),
    AuditEvent.SESSION_REGISTERED: frozenset({"card_id", "via", "revived"}),
    AuditEvent.SESSION_ENDED: frozenset({"via"}),
    AuditEvent.SESSION_REBOUND: frozenset({"from_binding", "to_binding"}),
    AuditEvent.ALIAS_ADDED: frozenset({"alias"}),
}

#: Allowed `via` values (S1-ID, Z17). `session_registered`: who registered the session.
REGISTERED_VIA = frozenset({"hook", "hello", "auto_agy"})
#: `session_ended`: an explicit `POST /sessions/end`, or the idle-TTL expiry.
ENDED_VIA = frozenset({"explicit", "idle_ttl"})

#: Words that mark a field as content. A detail key containing any of them (split on `_`) is
#: refused, as is the exact name `api_key`. `key_id` is fine: `key` alone is not on the list.
FORBIDDEN_KEY_WORDS = frozenset(
    {
        "body", "message", "messages", "text", "content", "parts", "history", "artifact",
        "artifacts", "secret", "authorization", "token", "password", "prompt", "transcript",
        "headers", "credential", "credentials",
    }
)  # fmt: skip
FORBIDDEN_KEY_NAMES = frozenset({"api_key", "apikey"})

MAX_STR_LEN = 256  # a longer value is more likely content than an identifier
_KEY_NAME = re.compile(r"^[a-z][a-z0-9_]*$")

DetailValue = str | int | float | bool | None


def _check_text(what: str, value: str) -> None:
    if len(value) > MAX_STR_LEN:
        raise AuditError(f"audit {what} is longer than {MAX_STR_LEN} characters")
    if contains_secret(value):
        raise AuditError(f"audit {what} contains something that looks like a credential")


def validate(
    event: AuditEvent, actor: str, subject: str | None, detail: Mapping[str, Any]
) -> dict[str, DetailValue]:
    """Check one row's fields and return the detail as a plain dict. Raises `AuditError`."""
    if not isinstance(event, AuditEvent):
        raise AuditError(f"unknown audit event {event!r}")
    if not isinstance(actor, str) or not actor.strip():
        raise AuditError("audit actor is required")
    _check_text("actor", actor)
    if subject is not None:
        if not isinstance(subject, str):
            raise AuditError("audit subject must be a string or None")
        _check_text("subject", subject)
    clean: dict[str, DetailValue] = {}
    for key, value in detail.items():
        if not isinstance(key, str) or not _KEY_NAME.match(key):
            raise AuditError(f"audit detail key {key!r} is not a lower_snake_case name")
        if key in FORBIDDEN_KEY_NAMES or FORBIDDEN_KEY_WORDS.intersection(key.split("_")):
            raise AuditError(f"audit detail key {key!r} names content; the audit log holds none")
        if value is not None and not isinstance(value, (str, int, float, bool)):
            raise AuditError(f"audit detail {key!r} must be a string, number, bool or None")
        if isinstance(value, str):
            _check_text(f"detail {key!r}", value)
        clean[key] = value
    missing = REQUIRED_DETAIL.get(event, frozenset()) - clean.keys()
    if missing:
        raise AuditError(f"audit event {event.value} needs detail {', '.join(sorted(missing))}")
    return clean


@dataclass(frozen=True)
class AuditRow:
    """One row of the `audit` table. Build it with `make_row`, which validates it."""

    at: datetime
    actor: str
    event: AuditEvent
    subject: str | None = None
    detail: Mapping[str, DetailValue] = field(default_factory=dict)

    def detail_json(self) -> str:
        """The `detail_json` column: compact, key-sorted JSON."""
        return json.dumps(dict(self.detail), sort_keys=True, separators=(",", ":"))


def make_row(
    at: datetime,
    event: AuditEvent,
    actor: str,
    subject: str | None = None,
    **detail: Any,
) -> AuditRow:
    if at.tzinfo is None:
        raise AuditError("audit time must be timezone-aware")
    return AuditRow(
        at=at, actor=actor, event=event, subject=subject, detail=validate(event, actor, subject, detail)
    )
