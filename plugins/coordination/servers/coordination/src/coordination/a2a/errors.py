"""A2A errors on the wire (S1-A2A).

One exception, `A2AProblem`, carries everything either binding needs: the JSON-RPC code, the HTTP
status, the gRPC-style status name and the machine reason of the REST error payload, a message
that is a constant or an identifier (never task text, never `str(exception)` of something
unexpected) and optional response headers (`Retry-After`).

The codes of the A2A errors are the SDK's own tables (`a2a.utils.errors`), so a client built on the
same SDK reads them back into the same exception classes. Three errors are ours and have no A2A
number; they sit in the implementation-defined JSON-RPC range [design]:

- `-32010` `CARD_NOT_ALLOWED`: a remote-peer key named a tenant outside its `cards_allowed`, or one
  that does not exist (spec 3.3, X3). HTTP 403. The same answer for both.
- `-32011` `QUOTA_EXCEEDED`: the remote-peer quotas of spec 3.3.2. HTTP 429 with `Retry-After`.
- `-32012` `FORBIDDEN`: the caller can see the task but the action is not theirs (cancel by the
  recipient). HTTP 403.
"""

from __future__ import annotations

from typing import Any

from a2a.utils import errors as sdk

from coordination.service import errors as svc

ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo"
A2A_DOMAIN = "a2a-protocol.org"
LOCAL_DOMAIN = "coordination.agentic-hub"

CARD_NOT_ALLOWED_CODE = -32010
QUOTA_EXCEEDED_CODE = -32011
FORBIDDEN_CODE = -32012


class A2AProblem(Exception):
    """An error the bindings turn into a JSON-RPC error object or a REST error payload."""

    def __init__(
        self,
        rpc_code: int,
        http_status: int,
        grpc_status: str,
        reason: str,
        message: str,
        *,
        data: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        domain: str = A2A_DOMAIN,
        rpc_http_status: int = 200,
    ) -> None:
        super().__init__(message)
        self.rpc_code = rpc_code
        self.http_status = http_status
        self.grpc_status = grpc_status
        self.reason = reason
        self.message = message
        self.data = data or {}
        self.headers = headers or {}
        self.domain = domain
        #: HTTP status of a JSON-RPC response carrying this error. JSON-RPC answers 200 for its
        #: errors, except the two that spec 3.3 and 3.3.2 give a status (403 and 429).
        self.rpc_http_status = rpc_http_status

    @property
    def info(self) -> dict[str, Any]:
        """The `google.rpc.ErrorInfo` detail the SDK client reads the reason from."""
        return {"@type": ERROR_INFO_TYPE, "reason": self.reason, "domain": self.domain, "metadata": self.data}

    def rpc_body(self, request_id: str | int | None) -> dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": self.rpc_code, "message": self.message, "data": [self.info]},
        }

    def rest_body(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.http_status,
                "status": self.grpc_status,
                "message": self.message,
                "details": [self.info],
            }
        }


def _sdk(kind: type[sdk.A2AError], message: str | None = None, **kw: Any) -> A2AProblem:
    http, grpc, reason = sdk.A2A_ERROR_MAPPING[kind]
    return A2AProblem(
        sdk.JSON_RPC_ERROR_CODE_MAP[kind], http, grpc, reason, message or kind.message, **kw
    )


def invalid_params(message: str = "Invalid params", *, data: dict[str, Any] | None = None) -> A2AProblem:
    return _sdk(sdk.InvalidParamsError, message, data=data)


def invalid_request(message: str = "Invalid Request") -> A2AProblem:
    return _sdk(sdk.InvalidRequestError, message)


def method_not_found(message: str = "Method not found") -> A2AProblem:
    return _sdk(sdk.MethodNotFoundError, message)


def task_not_found(message: str = "Task not found") -> A2AProblem:
    return _sdk(sdk.TaskNotFoundError, message)


def task_not_cancelable(message: str = "Task cannot be canceled") -> A2AProblem:
    return _sdk(sdk.TaskNotCancelableError, message)


def unsupported_operation(message: str = "This operation is not supported") -> A2AProblem:
    return _sdk(sdk.UnsupportedOperationError, message)


def content_type_not_supported(message: str = "Incompatible content types") -> A2AProblem:
    return _sdk(sdk.ContentTypeNotSupportedError, message)


