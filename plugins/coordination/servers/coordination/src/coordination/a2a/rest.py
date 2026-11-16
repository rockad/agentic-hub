"""The REST (`HTTP+JSON`) binding under `/a2a/v1` (spec 3.3, D5).

Paths follow `a2a.proto` as the SDK 1.3.0 routes them, each in two forms: plain (`/a2a/v1/tasks/{id}`)
and tenant-prefixed (`/a2a/v1/{tenant}/tasks/{id}`), the form a client uses when the card declares a
tenant. A tenant is a card id and contains `@`, which is legal in a path segment; handles contain
`/` and never travel in a path.

| operation | route |
| --- | --- |
| SendMessage | `POST /message:send` |
| SendStreamingMessage | `POST /message:stream` (-32004, HTTP 400) |
| GetTask | `GET /tasks/{id}` |
| ListTasks | `GET /tasks` |
| CancelTask | `POST /tasks/{id}:cancel` |
| SubscribeToTask | `GET` or `POST /tasks/{id}:subscribe` (-32004, HTTP 400) |
| Create, List | `POST`, `GET /tasks/{id}/pushNotificationConfigs` |
| Get, Delete | `GET`, `DELETE /tasks/{id}/pushNotificationConfigs/{push_id}` |
| GetExtendedAgentCard | `GET /extendedAgentCard` |

Success bodies are ProtoJSON with the media type `application/a2a+json`, as the SDK serves them.
Errors are `{"error": {"code": <http status>, "status": ..., "message": ..., "details": [ErrorInfo]}}`
with `application/json`. `A2A-Version: 1.0` is checked first, before the body is read (D33).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from a2a.types import a2a_pb2 as pb
from a2a.utils import proto_utils
from google.protobuf import json_format
from google.protobuf.message import Message
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import BaseRoute, Route

from coordination.a2a import errors as E
from coordination.a2a.cards import card_json
from coordination.a2a.context import VERSION_HEADER, caller_from_request, check_version
from coordination.a2a.operations import A2AOperations, CallContext, list_tasks_json
from coordination.service.directory import Directory

log = logging.getLogger("coordination.a2a")

A2A_JSON = "application/a2a+json"
PREFIX = "/a2a/v1"

Handler = Callable[[Request, CallContext], Awaitable[Response]]


class RestBinding:
    def __init__(self, ops: A2AOperations, directory: Directory) -> None:
        self._ops = ops
        self._directory = directory

    # -- plumbing --------------------------------------------------------------------------

    @staticmethod
    def _error(problem: E.A2AProblem) -> Response:
        headers = {"Cache-Control": "no-store", **problem.headers}
        return JSONResponse(problem.rest_body(), status_code=problem.http_status, headers=headers)

    @staticmethod
    def _ok(payload: dict[str, Any]) -> Response:
        return JSONResponse(payload, media_type=A2A_JSON, headers={"Cache-Control": "no-store"})

    def _route(self, handler: Handler) -> Callable[[Request], Awaitable[Response]]:
        async def endpoint(request: Request) -> Response:
            try:
                check_version(request.headers.get(VERSION_HEADER))
                caller = await caller_from_request(request, self._directory)
                ctx = CallContext(caller, tenant=request.path_params.get("tenant", ""))
                return await handler(request, ctx)
            except E.A2AProblem as problem:
                return self._error(problem)
            except Exception as exc:  # noqa: BLE001 - nothing of an unexpected failure goes back to the caller
                log.error("a2a rest failed", extra={"fields": {"error": type(exc).__name__}})
                return self._error(E.internal_error())

        return endpoint

    @staticmethod
    async def _body(request: Request, message: Message, *, required: bool) -> Message:
        raw = await request.body()
        if not raw.strip():
            if required:
                raise E.invalid_params("A JSON body is required.")
            return message
        try:
            return json_format.Parse(raw, message, ignore_unknown_fields=True)
        except json_format.ParseError:
            raise E.invalid_params("The body does not match the operation.") from None

    @staticmethod
    def _query(request: Request, message: Message) -> Message:
        try:
            proto_utils.parse_params(request.query_params, message)
        except (json_format.ParseError, ValueError):
            raise E.invalid_params("The query parameters do not match the operation.") from None
        return message

    # -- operations ------------------------------------------------------------------------

    async def send_message(self, request: Request, ctx: CallContext) -> Response:
        req = await self._body(request, pb.SendMessageRequest(), required=True)
        return self._ok(json_format.MessageToDict(await self._ops.send_message(ctx, req)))

    async def stream(self, request: Request, ctx: CallContext) -> Response:
        await self._ops.stream_unsupported(ctx)
        raise AssertionError("unreachable")  # pragma: no cover

    async def get_task(self, request: Request, ctx: CallContext) -> Response:
        req = self._query(request, pb.GetTaskRequest())
        req.id = request.path_params["id"]
        return self._ok(json_format.MessageToDict(await self._ops.get_task(ctx, req)))

    async def list_tasks(self, request: Request, ctx: CallContext) -> Response:
        req = self._query(request, pb.ListTasksRequest())
        result = await self._ops.list_tasks(ctx, req)
        return self._ok(list_tasks_json(result))

    async def cancel_task(self, request: Request, ctx: CallContext) -> Response:
        req = await self._body(request, pb.CancelTaskRequest(), required=False)
        req.id = request.path_params["id"]
        return self._ok(json_format.MessageToDict(await self._ops.cancel_task(ctx, req)))

    async def create_push(self, request: Request, ctx: CallContext) -> Response:
        req = await self._body(request, pb.TaskPushNotificationConfig(), required=True)
        req.task_id = request.path_params["id"]
        return self._ok(json_format.MessageToDict(await self._ops.create_push_config(ctx, req)))

    async def get_push(self, request: Request, ctx: CallContext) -> Response:
        req = pb.GetTaskPushNotificationConfigRequest(task_id=request.path_params["id"], id=request.path_params["push_id"])
        return self._ok(json_format.MessageToDict(await self._ops.get_push_config(ctx, req)))

    async def list_push(self, request: Request, ctx: CallContext) -> Response:
        req = self._query(request, pb.ListTaskPushNotificationConfigsRequest())
        req.task_id = request.path_params["id"]
        result = await self._ops.list_push_configs(ctx, req)
        return self._ok(json_format.MessageToDict(result, always_print_fields_with_no_presence=True))

    async def delete_push(self, request: Request, ctx: CallContext) -> Response:
        req = pb.DeleteTaskPushNotificationConfigRequest(task_id=request.path_params["id"], id=request.path_params["push_id"])
        await self._ops.delete_push_config(ctx, req)
        return self._ok({})

    async def extended_card(self, request: Request, ctx: CallContext) -> Response:
        card = await self._ops.get_extended_agent_card(ctx, pb.GetExtendedAgentCardRequest())
        return self._ok(card_json(card))

    # -- routes ----------------------------------------------------------------------------

    def routes(self) -> list[BaseRoute]:
        table: list[tuple[str, str, Handler]] = [
            ("/message:send", "POST", self.send_message),
            ("/message:stream", "POST", self.stream),
            # `:subscribe` and `:cancel` before `/tasks/{id}`, which would otherwise take the whole
            # segment (`{id}` matches a colon).
            ("/tasks/{id}:cancel", "POST", self.cancel_task),
            ("/tasks/{id}:subscribe", "GET", self.stream),
            ("/tasks/{id}:subscribe", "POST", self.stream),
            ("/tasks/{id}/pushNotificationConfigs/{push_id}", "GET", self.get_push),
            ("/tasks/{id}/pushNotificationConfigs/{push_id}", "DELETE", self.delete_push),
            ("/tasks/{id}/pushNotificationConfigs", "POST", self.create_push),
            ("/tasks/{id}/pushNotificationConfigs", "GET", self.list_push),
            ("/tasks/{id}", "GET", self.get_task),
            ("/tasks", "GET", self.list_tasks),
            ("/extendedAgentCard", "GET", self.extended_card),
        ]
        out: list[BaseRoute] = []
        for prefix in (PREFIX, PREFIX + "/{tenant}"):
            for path, method, handler in table:
                out.append(Route(prefix + path, self._route(handler), methods=[method]))
        return out
