"""Errors of the service layer.

Every error carries a short constant `code` (what `a2a_*` tools return) and, where the A2A spec
names one, the JSON-RPC `rpc_code`. The two bindings (`/a2a/v1` and `/mcp`) translate these; the
service never knows which one called it. Messages are constants or identifiers: no task text.

The A2A numbers are those of the 1.0.1 error table used in `server-api.md` 3.3: `-32001`
TaskNotFound, `-32002` TaskNotCancelable, `-32004` UnsupportedOperation, `-32005`
ContentTypeNotSupported. The ones the spec does not number (`invalid_transition`,
`already_claimed`, `forbidden`) have no `rpc_code`; the binding picks one [design].
"""

from __future__ import annotations


class ServiceError(Exception):
    code = "service_error"
    rpc_code: int | None = None
    http_status = 400


class InvalidParams(ServiceError):
    code = "invalid_params"
    rpc_code = -32602


class TaskNotFound(ServiceError):
    """No such task, or the caller may not see it. The two are never told apart."""

    code = "task_not_found"
    rpc_code = -32001
    http_status = 404


class TaskNotCancelable(ServiceError):
    code = "task_not_cancelable"
    rpc_code = -32002
    http_status = 409


class UnsupportedOperation(ServiceError):
    """A message to a held or terminal task (spec 6.2, 6.4)."""

    code = "unsupported_operation"
    rpc_code = -32004
    http_status = 400


class ContentTypeNotSupported(ServiceError):
    code = "content_type_not_supported"
    rpc_code = -32005
    http_status = 415


class InvalidTransition(ServiceError):
    """The (from, to, actor) triple is not in the transition table of spec 6.2."""

    code = "invalid_transition"
    http_status = 409

    def __init__(self, message: str) -> None:
        super().__init__(message)


class AlreadyClaimed(ServiceError):
    """Another session claimed this card-addressed task first (spec 4.9)."""

    code = "already_claimed"
    http_status = 409


class Forbidden(ServiceError):
    """The caller can see the task but this action is not theirs (for example cancel by the
    recipient, or respond by a session the task is not bound to)."""

    code = "forbidden"
    http_status = 403


class CardNotAllowed(ServiceError):
    """A remote-peer key addressed a card outside its `cards_allowed`, or one that does not exist.
    Identical for both (spec 3.3, X3): not a REJECTED task, and not counted by the guess counter."""

    code = "card_not_allowed"
    http_status = 403


class QuotaExceeded(ServiceError):
    """Remote-peer quota (spec 3.3.2): 20 held tasks, or 10 `SendMessage` per minute."""

    code = "quota_exceeded"
    http_status = 429

    def __init__(self, message: str, retry_after_s: int) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s


class SessionNotLive(ServiceError):
    """The calling handle is unknown or ended, so it cannot take or answer tasks."""

    code = "session_ended"
    http_status = 409
