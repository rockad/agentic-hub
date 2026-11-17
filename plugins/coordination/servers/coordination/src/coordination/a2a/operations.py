"""The 11 A2A operations over the service layer (S1-A2A, spec 3.3.1 to 3.3.4).

Transport-free: `jsonrpc.py` and `rest.py` parse a request into the SDK's proto messages, build a
`CallContext`, call one method here and render what comes back (or the `A2AProblem` it raises).
Every task operation goes through `CoordinationService`; nothing here reimplements task logic, so
visibility, trust by origin, the state machine, `message_id` idempotency and the limits of spec
3.3 (8 parts, 32 KiB per text part, 200 history messages) are the service's, identical to `/mcp`.

What this module adds on top of the service:

- the closed method set, with the two stream operations answering -32004 and the four push
  operations answering -32003 while `A2A_PUSH_ENABLED=0`;
- the tenant rules (spec 3.3): empty tenant is the front desk, a message to it is refused with a
  pointer to the member card path (Z13); a remote-peer key's tenant outside `cards_allowed`, or one
  that is not a defined card, is `CardNotAllowed`, the same answer for both (X3);
- the blocking wait of `SendMessage` (D22): a request without `returnImmediately` waits at most
  `A2A_SEND_BLOCK_MAX_S` for a terminal or interrupted state, then returns the current task. The
  wait polls `get_task`: the service has no change notifier (service-layer.md section 4);
- history trimming (`historyLength`), artifact omission, and the extended card.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from a2a.types import a2a_pb2 as pb
from a2a.utils import errors as sdk_errors
from google.protobuf import json_format

from coordination.a2a import errors as E
from coordination.a2a.cards import CardBuilder, CardRegistry, SessionLister
from coordination.a2a.push import PushConfigs, PushSender
from coordination.config import Config
from coordination.service import Caller, CoordinationService
from coordination.service.errors import ServiceError
from coordination.service.types import CARD_RE
from coordination.store.task_store import CoordTaskStore

log = logging.getLogger("coordination.a2a")

S = pb.TaskState
#: A blocking `SendMessage` keeps waiting while the task is in one of these. Every other state is
#: terminal or interrupted (a held task is `INPUT_REQUIRED` on the wire), so the wait ends at once.
WAITING = frozenset({S.TASK_STATE_SUBMITTED, S.TASK_STATE_WORKING})
#: How often a blocking send looks at the task [design].
WAIT_POLL_S = 0.5

Sleep = Callable[[float], Awaitable[None]]


@dataclass(frozen=True)
class CallContext:
    """What a binding hands an operation: who is calling, and the tenant the URL named (REST
    `/a2a/v1/{tenant}/...`; empty for JSON-RPC and for the unprefixed REST form)."""

    caller: Caller
    tenant: str = ""


class A2AOperations:
    def __init__(
        self,
        config: Config,
        service: CoordinationService,
        store: CoordTaskStore,
        registry: CardRegistry,
        builder: CardBuilder,
        sessions: SessionLister,
        *,
        push: PushConfigs | None = None,
        sender: PushSender | None = None,
        sleep: Sleep = asyncio.sleep,
        poll_s: float = WAIT_POLL_S,
        monotonic: Callable[[], float] | None = None,
    ) -> None:
        self._config = config
        self._service = service
        self._store = store
        self._registry = registry
        self._builder = builder
        self._sessions = sessions
        self._push = push if config.push_enabled else None
        self.sender = sender if config.push_enabled else None
        self._sleep = sleep
        self._poll_s = poll_s
        self._monotonic = monotonic or time.monotonic

    # -- tenant ----------------------------------------------------------------------------

    @staticmethod
    def _merge_tenant(ctx: CallContext, body_tenant: str) -> str:
        if ctx.tenant and body_tenant and ctx.tenant != body_tenant:
            raise E.invalid_params("the tenant in the URL and the tenant in the body differ")
        return ctx.tenant or body_tenant

    def _check_tenant(self, caller: Caller, tenant: str) -> None:
        """A non-empty tenant must be a defined card; a remote-peer key's must also be in its
        `cards_allowed`. Both failures are the same `CardNotAllowed` for a peer (X3)."""
        if not tenant:
            return
        if not CARD_RE.match(tenant):
            raise E.invalid_params("tenant must be a card id")
        defined = tenant in self._registry
        if not caller.local:
            if tenant not in caller.cards_allowed or not defined:
                raise E.card_not_allowed()
        elif not defined:
            raise E.invalid_params("unknown card")

    # -- SendMessage -----------------------------------------------------------------------

    async def send_message(self, ctx: CallContext, req: pb.SendMessageRequest) -> pb.SendMessageResponse:
        caller = ctx.caller
        tenant = self._merge_tenant(ctx, req.tenant)
        if not tenant:
            raise E.front_desk()  # Z13: no member listing, no routing by metadata.target
        if not req.HasField("message"):
            raise E.invalid_params("message is required")
        cfg = req.configuration
        wants_push = cfg.HasField("task_push_notification_config")
        if wants_push and self._push is None:
            raise E.push_not_supported()
        metadata = json_format.MessageToDict(req.metadata) if req.HasField("metadata") else None
        task = await self._call(self._service.send_message(caller, tenant, req.message, metadata=metadata))
        if wants_push and self._push is not None:
            await self._push.create(caller.principal, task.id, cfg.task_push_notification_config)
        if not cfg.return_immediately:
            task = await self._wait(caller, task)
        _limit_history(task, cfg.history_length if cfg.HasField("history_length") else None)
        return pb.SendMessageResponse(task=task)

    async def _wait(self, caller: Caller, task: pb.Task) -> pb.Task:
        """D22: wait at most `A2A_SEND_BLOCK_MAX_S` for a terminal or interrupted state, then
        return the current task. A held task is already `INPUT_REQUIRED`, so it returns at once."""
        cap = max(0, self._config.send_block_max_s)
        if cap == 0 or task.status.state not in WAITING:
            return task
        deadline = self._monotonic() + cap
        while True:
            remaining = deadline - self._monotonic()
            if remaining <= 0:
                return task
            await self._sleep(min(self._poll_s, remaining))
            try:
                task = await self._service.get_task(caller, task.id)
            except ServiceError:
                return task  # gone or no longer visible: the last view is the answer
            if task.status.state not in WAITING:
                return task

    # -- reads and cancel ------------------------------------------------------------------

    async def get_task(self, ctx: CallContext, req: pb.GetTaskRequest) -> pb.Task:
        self._check_tenant(ctx.caller, self._merge_tenant(ctx, req.tenant))
        if not req.id:
            raise E.invalid_params("id is required")
        limit = req.history_length if req.HasField("history_length") else None
        if limit is not None and limit < 0:
            raise E.invalid_params("historyLength must not be negative")
        return await self._call(self._service.get_task(ctx.caller, req.id, history_length=limit))

    async def list_tasks(self, ctx: CallContext, req: pb.ListTasksRequest) -> pb.ListTasksResponse:
        self._check_tenant(ctx.caller, self._merge_tenant(ctx, req.tenant))
        if req.HasField("page_size") and not 1 <= req.page_size <= 100:
            raise E.invalid_params("pageSize is between 1 and 100")  # default 50, maximum 100 (spec 3.3.1)
        if req.HasField("history_length") and req.history_length < 0:
            raise E.invalid_params("historyLength must not be negative")
        response = await self._call(self._service.list_tasks(ctx.caller, req))
        limit = req.history_length if req.HasField("history_length") else None
        for task in response.tasks:
            _limit_history(task, limit)
            if not req.include_artifacts:
                del task.artifacts[:]
        return response

    async def cancel_task(self, ctx: CallContext, req: pb.CancelTaskRequest) -> pb.Task:
        self._check_tenant(ctx.caller, self._merge_tenant(ctx, req.tenant))
        if not req.id:
            raise E.invalid_params("id is required")
        return await self._call(self._service.cancel_task(ctx.caller, req.id))

    # -- unsupported at S1 -----------------------------------------------------------------

    async def stream_unsupported(self, ctx: CallContext) -> None:
        """`SendStreamingMessage` and `SubscribeToTask`: -32004 (spec 3.3.1; D35)."""
        raise E.unsupported_operation("Streaming is not supported: the card declares streaming false.")

    # -- extended card ---------------------------------------------------------------------

    async def get_extended_agent_card(self, ctx: CallContext, req: pb.GetExtendedAgentCardRequest) -> pb.AgentCard:
        tenant = self._merge_tenant(ctx, req.tenant)
        if not tenant:
            raise E.front_desk()
        self._check_tenant(ctx.caller, tenant)
        definition = self._registry.get(tenant)
        if definition is None:
            raise E.invalid_params("unknown card")
        sessions = await self._sessions.live(tenant) if ctx.caller.local else None  # never for a peer (D-H)
        return self._builder.extended(definition, sessions)

    # -- push (off at S1) ------------------------------------------------------------------

    def _push_service(self) -> PushConfigs:
        if self._push is None:
            raise E.push_not_supported()
        return self._push

    async def _originator_task(self, caller: Caller, task_id: str) -> None:
        """Only the originator may touch a task's push configs. A task the caller cannot see and a
        task the caller did not originate are the same `TaskNotFound`: a non-originator gets
        nothing."""
        if not task_id:
            raise E.invalid_params("taskId is required")
        await self._call(self._service.get_task(caller, task_id, history_length=0))
        index = await self._store.get_index(task_id)
        if index is None or index.from_principal != caller.principal:
            raise E.task_not_found("Task not found")

    async def create_push_config(self, ctx: CallContext, req: pb.TaskPushNotificationConfig) -> pb.TaskPushNotificationConfig:
        push = self._push_service()
        self._check_tenant(ctx.caller, self._merge_tenant(ctx, req.tenant))
        await self._originator_task(ctx.caller, req.task_id)
        return await push.create(ctx.caller.principal, req.task_id, req)

    async def get_push_config(self, ctx: CallContext, req: pb.GetTaskPushNotificationConfigRequest) -> pb.TaskPushNotificationConfig:
        push = self._push_service()
        self._check_tenant(ctx.caller, self._merge_tenant(ctx, req.tenant))
        await self._originator_task(ctx.caller, req.task_id)
        return await push.get(ctx.caller.principal, req.task_id, req.id)

    async def list_push_configs(
        self, ctx: CallContext, req: pb.ListTaskPushNotificationConfigsRequest
    ) -> pb.ListTaskPushNotificationConfigsResponse:
        push = self._push_service()
        self._check_tenant(ctx.caller, self._merge_tenant(ctx, req.tenant))
        await self._originator_task(ctx.caller, req.task_id)
        return pb.ListTaskPushNotificationConfigsResponse(configs=await push.list(ctx.caller.principal, req.task_id))

    async def delete_push_config(self, ctx: CallContext, req: pb.DeleteTaskPushNotificationConfigRequest) -> None:
        push = self._push_service()
        self._check_tenant(ctx.caller, self._merge_tenant(ctx, req.tenant))
        await self._originator_task(ctx.caller, req.task_id)
        await push.delete(ctx.caller.principal, req.task_id, req.id)

    # -- errors ----------------------------------------------------------------------------

    @staticmethod
    async def _call(awaitable):
        """Run a service call; a `ServiceError` becomes its A2A problem. Anything else is not
        caught here: the binding turns it into a constant internal error and logs the class."""
        try:
            return await awaitable
        except ServiceError as exc:
            raise E.from_service(exc) from None
        except sdk_errors.A2AError as exc:  # raised by the task store below the service
            raise E.from_sdk(exc) from None


def _limit_history(task: pb.Task, limit: int | None) -> None:
    """`historyLength`: keep the last `limit` messages (0 keeps none); unset keeps them all."""
    if limit is None or limit < 0 or len(task.history) <= limit:
        return
    kept = list(task.history)[len(task.history) - limit :] if limit else []
    del task.history[:]
    task.history.extend(kept)


def list_tasks_json(response: pb.ListTasksResponse) -> dict:
    """`ListTasksResponse` as ProtoJSON: the envelope fields are always present (`tasks`, `totalSize`,
    `pageSize`, an empty `nextPageToken`), the tasks themselves are printed as a Task is everywhere
    else, so a task without artifacts has no `artifacts` key."""
    body = json_format.MessageToDict(response, always_print_fields_with_no_presence=True)
    body["tasks"] = [json_format.MessageToDict(task) for task in response.tasks]
    return body
