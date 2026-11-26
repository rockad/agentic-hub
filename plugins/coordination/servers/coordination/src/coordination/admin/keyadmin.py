"""`a2a-coord key create|list|rotate|revoke`, server side (S1-ADMIN; spec 8.2, 8.3, decisions D17,
D18, D24, Z14).

Key generation, hashing and the key record are S1-AUTH's (`coordination.auth`); this module only
decides what may be issued and writes the audit row. The secret exists in this process only inside
the reply of `create` and `rotate`: it is never stored (only its hash), never logged, never in an
audit row, and `list` has no field that could hold one.

Rules, all from the spec unless marked [design]:

- `--scope` is one of the three scopes of spec 8.1. There is no admin scope (D15).
- `--expires` is required, in whole days or hours (`90d`, `36h`). The ceiling is 365 days at stage
  `s1` and 90 days at `s2` and `s3`; a larger value is refused, not clamped (Z14).
- `local-harness`: `--agent` is the owner card and must exist (the cards file, loaded at start).
  `--tailnet-node` is required at `s2` and `s3` (D17, D23) and optional at `s1`. `--tailnet-login`
  does not exist: it waits for the real identity source (S2-TS, Z14).
- `remote-peer`: `--agent` is the peer label [design: `^[a-z0-9][a-z0-9._-]{0,63}$`], `--cards` is
  the allowlist (D18) and needs at least one existing card [design]. No tailnet node.
- `status-client`: `--agent` is a label (for example `cognitive-engine`); nothing else.
- `rotate` (D24): the replacement copies the old key's scope, owner and bindings; the old key keeps
  working until `--grace` (default 24 hours) has passed or its own expiry, whichever is sooner. The
  replacement lives as long as the old key was issued for, never past the stage ceiling, unless
  `--expires` says otherwise [design]. A revoked or expired key cannot be rotated.
- `revoke`: the key is refused at once by the access-control middleware (it reads the database on
  every request); the hooks then close its live connections (`hooks`).
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timedelta
from typing import Any

from coordination.admin.hooks import RevokeHooks
from coordination.admin.keystore import KeyAdminStore
from coordination.admin.protocol import AdminError
from coordination.audit import AuditLog
from coordination.auth import SCOPES, ApiKeyRecord, generate_key
from coordination.auth.records import LOCAL_HARNESS, REMOTE_PEER
from coordination.clock import Clock
from coordination.config import Config
from coordination.service.types import CARD_RE
from coordination.text_sanitize import sanitize_preview

DEFAULT_GRACE = timedelta(hours=24)
MIN_EXPIRES = timedelta(hours=1)
#: `--expires` ceilings in days by exposure stage (decision Z14).
CEILING_DAYS = {"s1": 365, "s2": 90, "s3": 90}

_DURATION = re.compile(r"^(\d{1,4})([dh])$")
_PEER_LABEL = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_LABEL = re.compile(r"^[a-z0-9][a-z0-9._@-]{0,63}$")
_NODE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$")
_KEY_ID = re.compile(r"^[0-9a-f]{8}$")

CardExists = Callable[[str], Awaitable[bool]]


def parse_duration(value: object, *, what: str, allow_zero: bool = False) -> timedelta:
    """`90d` or `36h`. Anything else is refused, with the option's name in the message."""
    match = _DURATION.match(value) if isinstance(value, str) else None
    if match is None:
        raise AdminError("invalid_args", f"{what} must be whole days or hours, for example 90d or 36h")
    amount, unit = int(match[1]), match[2]
    delta = timedelta(days=amount) if unit == "d" else timedelta(hours=amount)
    if not allow_zero and delta <= timedelta(0):
        raise AdminError("invalid_args", f"{what} must be more than zero")
    return delta


def _text(args: Mapping[str, Any], name: str, *, required: bool = True) -> str | None:
    value = args.get(name)
    if value is None or value == "":
        if required:
            raise AdminError("invalid_args", f"{name} is required")
        return None
    if not isinstance(value, str):
        raise AdminError("invalid_args", f"{name} must be a string")
    return value


