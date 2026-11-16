"""ASGI application entry point. Serves `/healthz`; later streams mount routers here.

`main` checks that the database answers (S1-PG) before it serves. `create_app` does not touch it.

S1-OBS adds, here:

- the `Authorization` redaction middleware, outermost, so no later layer or log line sees the
  header value (`coordination.logging.middleware`);
- `POST /status`, registered only when `A2A_STATUS_ENABLED=1` (spec 3.6). It answers with the
  `dump_age_h` field and fails closed (401) until an authorizer is installed. The status
  intake itself (body schema, `status_runs`) is a later stream, so no body is read or stored.

S1-AUTH adds, here:

- the access-control middleware (`coordination.auth.middleware`), second in the list, right
  behind the redaction, when `create_app` is given a `key_store`. Without a key store no
  middleware is installed and the app serves what it always served (tests, and any caller that
  builds an app only to probe a handler). `main` always passes one, so the running server
  authenticates every request but `/healthz` and the public root card;
- the real `/status` authorizer: the caller's key must have the `status-client` scope;
- the start-up checks of spec 1.6 in `main`, as one call (`coordination.auth.startup`).

S1-MCP adds, here:

- `/mcp`, the streamable-HTTP MCP app (`coordination.mcp`), mounted as one more route of this
  Starlette app, so the same redaction and access-control middleware runs in front of it. It is
  only mounted when `create_app` is given an `mcp` endpoint; a bare `create_app` serves what it
  always served. `main` builds one over the service layer (`build_server_app`);
- the wiring `build_server_app` needed for that: the SQL audit store (so the service and the
  middleware write the `audit` table, which S1-AUTH's doc listed as not wired) and the S1-STATE
  `CoordinationService`. The service's TTL sweep loop is not started here: neither stream owns it.

S1-A2A adds, here:

- `/a2a/v1` (JSON-RPC and REST) and the Agent Cards (`coordination.a2a`): the root front-desk card
  (public), `/agents/<card>/.well-known/agent-card.json` (any valid key), and the 11 operations
  over the same service layer `/mcp` uses. Routes are only added when `create_app` is given an
  `a2a` endpoint; `main` builds one in `build_server_app`, which also writes the cards file into
  the `cards` table when the app starts (the service layer reads that table).

S1-ADMIN adds, here (wiring only; the admin plane is `coordination.admin`):

- the admin socket (`A2A_ADMIN_SOCKET`, mode 0600, an `AF_UNIX` listener and nothing else). It is
  not an HTTP route and has no scope: `create_app` takes an `admin` server only to keep it on
  `app.state.admin`, where S1-WAKE reaches `admin.hooks` to register what a key revocation must
  close. `main` builds it in `build_server_app`, whose lifespan starts and stops it. A socket that
  cannot be opened stops the server from starting."""

from __future__ import annotations

import contextlib
import logging
from collections.abc import AsyncIterator, Awaitable, Callable

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
from starlette.types import Lifespan

from coordination.a2a import A2AEndpoint
from coordination.admin.server import AdminServer
from coordination.audit import AuditLog
from coordination.auth.middleware import (
    AccessControlMiddleware,
    IdentitySource,
    RateLimiter,
    principal_from_scope,
)
from coordination.auth.records import STATUS_CLIENT
from coordination.auth.store import ApiKeyStore
from coordination.backup_status import STALE_AFTER_H, is_stale, status_fields
from coordination.clock import Clock, SystemClock
from coordination.config import Config, load
from coordination.logging import AuthorizationRedactionMiddleware, configure_logging
from coordination.mcp import McpEndpoint

logger = logging.getLogger("coordination.app")

#: Exactly one worker is a requirement (spec 1.1): listeners and rate counters live in memory.
#: `main` hands this to uvicorn and to the start-up check, so the two cannot disagree.
WORKERS = 1

#: Decides whether a `/status` caller may use the endpoint (a `status-client` API key, spec 3.6).
#: With a key store, `create_app` installs `status_client_authorizer`; without an authorizer
#: `/status` answers 401 to everybody.
StatusAuthorizer = Callable[[Request], Awaitable[bool]]


async def status_client_authorizer(request: Request) -> bool:
    """True if the access-control middleware accepted a key with the `status-client` scope."""
    principal = principal_from_scope(request.scope)
    return principal is not None and principal.scope == STATUS_CLIENT


def _problem(status: int, title: str, detail: str, headers: dict[str, str] | None = None) -> Response:
    """`application/problem+json` (RFC 9457), the error shape of spec 2.1."""
    response = JSONResponse(
        {"type": "about:blank", "title": title, "status": status, "detail": detail},
        status_code=status,
        media_type="application/problem+json",
    )
    response.headers.update(headers or {})
    return response


async def healthz(request: Request) -> JSONResponse:
    """Unauthenticated, no Host check, returns `{"ok":true}` and nothing else (spec 3.7)."""
    return JSONResponse({"ok": True})


async def status(request: Request) -> Response:
    """`POST /status`: today only the `dump_age_h` field of the response (spec 3.6)."""
    authorizer: StatusAuthorizer | None = request.app.state.status_authorizer
    if authorizer is None or not await authorizer(request):
        return _problem(
            401,
            "Unauthorized",
            "Authentication required.",
            {"WWW-Authenticate": "Bearer", "Cache-Control": "no-store"},
        )
    config: Config = request.app.state.config
    clock: Clock = request.app.state.clock
    fields = status_fields(config.dump_last_ok_file, clock.now())
    if is_stale(fields["dump_age_h"]):
        logger.warning(
            "database dump is stale",
            extra={"fields": {"dump_age_h": fields["dump_age_h"], "stale_after_h": STALE_AFTER_H}},
        )
    return JSONResponse(fields, headers={"Cache-Control": "no-store"})


