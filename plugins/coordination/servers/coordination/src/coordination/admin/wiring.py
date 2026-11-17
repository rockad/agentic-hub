"""`build_admin`: the admin plane wired for one server process (S1-ADMIN).

`coordination.app.build_server_app` calls it and starts the socket with the app's lifespan. Revoking
a key drops its MCP sessions (S1-MCP's `McpSessions.drop_key`); the parked-listener hook is
registered by S1-WAKE on `server.hooks`, and `listener_count` is likewise WAKE's, for `status`.
"""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy.ext.asyncio import AsyncEngine

from coordination.a2a.cards import CardRegistry
from coordination.admin.hooks import RevokeHooks
from coordination.admin.keyadmin import KeyAdmin
from coordination.admin.keystore import KeyAdminStore, SqlKeyAdminStore
from coordination.admin.ops import AdminOps
from coordination.admin.review import ReviewAdmin
from coordination.admin.server import AdminServer
from coordination.admin.status import StatusAdmin
from coordination.audit import AuditLog
from coordination.clock import Clock
from coordination.config import Config
from coordination.mcp import McpEndpoint
from coordination.service import CoordinationService, Directory
from coordination.store.task_store import CoordTaskStore


def build_admin(
    config: Config,
    clock: Clock,
    engine: AsyncEngine,
    service: CoordinationService,
    task_store: CoordTaskStore,
    audit: AuditLog,
    directory: Directory,
    registry: CardRegistry,
    *,
    keys: KeyAdminStore | None = None,
    mcp: McpEndpoint | None = None,
    listener_count: Callable[[], int] | None = None,
) -> AdminServer:
    """The admin socket for one server process. Revoking a key drops its MCP sessions (S1-MCP's
    `McpSessions.drop_key`); the parked-listener hook is registered by S1-WAKE on
    `server.hooks`. `listener_count` is likewise WAKE's, for `status`."""
    keys = keys if keys is not None else SqlKeyAdminStore(engine)
    hooks = RevokeHooks()
    if mcp is not None:
        hooks.register("mcp", mcp.sessions.drop_key)
    key_admin = KeyAdmin(config, clock, keys, audit, hooks, directory.card_exists)
    review = ReviewAdmin(service, task_store)
    status = StatusAdmin(
        config,
        clock,
        engine,
        keys,
        registry,
        mcp_session_count=(lambda: len(mcp.sessions)) if mcp is not None else None,
        listener_count=listener_count,
    )
    return AdminServer(config.admin_socket, AdminOps(key_admin, review, status), hooks)


__all__ = ["build_admin"]