def key_row(record: ApiKeyRecord, now: datetime) -> dict[str, Any]:
    """One `key list` row. Built field by field: the record's hash cannot get in by accident."""
    if record.revoked_at is not None:
        status = "revoked"
    elif record.expires_at <= now:
        status = "expired"
    else:
        status = "active"
    owner = record.card_id or record.peer_id or record.name
    return {
        "key_id": record.key_id,
        "status": status,
        "scope": record.scope,
        "env": record.env,
        "owner": sanitize_preview(owner) if owner is not None else None,
        "cards_allowed": [sanitize_preview(c) for c in record.cards_allowed] if record.cards_allowed is not None else None,
        "tailnet_node": sanitize_preview(record.tailnet_node) if record.tailnet_node is not None else None,
        "created_at": record.created_at.isoformat(),
        "expires_at": record.expires_at.isoformat(),
        "last_used_at": record.last_used_at.isoformat() if record.last_used_at else None,
        "revoked_at": record.revoked_at.isoformat() if record.revoked_at else None,
    }


class KeyAdmin:
    def __init__(
        self,
        config: Config,
        clock: Clock,
        keys: KeyAdminStore,
        audit: AuditLog,
        hooks: RevokeHooks,
        card_exists: CardExists,
    ) -> None:
        self._config = config
        self._clock = clock
        self._keys = keys
        self._audit = audit
        self._hooks = hooks
        self._card_exists = card_exists

    @property
    def ceiling(self) -> timedelta:
        return timedelta(days=CEILING_DAYS[self._config.exposure_stage])

    def _lifetime(self, value: object, *, what: str = "--expires") -> timedelta:
        delta = parse_duration(value, what=what)
        if delta < MIN_EXPIRES:
            raise AdminError("invalid_args", f"{what} must be at least 1h")
        if delta > self.ceiling:
            raise AdminError(
                "invalid_args",
                f"{what} is over the {self.ceiling.days} day ceiling at stage {self._config.exposure_stage}",
            )
        return delta

    async def _require_card(self, card_id: str, what: str) -> None:
        if not CARD_RE.match(card_id):
            raise AdminError("invalid_args", f"{what}: {card_id!r} is not a card id (<harness>@<machine>)")
        if not await self._card_exists(card_id):
            raise AdminError("invalid_args", f"{what}: no card {card_id} is defined (cards file, loaded at start)")

    # -- create -----------------------------------------------------------------------------

    async def create(self, args: Mapping[str, Any], actor: str) -> dict[str, Any]:
        scope = _text(args, "scope")
        agent = _text(args, "agent")
        node = _text(args, "tailnet_node", required=False)
        if "tailnet_login" in args:
            raise AdminError("invalid_args", "--tailnet-login is not available; use --tailnet-node")
        cards_raw = args.get("cards")
        expires = self._lifetime(args.get("expires"))
        if scope not in SCOPES:
            raise AdminError("invalid_args", f"--scope must be one of {', '.join(SCOPES)}")
        assert scope is not None and agent is not None

        card_id = peer_id = None
        cards_allowed: tuple[str, ...] | None = None
        if scope == LOCAL_HARNESS:
            if cards_raw:
                raise AdminError("invalid_args", "--cards is for remote-peer keys only")
            await self._require_card(agent, "--agent")
            card_id = agent
            if node is None and self._config.exposure_stage != "s1":
                raise AdminError("invalid_args", "--tailnet-node is required at stage s2 and s3")
            if node is not None and not _NODE.match(node):
                raise AdminError("invalid_args", "--tailnet-node is not a node name")
        else:
            if node is not None:
                raise AdminError("invalid_args", "--tailnet-node is for local-harness keys only")
            if scope == REMOTE_PEER:
                if not _PEER_LABEL.match(agent):
                    raise AdminError("invalid_args", "--agent must be a peer label: lower-case letters, digits, . _ -")
                if not isinstance(cards_raw, list) or not cards_raw or not all(isinstance(c, str) for c in cards_raw):
                    raise AdminError("invalid_args", "--cards is required for a remote-peer key (at least one card)")
                for card in cards_raw:
                    await self._require_card(card, "--cards")
                cards_allowed = tuple(dict.fromkeys(cards_raw))
                peer_id = agent
            else:  # STATUS_CLIENT
                if cards_raw:
                    raise AdminError("invalid_args", "--cards is for remote-peer keys only")
                if not _LABEL.match(agent):
                    raise AdminError("invalid_args", "--agent must be a label: lower-case letters, digits, . _ - @")

        now = self._clock.now()
        generated = generate_key(self._config.env, self._config.key_pepper)
        record = ApiKeyRecord(
            key_id=generated.key_id,
            env=self._config.env,
            name=agent,
            scope=scope,
            secret_hash=generated.secret_hash,
            created_at=now,
            expires_at=now + expires,
            card_id=card_id,
            peer_id=peer_id,
            cards_allowed=cards_allowed,
            tailnet_node=node,
        )
        await self._keys.insert(record)
        try:
            await self._audit.key_created(actor=actor, key_id=record.key_id, scope=scope)
        except Exception:
            # No audit row, no key: the secret was never shown, so withdrawing the record loses nothing.
            await self._keys.revoke(record.key_id, now)
            raise AdminError("audit_failed", "the audit row could not be written; no key was issued") from None
        return {**key_row(record, now), "token": generated.token}

    # -- list -------------------------------------------------------------------------------

    async def list_keys(self) -> dict[str, Any]:
        now = self._clock.now()
        return {"keys": [key_row(r, now) for r in await self._keys.list_all()]}

    # -- rotate -----------------------------------------------------------------------------

    async def rotate(self, args: Mapping[str, Any], actor: str) -> dict[str, Any]:
        key_id = self._key_id(args)
        grace = DEFAULT_GRACE if args.get("grace") in (None, "") else parse_duration(args["grace"], what="--grace", allow_zero=True)
        old = await self._keys.get(key_id)
        now = self._clock.now()
        if old is None:
            raise AdminError("not_found", f"no key {key_id}")
        if old.revoked_at is not None or old.expires_at <= now:
            raise AdminError("refused", f"key {key_id} is {'revoked' if old.revoked_at else 'expired'} and cannot be rotated")
        if args.get("expires") in (None, ""):
            lifetime = min(old.expires_at - old.created_at, self.ceiling)
            lifetime = max(lifetime, MIN_EXPIRES)
        else:
            lifetime = self._lifetime(args["expires"])
        generated = generate_key(self._config.env, self._config.key_pepper)
        new = ApiKeyRecord(
            key_id=generated.key_id,
            env=self._config.env,
            name=old.name,
            scope=old.scope,
            secret_hash=generated.secret_hash,
            created_at=now,
            expires_at=now + lifetime,
            card_id=old.card_id,
            peer_id=old.peer_id,
            cards_allowed=old.cards_allowed,
            tailnet_node=old.tailnet_node,
            tailnet_login=old.tailnet_login,
        )
        old_expires = min(old.expires_at, now + grace)
        if not await self._keys.rotate(key_id, old_expires, new, now):
            raise AdminError("refused", f"key {key_id} is no longer live and cannot be rotated")
        try:
            await self._audit.key_rotated(actor=actor, key_id=key_id, new_key_id=new.key_id)
        except Exception:
            # Keep the guarantee of `create`: no audit row, no new key. The old key's shortened expiry stays;
            # that fails closed, and the admin can run the command again.
            await self._keys.revoke(new.key_id, now)
            raise AdminError("audit_failed", "the audit row could not be written; no key was issued") from None
        return {
            **key_row(new, now),
            "token": generated.token,
            "replaces": key_id,
            "old_expires_at": old_expires.isoformat(),
        }

    # -- revoke -----------------------------------------------------------------------------

    async def revoke(self, args: Mapping[str, Any], actor: str) -> dict[str, Any]:
        key_id = self._key_id(args)
        if not await self._keys.revoke(key_id, self._clock.now()):
            if await self._keys.get(key_id) is None:
                raise AdminError("not_found", f"no key {key_id}")
            raise AdminError("refused", f"key {key_id} is already revoked")
        # The revocation has happened. Close the live connections first, then write the audit row; a
        # failure of either is reported, never turned into "the key is still valid".
        report = await self._hooks.fire(key_id)
        audited = True
        try:
            await self._audit.key_revoked(actor=actor, key_id=key_id)
        except Exception:  # noqa: BLE001
            audited = False
        return {
            "key_id": key_id,
            "revoked": True,
            "closed": report.closed,
            "hook_failures": report.failed,
            "audited": audited,
        }

    @staticmethod
    def _key_id(args: Mapping[str, Any]) -> str:
        key_id = _text(args, "key_id")
        if not isinstance(key_id, str) or not _KEY_ID.match(key_id):
            raise AdminError("invalid_args", "key_id is 8 lower-case hex characters")
        return key_id
