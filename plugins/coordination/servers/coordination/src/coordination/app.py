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
- the start-up checks of spec 1.6 in `main`, as one call (`coordination.auth.startup`)."""

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
    lifespan: Lifespan[Starlette] | None = None,
) -> Starlette:
    config = config if config is not None else load()
    clock = clock if clock is not None else SystemClock()
    routes = [Route("/healthz", healthz, methods=["GET"])]
    if config.status_enabled:
        routes.append(Route("/status", status, methods=["POST"]))
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
    return app


def build_server_app(config: Config) -> Starlette:
    """The app `main` serves: `create_app` with the Postgres-backed key store, so every request
    but `/healthz` and the public root card is authenticated. The engine connects on first use
    and is disposed when the app shuts down."""
    from coordination.auth.store import SqlApiKeyStore
    from coordination.store.engine import make_engine

    engine = make_engine(config)

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await engine.dispose()

    return create_app(config, key_store=SqlApiKeyStore(engine), lifespan=lifespan)


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
