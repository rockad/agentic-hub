"""`/mcp`: the MCP facade over the service layer (S1-MCP).

- `server`: the streamable-HTTP transport as one ASGI app (`McpEndpoint`).
- `tools`: the nine-tool closed set and the code behind it.
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
from coordination.mcp.server import McpEndpoint
from coordination.mcp.sessions import McpSessions, SessionRegistry
from coordination.mcp.tools import WAIT_POLL_S, McpTools, Sleep
from coordination.service import CoordinationService, ListenerView


def build_endpoint(
    config: Config,
    service: CoordinationService,
    engine: AsyncEngine,
    clock: Clock,
    *,
    audit: AuditLog | None = None,
    listeners: ListenerView | None = None,
    sleep: Sleep = asyncio.sleep,
    poll_s: float = WAIT_POLL_S,
) -> McpEndpoint:
    """The `/mcp` ASGI app for one server process. `listeners` is the same parked-listener view
    the service was given (WAKE owns the real one); `sleep` and `poll_s` exist so a test can run
    a 50 second wait in virtual time."""
    registry = SessionRegistry(engine, clock)
    tools = McpTools(config, service, registry, clock, audit=audit, listeners=listeners, sleep=sleep, poll_s=poll_s)
    sessions = McpSessions(clock, idle_ttl_s=config.session_idle_ttl_h * 3600)
    return McpEndpoint(tools, sessions)


__all__ = ["McpEndpoint", "McpSessions", "McpTools", "SessionRegistry", "build_endpoint"]
