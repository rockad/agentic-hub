"""The wire format of the admin socket (S1-ADMIN; spec 3.7, 8.3).

One request and one reply per connection, each one line of JSON ending in `\\n`:

```
{"cmd": "key.list", "args": {}}
{"ok": true, "result": {...}}
{"ok": false, "error": {"code": "refused", "message": "..."}}
```

The line is capped (`MAX_LINE`). Nothing on this socket is an HTTP request, and nothing here is
reachable over the network: the socket is an in-container Unix socket (`server.AdminServer`).
Replies never carry a stack trace, an SQL statement or a request argument back to the caller; an
error is a short constant `code` and a message made of constants and identifiers.
"""

from __future__ import annotations

import json
from typing import Any

#: Longest accepted request or reply line, in bytes. A task body is not on this socket (`review
#: show` returns a bounded frame, 64 KiB at most), so this is generous.
MAX_LINE = 256 * 1024

#: The commands the socket serves. `admin-apply` (GL-IMPORT) is not here: asking for them
#: is `unknown_command`.
COMMANDS = (
    "key.create",
    "key.list",
    "key.rotate",
    "key.revoke",
    "review.list",
    "review.show",
    "review.release",
    "review.deny",
    "status",
    "card.check",
    "expose.check",
)


class AdminError(Exception):
    """A command was refused or failed. `code` is a short constant; `message` has no secret."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def encode_request(cmd: str, args: dict[str, Any] | None = None) -> bytes:
    return (json.dumps({"cmd": cmd, "args": args or {}}, separators=(",", ":")) + "\n").encode()


def encode_ok(result: dict[str, Any]) -> bytes:
    return (json.dumps({"ok": True, "result": result}, separators=(",", ":"), default=str) + "\n").encode()


def encode_error(code: str, message: str) -> bytes:
    return (json.dumps({"ok": False, "error": {"code": code, "message": message}}, separators=(",", ":")) + "\n").encode()


def decode_request(line: bytes) -> tuple[str, dict[str, Any]]:
    """Parse a request line. Raises `AdminError("bad_request", ...)` for anything malformed."""
    try:
        data = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        raise AdminError("bad_request", "the request is not valid JSON") from None
    if not isinstance(data, dict) or not isinstance(data.get("cmd"), str):
        raise AdminError("bad_request", "the request needs a `cmd` string")
    args = data.get("args", {})
    if not isinstance(args, dict):
        raise AdminError("bad_request", "`args` must be an object")
    return data["cmd"], args


def decode_reply(line: bytes) -> dict[str, Any]:
    """Parse a reply line into its result, or raise `AdminError` with the server's code and message."""
    try:
        data = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        raise AdminError("bad_reply", "the server's reply is not valid JSON") from None
    if not isinstance(data, dict):
        raise AdminError("bad_reply", "the server's reply is not an object")
    if data.get("ok") is True and isinstance(data.get("result"), dict):
        return data["result"]
    error = data.get("error")
    if isinstance(error, dict):
        raise AdminError(str(error.get("code", "error")), str(error.get("message", "the command failed")))
    raise AdminError("bad_reply", "the server's reply is not understood")


#: The typed phrase of spec 8.3 and decision D19 is `<action> <last 6 characters of the task id>`.
PHRASE_CHARS = 6


def phrase_for(action: str, task_id: str) -> str:
    """The sentence to type: `release 1a2b3c`. The CLI asks for it and the server checks it again."""
    return f"{action} {task_id[-PHRASE_CHARS:]}"
