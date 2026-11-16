"""Builders shared by the S1-A2A tests: the real app (the real access-control middleware over the SQL
key store, the real service layer, the real `/a2a/v1` and card routes, a real Postgres) and a thin
client over the Starlette test client for both bindings.

Nothing here fakes the thing under test. The stand-ins are the clock (a hand-moved `FixedClock`),
`sleep` for the blocking wait (advances that clock instead of waiting, and can run a hook so a
test can change the task while a request is parked) and, for push, a fake resolver and transport.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from a2a.types import a2a_pb2 as pb
from auth_helpers import bearer
from conftest import run
from mcp_helpers import (
    CARD_AGY,
    CARD_CLAUDE,
    CARD_MAC,
    HOST,
    H_AGY,
    H_CLAUDE,
    H_CLAUDE2,
    McpEnv,
    local_caller,
    make_env,
    peer_caller,
)
from starlette.testclient import TestClient

from coordination.a2a import CardRegistry, build_a2a, parse_cards
from coordination.app import create_app
from coordination.auth import SqlApiKeyStore
from coordination.service import Directory

__all__ = [
    "CARD_AGY", "CARD_CLAUDE", "CARD_MAC", "H_AGY", "H_CLAUDE", "H_CLAUDE2", "HOST", "A2AEnv", "Wire",
    "local_caller", "make_a2a_env", "peer_caller", "text_message", "SENT",
]

V = {"A2A-Version": "1.0"}
SENT = "Hello from a test."

CARDS_YAML = f"""
cards:
  - name: {CARD_CLAUDE}
    description: Claude Code sessions on box.
    version: "0.1.0"
    skills:
      - id: parked-task-exchange
        name: Parked task exchange
        description: Accepts a task for a live session.
        tags: [coordination]
        examples: ["Ask the session to review the plan."]
  - name: {CARD_AGY}
    description: Antigravity sessions on box.
  - name: {CARD_MAC}
"""


def text_message(text: str = SENT, *, message_id: str | None = None, task_id: str | None = None, context_id: str | None = None) -> dict:
    """A `Message` in ProtoJSON, as a client sends it."""
    msg: dict[str, Any] = {"messageId": message_id or str(uuid.uuid4()), "role": "ROLE_USER", "parts": [{"text": text}]}
    if task_id:
        msg["taskId"] = task_id
    if context_id:
        msg["contextId"] = context_id
    return msg


@dataclass
class A2AEnv:
    base: McpEnv
    registry: CardRegistry
    sleeps: list[float] = field(default_factory=list)
    on_sleep: list[Callable[[float], Any]] = field(default_factory=list)

    @property
    def keys(self):
        return self.base.keys

    @property
    def engine(self):
        return self.base.engine

    @property
    def config(self):
        return self.base.config

    def app(self, **kwargs: Any):
        async def sleep(seconds: float) -> None:
            self.sleeps.append(seconds)
            self.base.clock.advance(seconds=seconds)
            for hook in list(self.on_sleep):
                result = hook(self.base.clock.monotonic())
                if asyncio.iscoroutine(result):
                    await result
            await asyncio.sleep(0)

        a2a_kwargs = {
            "registry": self.registry,
            "sleep": sleep,
            "poll_s": kwargs.pop("poll_s", 1.0),
            "monotonic": self.base.clock.monotonic,
        }
        for name in ("push_resolve", "push_validator", "push_transport", "listeners"):
            if name in kwargs:
                a2a_kwargs[name] = kwargs.pop(name)
        if kwargs.pop("real_time", False):
            a2a_kwargs.pop("sleep"), a2a_kwargs.pop("monotonic"), a2a_kwargs.pop("poll_s")
            a2a_kwargs["poll_s"] = 0.2
        endpoint = build_a2a(
            self.config, self.base.service, self.base.store, Directory(self.engine), self.engine, self.base.clock,
            **a2a_kwargs,
        )
        return create_app(
            self.config, clock=self.base.clock, audit=self.base.audit_log, key_store=SqlApiKeyStore(self.engine),
            a2a=endpoint, **kwargs,
        )

    def wire(self, app=None, *, peer: str = "127.0.0.1") -> Wire:
        return Wire(TestClient(app or self.app(), base_url=f"http://{HOST}", client=(peer, 50000), raise_server_exceptions=False))


def make_a2a_env(pg_db, **config_overrides: Any) -> A2AEnv:
    base = make_env(pg_db, **config_overrides)
    return A2AEnv(base, parse_cards(CARDS_YAML))


class Wire:
    """JSON-RPC and REST calls with a key, the `A2A-Version` header on by default."""

    def __init__(self, http: TestClient) -> None:
        self.http = http
        self._id = 0

    def headers(self, token: str | None, *, version: str | None = "1.0", extra: dict | None = None) -> dict:
        h = dict(bearer(token)) if token else {}
        if version is not None:
            h["A2A-Version"] = version
        h.update(extra or {})
        return h

    # -- JSON-RPC --------------------------------------------------------------------------

    def rpc_raw(self, token: str | None, body: Any, *, version: str | None = "1.0", extra: dict | None = None):
        h = self.headers(token, version=version, extra=extra)
        h.setdefault("Content-Type", "application/json")
        data = body if isinstance(body, bytes | str) else json.dumps(body).encode()
        return self.http.post("/a2a/v1", content=data, headers=h)

    def rpc(self, token: str | None, method: str, params: dict | None = None, *, version: str | None = "1.0", extra: dict | None = None):
        self._id += 1
        body: dict[str, Any] = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            body["params"] = params
        return self.rpc_raw(token, body, version=version, extra=extra)

    def result(self, token: str, method: str, params: dict | None = None, *, extra: dict | None = None) -> dict:
        response = self.rpc(token, method, params, extra=extra)
        assert response.status_code == 200, (response.status_code, response.text[:400])
        body = response.json()
        assert "result" in body, body
        return body["result"]

    def error(self, token: str | None, method: str, params: dict | None = None, *, version: str | None = "1.0", extra: dict | None = None) -> dict:
        response = self.rpc(token, method, params, version=version, extra=extra)
        body = response.json()
        assert "error" in body, body
        return body["error"]

    # -- REST ------------------------------------------------------------------------------

    def rest(self, token: str | None, method: str, path: str, *, json_body: Any = None, params: dict | None = None,
             version: str | None = "1.0", extra: dict | None = None):
        h = self.headers(token, version=version, extra=extra)
        kwargs: dict[str, Any] = {"headers": h, "params": params}
        if json_body is not None:
            kwargs["content"] = json.dumps(json_body).encode()
            h["Content-Type"] = "application/json"
        return self.http.request(method, "/a2a/v1" + path, **kwargs)

    # -- cards -----------------------------------------------------------------------------

    def card(self, path: str, token: str | None = None):
        return self.http.get(path, headers=self.headers(token, version=None))


def send_params(tenant: str, text: str = SENT, *, immediate: bool = True, message_id: str | None = None, **message_kw: Any) -> dict:
    params: dict[str, Any] = {"tenant": tenant, "message": text_message(text, message_id=message_id, **message_kw)}
    if immediate:
        params["configuration"] = {"returnImmediately": True}
    return params


def task_in(env: A2AEnv, task_id: str, caller) -> pb.Task:
    return run(env.base.service.get_task(caller, task_id))
