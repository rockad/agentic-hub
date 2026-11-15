"""Builders shared by the S1-AUTH tests."""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime, timedelta

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from coordination.app import create_app
from coordination.auth import ApiKeyRecord, InMemoryApiKeyStore, Principal, generate_key, principal_from_scope
from coordination.config import Config

NOW = datetime(2026, 11, 15, 12, 0, 0, tzinfo=UTC)
HOST = "127.0.0.1:8120"


class FixedClock:
    """A `Clock` the test moves by hand."""

    def __init__(self, now: datetime = NOW) -> None:
        self._now = now
        self._mono = 0.0

    def now(self) -> datetime:
        return self._now

    def monotonic(self) -> float:
        return self._mono

    def advance(self, **kwargs: float) -> None:
        delta = timedelta(**kwargs)
        self._now += delta
        self._mono += delta.total_seconds()


def make_config(**overrides: object) -> Config:
    """The default dev, s1 configuration with fields replaced."""
    return dataclasses.replace(Config.from_env({}), **overrides)


def make_record(
    scope: str,
    *,
    env: str = "dev",
    pepper: str | None = None,
    expires_in: timedelta = timedelta(days=30),
    revoked: bool = False,
    **fields: object,
) -> tuple[str, ApiKeyRecord]:
    """A fresh key and its record. Returns (token, record); the token is never stored."""
    key = generate_key(env, pepper)
    record = ApiKeyRecord(
        key_id=key.key_id,
        env=env,
        name=f"test-{scope}",
        scope=scope,
        secret_hash=key.secret_hash,
        created_at=NOW - timedelta(days=1),
        expires_at=NOW + expires_in,
        revoked_at=NOW - timedelta(hours=1) if revoked else None,
        **fields,  # type: ignore[arg-type]
    )
    return key.token, record


def add_key(store: InMemoryApiKeyStore, scope: str, **kwargs: object) -> str:
    token, record = make_record(scope, **kwargs)  # type: ignore[arg-type]
    asyncio.run(store.insert(record))
    return token


def probe_app(config: Config, store, **kwargs):
    """The real app with a catch-all route behind it, so every path of the endpoint map reaches a
    handler that reports who the middleware says the caller is."""

    async def reached(request: Request) -> JSONResponse:
        principal: Principal | None = principal_from_scope(request.scope)
        return JSONResponse(
            {"reached": True, "key_id": principal.key_id if principal else None, "scope": principal.scope if principal else None},
            headers={"Cache-Control": request.query_params.get("cc", "max-age=5")},
        )

    kwargs.setdefault("clock", FixedClock())
    app = create_app(config, key_store=store, **kwargs)
    app.router.routes.append(Route("/{rest:path}", reached, methods=["GET", "POST", "DELETE", "PUT"]))
    return app


def client_for(app, *, peer: str = "127.0.0.1", host: str = HOST) -> TestClient:
    return TestClient(app, base_url=f"http://{host}", client=(peer, 50000), raise_server_exceptions=False)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
