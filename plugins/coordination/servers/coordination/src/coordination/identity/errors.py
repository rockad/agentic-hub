"""Identity errors: a constant `code`, an HTTP status for `/sessions`, and a constant message.

The messages are constants or identifiers, never a body and never the client's own text. The MCP
tools turn them into `<code>: <message>` tool errors (same codes as before S1-ID: `unknown_handle`,
`wrong_card`, `session_ended`, `handle_collision`); the `/sessions` routes turn them into
`application/problem+json` with the code as an extension member.

Statuses [design]: spec 3.5 lists `400`, `401`, `403` and `429` for `/sessions`. `handle_collision`
is `409` (named in spec 3.5), and the two not-found style answers are added: `unknown_handle` `404`
and `session_ended` `409`.
"""

from __future__ import annotations


class IdentityError(Exception):
    code = "identity_error"
    status = 400

    def __init__(self, message: str | None = None) -> None:
        self.message = message or self.default_message
        super().__init__(self.message)

    default_message = "The request could not be completed."


class InvalidRequest(IdentityError):
    code = "invalid_request"
    status = 400
    default_message = "Invalid request."


class WrongCard(IdentityError):
    code = "wrong_card"
    status = 403
    default_message = "That handle belongs to another card."


class UnknownHandle(IdentityError):
    code = "unknown_handle"
    status = 404
    default_message = "No such handle."


class SessionEnded(IdentityError):
    code = "session_ended"
    status = 409
    default_message = "That session has ended."


class HandleCollision(IdentityError):
    """A different harness session already holds this handle (spec 3.5: practically impossible,
    and never resolved by appending a suffix)."""

    code = "handle_collision"
    status = 409
    default_message = "Another session already holds that handle."
