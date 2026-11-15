"""The API key record and the principal a request carries once its key is accepted (S1-AUTH)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

LOCAL_HARNESS = "local-harness"
REMOTE_PEER = "remote-peer"
STATUS_CLIENT = "status-client"
#: The three scopes of spec 8.1. There is no admin scope (D15): admin is the in-container socket.
SCOPES = (LOCAL_HARNESS, REMOTE_PEER, STATUS_CLIENT)


@dataclass(frozen=True)
class ApiKeyRecord:
    """One row of `api_keys` (spec 1.3). `secret_hash` stays out of every repr."""

    key_id: str
    env: str
    name: str
    scope: str
    secret_hash: str = field(repr=False)
    created_at: datetime
    expires_at: datetime
    card_id: str | None = None  # owner card (local-harness)
    peer_id: str | None = None  # remote-peer
    cards_allowed: tuple[str, ...] | None = None  # remote-peer allowlist entry (D18)
    tailnet_node: str | None = None  # D17, D23
    tailnet_login: str | None = None
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None


@dataclass(frozen=True)
class Principal:
    """Who is calling, as far as the handlers need to know. Holds no secret and no hash."""

    key_id: str
    scope: str
    name: str
    card_id: str | None = None
    peer_id: str | None = None
    cards_allowed: tuple[str, ...] | None = None
    tailnet_node: str | None = None
    tailnet_login: str | None = None

    @classmethod
    def from_record(cls, record: ApiKeyRecord) -> Principal:
        return cls(
            key_id=record.key_id,
            scope=record.scope,
            name=record.name,
            card_id=record.card_id,
            peer_id=record.peer_id,
            cards_allowed=record.cards_allowed,
            tailnet_node=record.tailnet_node,
            tailnet_login=record.tailnet_login,
        )

    @property
    def has_tailnet_binding(self) -> bool:
        return bool(self.tailnet_node or self.tailnet_login)
