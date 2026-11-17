"""The JSON-RPC 2.0 binding, `POST /a2a/v1` (spec 3.3, D5).

Method names are PascalCase (A2A 1.0). The set is closed to the 11 operations of spec 3.3.1: there
is no raw-RPC escape hatch, and the SDK's v0.3 compatibility layer is not used (D33).

Order of checks, so each failure has one cause (the middleware has already authenticated and
scoped the request):

1. the body is JSON (-32700) and a JSON-RPC 2.0 request object (-32600);
2. `A2A-Version: 1.0` (-32009 with a message that says what to send). This comes before the method
   lookup so a v0.3 client, whose method names differ, is told about the version, not about a
   method it cannot know;
3. the method is one of the 11 (-32601);
4. the stream operations answer -32004;
5. the params parse into the operation's proto message (-32602);
6. the operation runs; its `A2AProblem` becomes the error object.

HTTP status is 200 for every JSON-RPC error except the two spec 3.3 and 3.3.2 give a status
(403 `CardNotAllowed`, 429 with `Retry-After`).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from a2a.types import a2a_pb2 as pb
from google.protobuf import json_format
from google.protobuf.message import Message
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from coordination.a2a import errors as E
from coordination.a2a.cards import card_json
from coordination.a2a.context import VERSION_HEADER, caller_from_request, check_version
from coordination.a2a.operations import A2AOperations, CallContext, list_tasks_json
from coordination.service.directory import Directory

log = logging.getLogger("coordination.a2a")


def _task(task: pb.Task) -> dict[str, Any]:
    return json_format.MessageToDict(task)


def _message(msg: Message) -> dict[str, Any]:
    return json_format.MessageToDict(msg)


def _full(msg: Message) -> dict[str, Any]:
    return json_format.MessageToDict(msg, always_print_fields_with_no_presence=True)


class JsonRpcBinding:
    def __init__(self, ops: A2AOperations, directory: Directory) -> None:
        self._ops = ops
        self._directory = directory
        o = ops
        # method -> (request message, handler, result renderer). `None` handler: the stream
        # operations, which only ever answer -32004.
        self._methods: dict[str, tuple[type[Message], Callable[[CallContext, Any], Awaitable[Any]] | None, Callable[[Any], Any]]] = {
            "SendMessage": (pb.SendMessageRequest, o.send_message, _message),
            "SendStreamingMessage": (pb.SendMessageRequest, None, _message),
            "GetTask": (pb.GetTaskRequest, o.get_task, _task),
            "ListTasks": (pb.ListTasksRequest, o.list_tasks, list_tasks_json),
            "CancelTask": (pb.CancelTaskRequest, o.cancel_task, _task),
            "SubscribeToTask": (pb.SubscribeToTaskRequest, None, _message),
            "CreateTaskPushNotificationConfig": (pb.TaskPushNotificationConfig, o.create_push_config, _message),
            "GetTaskPushNotificationConfig": (pb.GetTaskPushNotificationConfigRequest, o.get_push_config, _message),
            "ListTaskPushNotificationConfigs": (pb.ListTaskPushNotificationConfigsRequest, o.list_push_configs, _full),
            "DeleteTaskPushNotificationConfig": (pb.DeleteTaskPushNotificationConfigRequest, o.delete_push_config, lambda _: {}),
            "GetExtendedAgentCard": (pb.GetExtendedAgentCardRequest, o.get_extended_agent_card, card_json),
        }

    @staticmethod
    def _error(request_id: str | int | None, problem: E.A2AProblem) -> Response:
        headers = {"Cache-Control": "no-store", **problem.headers}
        return JSONResponse(problem.rpc_body(request_id), status_code=problem.rpc_http_status, headers=headers)

    async def handle(self, request: Request) -> Response:
        request_id: str | int | None = None
        try:
            try:
                body = json.loads(await request.body())
            except (ValueError, UnicodeDecodeError):
                return self._error(None, E.parse_error())
            if not isinstance(body, dict):
                return self._error(None, E.invalid_request("Batch and non-object requests are not supported"))
            raw_id = body.get("id")
            if raw_id is None or (isinstance(raw_id, str | int) and not isinstance(raw_id, bool)):
                request_id = raw_id
            else:
                return self._error(None, E.invalid_request("id must be a string, an integer or null"))
            method = body.get("method")
            if body.get("jsonrpc") != "2.0" or not isinstance(method, str) or not method:
                return self._error(request_id, E.invalid_request("Not a JSON-RPC 2.0 request"))
            check_version(request.headers.get(VERSION_HEADER))
            entry = self._methods.get(method)
            if entry is None:
                raise E.method_not_found()
            model, handler, render = entry
            ctx = CallContext(await caller_from_request(request, self._directory))
            if handler is None:
                await self._ops.stream_unsupported(ctx)
            params = body.get("params", {})
            if not isinstance(params, dict):
                raise E.invalid_params("params must be an object")
            try:
                message = json_format.ParseDict(params, model(), ignore_unknown_fields=True)
            except json_format.ParseError:
                raise E.invalid_params("The params do not match the method.") from None
            result = await handler(ctx, message)
            return JSONResponse(
                {"jsonrpc": "2.0", "id": request_id, "result": render(result)}, headers={"Cache-Control": "no-store"}
            )
        except E.A2AProblem as problem:
            return self._error(request_id, problem)
        except Exception as exc:  # noqa: BLE001 - nothing of an unexpected failure goes back to the caller
            log.error("a2a jsonrpc failed", extra={"fields": {"error": type(exc).__name__}})
            return self._error(request_id, E.internal_error())
