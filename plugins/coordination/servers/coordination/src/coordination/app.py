"""ASGI application entry point. S1-SCAF serves `/healthz` only; later streams mount routers here."""

from __future__ import annotations

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from coordination.config import Config, load


async def healthz(request: Request) -> JSONResponse:
    """Unauthenticated, no Host check, leaks nothing (spec 3.7)."""
    return JSONResponse({"ok": True})


def create_app(config: Config | None = None) -> Starlette:
    app = Starlette(routes=[Route("/healthz", healthz, methods=["GET"])])
    app.state.config = config if config is not None else load()
    return app


def main() -> None:
    import uvicorn

    config = load()
    host, port = config.listen_host_port
    # Exactly one worker is a requirement (spec 1.1): listeners and rate counters live in memory.
    uvicorn.run(create_app(config), host=host, port=port, workers=1, log_level=config.log_level)