def create_app(
    config: Config | None = None,
    *,
    clock: Clock | None = None,
    audit: AuditLog | None = None,
    status_authorizer: StatusAuthorizer | None = None,
    key_store: ApiKeyStore | None = None,
    rate_limiter: RateLimiter | None = None,
    identity_source: IdentitySource | None = None,
    mcp: McpEndpoint | None = None,
    a2a: A2AEndpoint | None = None,
    admin: AdminServer | None = None,
    lifespan: Lifespan[Starlette] | None = None,
) -> Starlette:
    config = config if config is not None else load()
    clock = clock if clock is not None else SystemClock()
    routes = [Route("/healthz", healthz, methods=["GET"])]
    if config.status_enabled:
        routes.append(Route("/status", status, methods=["POST"]))
    if mcp is not None:
        # The ASGI app of `/mcp` as a route, not a `Mount`: a `Mount("/mcp")` answered 307 and then
        # 404 in the SP5 D12 spike. The scope check (`local-harness` only) is in the middleware.
        routes.append(Route("/mcp", mcp, methods=["GET", "POST", "DELETE"]))
    if a2a is not None:
        routes.extend(a2a.routes())
    # First in the list = outermost: the redaction runs before every other layer, the access
    # control included, so the access control only ever sees the masked header and the Credential.
    middleware = [Middleware(AuthorizationRedactionMiddleware)]
    if key_store is not None:
        middleware.append(
            Middleware(
                AccessControlMiddleware,
                config=config,
                keys=key_store,
                clock=clock,
                audit=audit,
                rate_limiter=rate_limiter,
                identity_source=identity_source,
            )
        )
        if status_authorizer is None:
            status_authorizer = status_client_authorizer
    app = Starlette(routes=routes, middleware=middleware, lifespan=lifespan)
    app.state.config = config
    app.state.clock = clock
    app.state.audit = audit  # None until a store that implements append_audit is wired in
    app.state.status_authorizer = status_authorizer
    app.state.a2a = a2a
    app.state.mcp = mcp  # S1-ADMIN reaches `mcp.sessions.drop_key` through it when it revokes a key
    app.state.admin = admin  # not a route: the Unix socket, started by `build_server_app`'s lifespan
    return app


def build_server_app(config: Config) -> Starlette:
    """The app `main` serves: `create_app` with the Postgres-backed key store, so every request
    but `/healthz` and the public root card is authenticated. The engine connects on first use
    and is disposed when the app shuts down."""
    from coordination.a2a import build_a2a, load_cards_or_empty, sync_cards
    from coordination.admin.keystore import SqlKeyAdminStore
    from coordination.admin.wiring import build_admin
    from coordination.audit import SqlAuditStore
    from coordination.mcp import build_endpoint
    from coordination.service import CoordinationService, Directory, ServiceSettings
    from coordination.store.engine import make_engine
    from coordination.store.task_store import CoordTaskStore

    engine = make_engine(config)
    clock = SystemClock()
    audit = AuditLog(SqlAuditStore(engine), clock)
    task_store = CoordTaskStore(engine, clock=clock)
    directory = Directory(engine)
    service = CoordinationService(task_store, directory, audit, clock, ServiceSettings.from_config(config))
    mcp = build_endpoint(config, service, engine, clock, audit=audit)
    cards = load_cards_or_empty(config.cards_file)
    a2a = build_a2a(config, service, task_store, directory, engine, clock, registry=cards)
    keys = SqlKeyAdminStore(engine)  # the S1-AUTH store, plus list and rotate for the admin commands
    admin = build_admin(config, clock, engine, service, task_store, audit, directory, cards, keys=keys, mcp=mcp)

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        started = False
        try:
            # The service layer reads the `cards` table to decide whether a card exists; the cards
            # file is its source (spec 1.3). Written here, not at import, so building the app
            # never touches the database.
            await sync_cards(engine, cards)
            # The admin socket opens only after the cards are in the table, because `key create`
            # checks them. If it cannot open, the exception stops the server: no fallback.
            await admin.start()
            started = True
            yield
        finally:
            if started:
                await admin.stop()
            await engine.dispose()

    return create_app(
        config, clock=clock, audit=audit, key_store=keys, mcp=mcp, a2a=a2a, admin=admin, lifespan=lifespan
    )


def main() -> None:
    import uvicorn

    from coordination.auth.startup import startup_check

    # Spec 1.6: every start-up condition, then S1-PG's database check (which also runs the
    # migrations and refuses a schema newer than this code). Exits non-zero with one line.
    config = startup_check(workers=WORKERS)
    configure_logging(config.log_level, secrets=(config.key_pepper or "", config.push_enc_key or ""))
    host, port = config.listen_host_port
    # log_config=None: uvicorn's loggers propagate to the redacting JSON handler set above.
    uvicorn.run(
        build_server_app(config),
        host=host,
        port=port,
        workers=WORKERS,
        log_level=config.log_level,
        log_config=None,
    )
