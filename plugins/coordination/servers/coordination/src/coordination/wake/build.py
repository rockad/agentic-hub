"""`build_wake`: the wake service wired for one server process (S1-WAKE)."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncEngine

from coordination.audit import AuditLog
from coordination.clock import Clock
from coordination.config import Config
from coordination.identity.registry import SessionRegistry
from coordination.wake.service import RECHECK_S, WakeService
from coordination.wake.store import WakeStore
from coordination.wake.table import ListenerTable


def build_wake(
    config: Config,
    engine: AsyncEngine,
    clock: Clock,
    registry: SessionRegistry,
    *,
    audit: AuditLog | None = None,
    table: ListenerTable | None = None,
    recheck_s: float = RECHECK_S,
) -> WakeService:
    """The wake service for one server process. Give `wake.table` to the task service, the MCP
    endpoint and the identity service as their `ListenerView`, and the service itself as the task
    service's `notifier`; then call `wake.bind(task_service)`. `registry` is the one the identity
    service and the MCP tools use, so a `touch` is throttled once for all of them."""
    return WakeService(
        config,
        clock,
        WakeStore(engine),
        registry,
        table if table is not None else ListenerTable(),
        audit=audit,
        recheck_s=recheck_s,
    )