def push_not_supported(message: str = "Push Notification is not supported") -> A2AProblem:
    return _sdk(sdk.PushNotificationNotSupportedError, message)


def internal_error() -> A2AProblem:
    return _sdk(sdk.InternalError, "The server could not complete the call.")


def parse_error(message: str = "Invalid JSON payload") -> A2AProblem:
    # The SDK has a JSONParseError class but no entry for it in its mapping tables, so the code
    # (-32700, the JSON-RPC one) and a plain 400 are stated here.
    return A2AProblem(sdk.JSON_RPC_ERROR_CODE_MAP[sdk.JSONParseError], 400, "INVALID_ARGUMENT", "PARSE_ERROR", message)


def version_not_supported(received: str | None) -> A2AProblem:
    """D33: a missing header, `0.3` and anything but 1.0 are an unsupported version, never an
    assumed 0.3. The message tells the client what to send."""
    seen = received if received else "missing"
    return _sdk(
        sdk.VersionNotSupportedError,
        "This server speaks A2A 1.0 only. Send the header 'A2A-Version: 1.0'.",
        data={"received": seen[:32], "supported": "1.0"},
    )


def card_not_allowed(message: str = "Card not allowed.") -> A2AProblem:
    return A2AProblem(
        CARD_NOT_ALLOWED_CODE, 403, "PERMISSION_DENIED", "CARD_NOT_ALLOWED", message,
        domain=LOCAL_DOMAIN, rpc_http_status=403,
    )


def forbidden(message: str = "Not allowed for this caller.") -> A2AProblem:
    return A2AProblem(
        FORBIDDEN_CODE, 403, "PERMISSION_DENIED", "FORBIDDEN", message, domain=LOCAL_DOMAIN, rpc_http_status=403
    )


def quota_exceeded(message: str, retry_after_s: int) -> A2AProblem:
    return A2AProblem(
        QUOTA_EXCEEDED_CODE, 429, "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED", message,
        headers={"Retry-After": str(max(1, int(retry_after_s)))}, domain=LOCAL_DOMAIN, rpc_http_status=429,
    )


def front_desk() -> A2AProblem:
    """Decision Z13: a message to the root front desk is refused with a pointer to the member
    card path. The path is a template: the front desk lists no member names."""
    return invalid_params(
        "This is the front desk; it takes no messages. Name a member card as the tenant: read "
        "/agents/<card-id>/.well-known/agent-card.json (any valid API key) and send to the "
        "interface URL and tenant that card gives.",
        data={"memberCardPath": "/agents/{card-id}/.well-known/agent-card.json"},
    )


def from_service(exc: svc.ServiceError) -> A2AProblem:
    """The service layer's errors, in A2A terms. Messages are the service's own: constants or
    identifiers, by its contract (service/errors.py)."""
    text = str(exc) or None
    if isinstance(exc, svc.InvalidParams):
        return invalid_params(text or "Invalid params")
    if isinstance(exc, svc.TaskNotFound):
        return task_not_found()  # the service puts the id in the message; a constant keeps "no such task" and "not yours" identical
    if isinstance(exc, svc.TaskNotCancelable):
        return task_not_cancelable()
    if isinstance(exc, svc.ContentTypeNotSupported):
        return content_type_not_supported(text or "Incompatible content types")
    if isinstance(exc, svc.UnsupportedOperation):
        return unsupported_operation(text or "This operation is not supported")
    if isinstance(exc, svc.CardNotAllowed):
        return card_not_allowed()
    if isinstance(exc, svc.Forbidden):
        return forbidden()
    if isinstance(exc, svc.QuotaExceeded):
        return quota_exceeded(text or "Quota exceeded.", exc.retry_after_s)
    if isinstance(exc, svc.InvalidTransition | svc.AlreadyClaimed | svc.SessionNotLive):
        # Not reachable through the four task operations; if a future change reaches one, it is
        # an operation the task is not in a state for.
        return unsupported_operation("The task is not in a state that allows this.")
    return internal_error()


def from_sdk(exc: sdk.A2AError) -> A2AProblem:
    """An SDK error raised below us (the task store raises `InvalidParamsError` for a bad page
    token). Known classes keep their A2A code; the message is the SDK's own, which for these
    errors is a constant; anything else is the constant internal error."""
    if type(exc) in sdk.A2A_ERROR_MAPPING and not isinstance(exc, sdk.InternalError):
        return _sdk(type(exc), exc.message)
    return internal_error()
