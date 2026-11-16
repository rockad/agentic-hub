"""`a2a-coord review list|show|release|deny`, server side (S1-ADMIN; spec 8.3, decision D19).

A held task is a remote peer's task that waits for a human. This module is the ONLY caller of
`CoordinationService.release_hold` in the server: `tests/test_admin_release_path.py` searches the
source for any other caller and fails if there is one. No rule, no timer, no read and no agent
releases a task. The TTL sweep expires an unreleased one to `REJECTED`, which is a refusal.

Typed decision (D19, spec 8.3): `release` needs the exact phrase `release <last 6 characters of the
task id>` and `deny` needs `deny <last 6 characters>` [design: the spec fixes only the first]. The
CLI reads the phrase from `/dev/tty`, but this module checks it as well, so a request without the
right phrase (a hand-written one on the socket, a stale client) does nothing. There is one task per
call: no list argument, no `all`, no skip flag.

`show` returns the held body inside the untrusted frame of spec 4.1 (the S1-MCP frame, reused, so a
terminal escape sequence in a body is stripped and the size is capped before it is printed).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from a2a.types import a2a_pb2 as pb
from coordination.admin.protocol import PHRASE_CHARS, AdminError, phrase_for
from coordination.mcp.frame import build_frame, task_to_dict
from coordination.service import CoordinationService
from coordination.service import coord as C
from coordination.store.task_store import CoordTaskStore, IndexRow

#: Held tasks `show` looks through. The quota is 20 held per peer (spec 3.3.2), so this is not a limit
#: anyone reaches in practice; the list says how many were returned.
HELD_LIMIT = 200


def _text_bytes(task: pb.Task) -> int:
    return sum(len(p.text.encode()) for m in task.history for p in m.parts if p.WhichOneof("content") == "text")


def _summary(task: pb.Task, index: IndexRow) -> dict[str, Any]:
    block = C.coord_get(task)
    return {
        "task_id": task.id,
        "peer": index.from_principal,
        "card": index.to_card,
        "to_handle": index.to_handle,
        "received_at": block.get("created_at"),
        "expires_at": index.expires_at.isoformat() if index.expires_at else None,
        "size_bytes": _text_bytes(task),
    }


class ReviewAdmin:
    def __init__(self, service: CoordinationService, tasks: CoordTaskStore) -> None:
        self._service = service
        self._tasks = tasks

    @staticmethod
    def _task_id(args: Mapping[str, Any]) -> str:
        task_id = args.get("task_id")
        if not isinstance(task_id, str) or not (PHRASE_CHARS <= len(task_id) <= 64):
            raise AdminError("invalid_args", "task_id is required (the full task id)")
        return task_id

    async def _held(self) -> list[tuple[pb.Task, IndexRow]]:
        return await self._tasks.held_tasks(limit=HELD_LIMIT)

    async def list_held(self) -> dict[str, Any]:
        return {"held": [_summary(t, i) for t, i in await self._held()]}

    async def show(self, args: Mapping[str, Any]) -> dict[str, Any]:
        task_id = self._task_id(args)
        for task, index in await self._held():
            if task.id == task_id:
                return {**_summary(task, index), "frame": build_frame([task_to_dict(task)])}
        raise AdminError("not_found", f"no held task {task_id}")

    async def release(self, args: Mapping[str, Any], actor: str) -> dict[str, Any]:
        """`QUARANTINED` to `SUBMITTED`. The one call to `release_hold` in the server."""
        task_id = self._task_id(args)
        if args.get("phrase") != phrase_for("release", task_id):
            raise AdminError("phrase_mismatch", "the typed phrase does not match; nothing was released")
        task = await self._service.release_hold(task_id, actor=actor)
        return {"task_id": task.id, "state": pb.TaskState.Name(task.status.state), "released": True}

    async def deny(self, args: Mapping[str, Any], actor: str) -> dict[str, Any]:
        """`QUARANTINED` to `REJECTED` with reason `denied_by_human`."""
        task_id = self._task_id(args)
        if args.get("phrase") != phrase_for("deny", task_id):
            raise AdminError("phrase_mismatch", "the typed phrase does not match; nothing was denied")
        task = await self._service.deny_hold(task_id, actor=actor)
        return {"task_id": task.id, "state": pb.TaskState.Name(task.status.state), "denied": True}
