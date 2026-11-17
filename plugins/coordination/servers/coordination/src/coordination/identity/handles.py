"""The handle grammar and the names around it (spec 5.1, 3.5; S1-ID).

A handle is `<card-id>/<name>~<sid8>` (X1, 2026-11-10). The server builds it, from the card, a name
hint and the harness session id; a model never composes one. The regexes are the spec's; the full
handle regex is `coordination.service.types.HANDLE_RE`, which this module builds on and a test
compares with the spec text.

What the spec leaves open and this module fixes as a default, marked [design]:

- **The unnamed session.** Spec 3.5 has two readings (keep `<sid8>` with no suffix, or always
  suffix). Built: reading B, the suffix is always present and the default name is the `<sid8>`
  itself, so an unnamed session is `<card>/<sid8>~<sid8>`. It is the conservative reading: it keeps
  the handle grammar exactly as decided (one regex, no second form to route or validate).
- **A hint whose first character is not `[a-z0-9]` after reduction.** Leading `.`, `_` and `-` are
  stripped; if nothing is left the session is unnamed.
"""

from __future__ import annotations

import hashlib
import re

from coordination.service.types import CARD_RE, HANDLE_RE

#: The `_meta` keys agy puts on `tools/call` (spec 5.4.1, verified on the wire, SP2 A4).
AGY_CONVERSATION_KEY = "antigravity.google/conversation_id"
AGY_ROOT_KEY = "antigravity.google/root_conversation_id"
AGY_PARENT_KEY = "antigravity.google/parent_conversation_id"
#: The only card harness whose `_meta` is read.
AGY_HARNESS = "antigravity"

#: What a harness session id may look like before it is stored: `sessions.harness_session_id` is 128
#: characters. Anything else is no session id (a registration is refused, a `_meta` id is ignored).
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_NAME_STRIP = re.compile(r"[^a-z0-9._-]")
MAX_NAME = 39  # spec 5.1: the whole session part is at most 48 characters
#: The name part of a handle: everything between the `/` and the `~`.
_NAME_PART_RE = re.compile(r"^[^/]+/([^~]+)~[0-9a-f]{8}$")

__all__ = [
    "AGY_CONVERSATION_KEY",
    "AGY_HARNESS",
    "AGY_PARENT_KEY",
    "AGY_ROOT_KEY",
    "CARD_RE",
    "HANDLE_RE",
    "MAX_NAME",
    "SESSION_ID_RE",
    "build_handle",
    "derive_name",
    "is_agy_card",
    "name_part",
    "sid8_of",
    "valid_session_id",
]


def is_agy_card(card_id: str | None) -> bool:
    return bool(card_id) and card_id.split("@", 1)[0] == AGY_HARNESS  # type: ignore[union-attr]


def valid_session_id(value: object) -> str | None:
    return value if isinstance(value, str) and SESSION_ID_RE.match(value) else None


def sid8_of(harness_session_id: str) -> str:
    """The first 8 hex characters of a session id (spec 5.1). A UUID or a hex string gives its own
    first 8; an id that is not hex gives the first 8 of its SHA-256, so the handle regex still holds."""
    hexed = harness_session_id.replace("-", "").lower()
    if len(hexed) >= 8 and re.fullmatch(r"[0-9a-f]+", hexed):
        return hexed[:8]
    return hashlib.sha256(harness_session_id.encode()).hexdigest()[:8]


def derive_name(hint: str) -> str:
    """`name_hint` lowercased and reduced to `[a-z0-9._-]`, at most 39 characters, starting with
    `[a-z0-9]` (spec 3.5). May be empty: the caller then falls back to the session id [design]."""
    reduced = _NAME_STRIP.sub("", hint.lower()).lstrip("._-")
    return reduced[:MAX_NAME]


def build_handle(card_id: str, hint: str, harness_session_id: str) -> str:
    sid8 = sid8_of(harness_session_id)
    handle = f"{card_id}/{derive_name(hint) or sid8}~{sid8}"
    if not HANDLE_RE.match(handle):  # a card id the cards file should never have produced
        raise ValueError("handle does not match the handle grammar")
    return handle


def name_part(handle: str) -> str | None:
    """`<name>` of a well-formed handle (what a hint is compared with to decide on an alias)."""
    match = _NAME_PART_RE.match(handle) if HANDLE_RE.match(handle) else None
    return match.group(1) if match else None
