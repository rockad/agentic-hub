"""Service layer interfaces. S1-STATE implements them; `/a2a/v1` and `/mcp` both call them."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol, runtime_checkable

from a2a.types import a2a_pb2 as pb
from coordination.service.types import Caller, InboxResult, SweepResult, WakeSnapshot


@runtime_checkable
class ServiceLayer(Protocol):
    async def pending_count(self, handle: str) -> int:
        """Wakeable-eligible tasks for `handle`, no bodies (spec 7.5)."""
        ...


@runtime_checkable
class TaskService(Protocol):
    """The whole task API, as the two bindings use it. Every method takes a `Caller` built from
    the API key and raises `coordination.service.errors.ServiceError` subclasses."""

    async def send_message(
        self, caller: Caller, tenant: str, message: pb.Message, *, metadata: Mapping[str, Any] | None = None
    ) -> pb.Task: ...

    async def get_task(self, caller: Caller, task_id: str, *, history_length: int | None = None) -> pb.Task: ...

    async def list_tasks(self, caller: Caller, request: pb.ListTasksRequest) -> pb.ListTasksResponse: ...

    async def cancel_task(self, caller: Caller, task_id: str, *, reason: str | None = None) -> pb.Task: ...

    async def inbox(self, caller: Caller, *, limit: int = 10, include_followups: bool = True) -> InboxResult: ...

    async def claim(self, caller: Caller, task_id: str) -> pb.Task: ...

    async def respond(
        self,
        caller: Caller,
        task_id: str,
        state: str,
        *,
        text: str | None = None,
        artifacts: Sequence[Mapping[str, str]] = (),
    ) -> pb.Task: ...

    async def pending_count(self, handle: str) -> int: ...

    async def has_wake_pending(self, handle: str) -> bool: ...

    async def wake_snapshot(self, handle: str) -> WakeSnapshot: ...

    async def wake_pending_set(self, handle: str) -> frozenset[str]: ...

    async def held_count(self, card_id: str) -> int: ...

    async def release_hold(self, task_id: str, *, actor: str) -> pb.Task: ...

    async def deny_hold(self, task_id: str, *, actor: str) -> pb.Task: ...

    async def held_tasks(self, card_id: str | None = None) -> list[pb.Task]: ...

    async def sweep(self) -> SweepResult: ...
