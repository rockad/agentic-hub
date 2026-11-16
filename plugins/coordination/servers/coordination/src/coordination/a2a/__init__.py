"""`/a2a/v1` and the Agent Cards (S1-A2A).

- `cards`: the cards file, the registry, the card builder (member, extended, front desk).
- `operations`: the 11 operations over `CoordinationService`, transport-free.
- `jsonrpc`, `rest`: the two bindings, which parse, call one operation and render.
- `context`: the `A2A-Version` check (D33) and the caller built from the API key.
- `errors`: `A2AProblem` and how service errors map to the wire.
- `push`: push configuration and delivery, present and off (`A2A_PUSH_ENABLED=0`).

`build_a2a` wires them into one `A2AEndpoint`; `coordination.app.create_app` adds its routes behind
the shared access-control middleware. Spec: docs/specs/a2a.md.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncEngine
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import BaseRoute, Route

from coordination.a2a.cards import (
    CARD_CACHE_CONTROL,
    CardBuilder,
    CardDefinition,
    CardRegistry,
    CardsError,
    SessionLister,
    card_json,
    load_cards,
    load_cards_or_empty,
    parse_cards,
    sync_cards,
)
from coordination.a2a.jsonrpc import JsonRpcBinding
from coordination.a2a.operations import WAIT_POLL_S, A2AOperations, CallContext, Sleep
from coordination.a2a.push import (
    PushConfigs,
    PushSender,
    PushUrlRefused,
    Resolver,
    UrlValidator,
    address_is_blocked,
    screen_push_url,
    system_resolver,
)
from coordination.a2a.rest import RestBinding
from coordination.clock import Clock
from coordination.config import Config
from coordination.service import CoordinationService, ListenerView
from coordination.service.directory import Directory
from coordination.store.task_store import CoordTaskStore

if TYPE_CHECKING:
    import httpx


class A2AEndpoint:
    """The routes of `/a2a/v1` and the three kinds of Agent Card, for one server process."""

    def __init__(self, ops: A2AOperations, registry: CardRegistry, builder: CardBuilder, directory: Directory) -> None:
        self.ops = ops
        self.registry = registry
        self.builder = builder
        self._jsonrpc = JsonRpcBinding(ops, directory)
        self._rest = RestBinding(ops, directory)

    @staticmethod
    def _card_response(payload: dict) -> Response:
        return JSONResponse(payload, headers={"Cache-Control": CARD_CACHE_CONTROL})

    async def front_desk_card(self, request: Request) -> Response:
        """`GET /.well-known/agent-card.json`: public and generic, no member name (D32, Z13)."""
        return self._card_response(card_json(self.builder.front_desk()))

    async def member_card(self, request: Request) -> Response:
        """`GET /agents/<card>/.well-known/agent-card.json`: any valid API key (the middleware
        has checked it; D31, D32)."""
        definition = self.registry.get(request.path_params["card"])
        if definition is None:
            return JSONResponse(
                {"type": "about:blank", "title": "Not Found", "status": 404, "detail": "No such card."},
                status_code=404,
                media_type="application/problem+json",
                headers={"Cache-Control": "no-store"},
            )
        return self._card_response(card_json(self.builder.member(definition)))

    def routes(self) -> list[BaseRoute]:
        routes: list[BaseRoute] = [
            Route("/.well-known/agent-card.json", self.front_desk_card, methods=["GET"]),
            Route("/agents/{card}/.well-known/agent-card.json", self.member_card, methods=["GET"]),
            Route("/a2a/v1", self._jsonrpc.handle, methods=["POST"]),
        ]
        routes.extend(self._rest.routes())
        return routes


def build_a2a(
    config: Config,
    service: CoordinationService,
    store: CoordTaskStore,
    directory: Directory,
    engine: AsyncEngine,
    clock: Clock,
    *,
    registry: CardRegistry | None = None,
    listeners: ListenerView | None = None,
    sleep: Sleep = asyncio.sleep,
    poll_s: float = WAIT_POLL_S,
    monotonic: Callable[[], float] = time.monotonic,
    push_resolve: Resolver = system_resolver,
    push_validator: UrlValidator | None = None,
    push_transport: httpx.AsyncBaseTransport | None = None,
) -> A2AEndpoint:
    """The `/a2a/v1` endpoint for one server process. The keyword arguments after `registry` exist
    so a test can run a 60 second wait in virtual time and push against a fake resolver and
    transport; `main` passes none of them."""
    registry = registry if registry is not None else load_cards_or_empty(config.cards_file)
    builder = CardBuilder(config)
    sessions = SessionLister(engine, clock, listeners)
    push = sender = None
    if config.push_enabled:
        extra = {"validator": push_validator} if push_validator is not None else {}
        push = PushConfigs(
            engine, config.push_enc_key or "", config.push_allow_hosts, resolve=push_resolve, **extra
        )
        sender = PushSender(
            push.store, config.push_allow_hosts, resolve=push_resolve, transport=push_transport, **extra
        )
    ops = A2AOperations(
        config, service, store, registry, builder, sessions,
        push=push, sender=sender, sleep=sleep, poll_s=poll_s, monotonic=monotonic,
    )
    return A2AEndpoint(ops, registry, builder, directory)


__all__ = [
    "A2AEndpoint",
    "A2AOperations",
    "CallContext",
    "CardBuilder",
    "CardDefinition",
    "CardRegistry",
    "CardsError",
    "PushConfigs",
    "PushSender",
    "PushUrlRefused",
    "SessionLister",
    "address_is_blocked",
    "build_a2a",
    "load_cards",
    "parse_cards",
    "screen_push_url",
    "sync_cards",
]
