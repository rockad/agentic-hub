"""ASGI application entry point. Serves `/healthz`; later streams mount routers here.

`main` checks that the database answers (S1-PG) before it serves. `create_app` does not touch it.

S1-OBS adds, here:

- the `Authorization` redaction middleware, outermost, so no later layer or log line sees the
  header value (`coordination.logging.middleware`);
- `POST /status`, registered only when `A2A_STATUS_ENABLED=1` (spec 3.6). It answers with the
  `dump_age_h` field and fails closed (401) until an authorizer is installed. The status
  intake itself (body schema, `status_runs`) is a later stream, so no body is read or stored."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from coordination.audit import AuditLog
from coordination.backup_status import STALE_AFTER_H, is_stale, status_fields
from coordination.clock import Clock, SystemClock
from coordination.config import Config, load
from coordination.logging import AuthorizationRedactionMiddleware, configure_logging

logger = logging.getLogger("coordination.app")

#: Decides whether a `/status` caller may use the endpoint (a `status-client` API key, spec 3.6).
#: S1-AUTH supplies the real one; until then `/status` answers 401 to everybody.
StatusAuthorizer = Callable[[Request], Awaitable[bool]]


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
) -> Starlette:
    config = config if config is not None else load()
    routes = [Route("/healthz", healthz, methods=["GET"])]
    if config.status_enabled:
        routes.append(Route("/status", status, methods=["POST"]))
    app = Starlette(
        routes=routes,
        # First in the list = outermost: the redaction runs before every other layer.
        middleware=[Middleware(AuthorizationRedactionMiddleware)],
    )
    app.state.config = config
    app.state.clock = clock if clock is not None else SystemClock()
    app.state.audit = audit  # None until S1-STORE provides a store to write to
    app.state.status_authorizer = status_authorizer
    return app


def main() -> None:
    import uvicorn

    from coordination.store.connect import check_database

    config = load()
    configure_logging(config.log_level, secrets=(config.key_pepper or "", config.push_enc_key or ""))
    # S1-PG: exit non-zero, with a message that carries no password, if Postgres does not answer.
    # S1-STORE replaces this with the pool start. /healthz stays a liveness check.
    check_database(config)
    host, port = config.listen_host_port
    # Exactly one worker is a requirement (spec 1.1): listeners and rate counters live in memory.
    # log_config=None: uvicorn's loggers propagate to the redacting JSON handler set above.
    uvicorn.run(
        create_app(config),
        host=host,
        port=port,
        workers=1,
        log_level=config.log_level,
        log_config=None,
    )
