"""Builders shared by the S1-ADMIN tests: a `KeyAdmin` on in-memory stores, a fake terminal and a
fake socket client for the CLI."""

from __future__ import annotations

import asyncio
import dataclasses
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from auth_helpers import FixedClock, make_config
from coordination.admin.hooks import RevokeHooks
from coordination.admin.keyadmin import KeyAdmin
from coordination.admin.keystore import InMemoryKeyAdminStore
from coordination.admin.protocol import AdminError
from coordination.audit import AuditLog, InMemoryAuditStore
from coordination.config import Config

CARDS = {"claude-code@box", "antigravity@box", "claude-code@mac"}
ACTOR = "admin:uid1000"


@dataclass
class KeyEnv:
    config: Config
    clock: FixedClock
    store: InMemoryKeyAdminStore
    audit_store: InMemoryAuditStore
    hooks: RevokeHooks
    admin: KeyAdmin

    def call(self, coro):
        return asyncio.run(coro)

    def create(self, **args: Any) -> dict[str, Any]:
        return asyncio.run(self.admin.create(args, ACTOR))


def key_env(**config_overrides: object) -> KeyEnv:
    config = make_config(**config_overrides)
    clock = FixedClock()
    store = InMemoryKeyAdminStore()
    audit_store = InMemoryAuditStore()
    hooks = RevokeHooks()

    async def card_exists(card_id: str) -> bool:
        return card_id in CARDS

    admin = KeyAdmin(config, clock, store, AuditLog(audit_store, clock), hooks, card_exists)
    return KeyEnv(config, clock, store, audit_store, hooks, admin)


def refused(env: KeyEnv, **args: Any) -> AdminError:
    """The `AdminError` a `create` call raises."""
    try:
        asyncio.run(env.admin.create(args, ACTOR))
    except AdminError as exc:
        return exc
    raise AssertionError("expected the key to be refused")


class FakeTerminal:
    """A terminal the test controls: what `isatty` says and what is typed on `/dev/tty`."""

    def __init__(self, *, stdin: bool = True, stdout: bool = True, typed: str | None = None) -> None:
        self._stdin, self._stdout, self.typed = stdin, stdout, typed
        self.prompts: list[str] = []

    def stdin_isatty(self) -> bool:
        return self._stdin

    def stdout_isatty(self) -> bool:
        return self._stdout

    def read_confirmation(self, prompt: str) -> str | None:
        self.prompts.append(prompt)
        return self.typed


@dataclass
class FakeClient:
    """Stands in for the admin socket: records every call, answers from `replies`."""

    replies: dict[str, dict[str, Any] | AdminError] = field(default_factory=dict)
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)

    def call(self, cmd: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        self.calls.append((cmd, dict(args or {})))
        reply = self.replies.get(cmd, {})
        if isinstance(reply, AdminError):
            raise reply
        return reply

    def commands(self) -> list[str]:
        return [c for c, _ in self.calls]


def factory(client: FakeClient) -> Callable[[str], FakeClient]:
    return lambda _path: client


def replace_config(config: Config, **kw: object) -> Config:
    return dataclasses.replace(config, **kw)
