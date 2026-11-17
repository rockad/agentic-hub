"""The `coord` block of a task's metadata (spec 5.3).

Server-set only. A client's `coord.*` metadata is dropped on the way in (spec 3.3), except
`coord.to` which is read from the request and never copied to the task. Everything here is a
string or a bool, so a `Struct` round trip (which turns integers into floats) cannot change it,
with one exception: `unread`, a follow-up counter, which is read back with `int()`.

Stored in the task (`Task.metadata.coord`):

- `from`: the sender, for display (a handle when the sender is a session, else the card or `peer:<id>`)
- `origin`: `local`, `remote` or `import`
- `hold`: `quarantine` while held
- `to`: the addressed handle, when the sender addressed one
- `reason`: constant code once rejected (spec 5.3 table)
- `createdAt`: ISO 8601
- `unread`: unread follow-up messages for the recipient (spec 6.4)

Computed when a task is shown (`CoordinationService` views): `delivery`, `recipientListening`,
`expiresAt`, `orphaned`. Keys are camelCase like the A2A protocol fields (decision Z16). They are never stored, so they cannot go stale.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from google.protobuf import json_format

from a2a.types import a2a_pb2 as pb

KEY = "coord"

# Constant reason codes (spec 5.3).
REASON_NOT_ALLOWED = "not_allowed"
REASON_DENIED = "denied_by_human"
REASON_QUARANTINE_EXPIRED = "quarantine_expired"
REASON_EXPIRED = "expired"
REASON_RECIPIENT_DECLINED = "recipient_declined"
REASON_QUOTA = "quota"

#: The one status text a held task shows (spec 6.1). A constant: never the body.
HOLD_STATUS_TEXT = "Held for human review by the recipient. No action needed."
#: The one status text of a refused task: the same for "not allowed", "unknown" and "ended".
NOT_AVAILABLE_TEXT = "Not available."


def coord_get(task: pb.Task) -> dict[str, Any]:
    """The task's `coord` block as a plain dict (empty if there is none)."""
    if KEY not in task.metadata:
        return {}
    value = json_format.MessageToDict(task.metadata).get(KEY)
    return dict(value) if isinstance(value, dict) else {}


def coord_set(task: pb.Task, **fields: Any) -> None:
    """Set fields of the `coord` block; a value of None removes the field."""
    block = coord_get(task)
    for key, value in fields.items():
        if value is None:
            block.pop(key, None)
        else:
            block[key] = value
    task.metadata.update({KEY: block})


def coord_unread(task: pb.Task) -> int:
    return int(coord_get(task).get("unread", 0) or 0)


def sanitize_message_metadata(message: pb.Message, to: str | None) -> None:
    """Drop every `coord.*` a client put on a message, then keep only `coord.to` (spec 3.3)."""
    if KEY in message.metadata:
        del message.metadata[KEY]
    if to is not None:
        message.metadata.update({KEY: {"to": to}})


def client_coord_to(*metadata_sources: Mapping[str, Any] | None) -> str | None:
    """`coord.to` from request or message metadata (nested form `{"coord": {"to": ...}}`).

    The first source that carries one wins. Anything that is not a string is returned as it is,
    so the caller's format check refuses it (a non-string `coord.to` is `InvalidParams`).
    """
    for source in metadata_sources:
        if not source:
            continue
        block = source.get(KEY)
        if isinstance(block, Mapping) and "to" in block:
            return block["to"]  # type: ignore[no-any-return]
    return None
