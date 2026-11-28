"""`/mcp`: the MCP facade over the service layer (S1-MCP).

- `server`: the streamable-HTTP transport as one ASGI app (`McpEndpoint`).
- `tools`: the ten-tool closed set and the code behind it.
- `frame`: the untrusted-data result frame of spec 4.1.
- `sanitize`: control and escape-sequence stripping, byte truncation.
- `sessions`: the `Mcp-Session-Id` map (not agy) and the durable session registry (agy).
- `schema`: the argument checker for the tool schemas.

`build_endpoint` wires them. `coordination.app.create_app` mounts the result at `/mcp` behind the
shared access-control middleware.
"""

from __future__ import annotations

import asyncio

from sqlalchemy.ext.asyncio import AsyncEngine

from coordination.audit import AuditLog
from coordination.clock import Clock
from coordination.config import Config
from coordination.identity import IdentityService
from coordination.mcp.server import McpEndpoint
from coordination.mcp.sessions import McpSessions, SessionRegistry
from coordination.mcp.tools import WAIT_POLL_S, Confirm, McpTools, Sleep
from coordination.service import CoordinationService, ListenerView


def build_endpoint(
    config: Config,
    service: CoordinationService,
    engine: AsyncEngine,
    clock: Clock,
    *,
    audit: AuditLog | None = None,
    listeners: ListenerView | None = None,
    identity: IdentityService | None = None,
    confirm: Confirm | None = None,
    sleep: Sleep = asyncio.sleep,
    poll_s: float = WAIT_POLL_S,
) -> McpEndpoint:
    """The `/mcp` ASGI app for one server process. `listeners` is the same parked-listener view
    the service was given (S1-WAKE's `ListenerTable`); `identity` is the S1-ID service the
    `/sessions` routes share (one is built over the same registry when none is given); `confirm`
    is S1-WAKE's wake confirmation, called by `a2a_inbox`, `a2a_wait` and `a2a_hello` (spec 7.5);
    `sleep` and `poll_s` exist so a test can run a 50 second wait in virtual time."""
    if identity is None:
        identity = IdentityService(
            SessionRegistry(engine, clock), clock, audit=audit, listeners=listeners, pending=service.pending_count
        )
    tools = McpTools(
        config,
        service,
        identity.registry,
        clock,
        audit=audit,
        listeners=listeners,
        identity=identity,
        confirm=confirm,
        sleep=sleep,
        poll_s=poll_s,
    )
    sessions = McpSessions(clock, idle_ttl_s=config.session_idle_ttl_h * 3600)
    return McpEndpoint(tools, sessions)


__all__ = ["McpEndpoint", "McpSessions", "McpTools", "SessionRegistry", "build_endpoint"]
