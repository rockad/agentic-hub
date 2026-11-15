"""The access-control middleware: the check order of spec 2.1 as one ASGI layer (S1-AUTH).

Order, for every request except `/healthz` (which is exempt) and the public root card (which
skips the key steps):

1. size limits: a body over `A2A_MAX_BODY_BYTES`, or headers over `MAX_HEADER_BYTES`, is `413`;
2. `Host` must be in `A2A_ALLOWED_HOSTS`, else `421`;
3. `Origin`, if present, must be in `A2A_ALLOWED_ORIGINS` (empty list: any `Origin` is refused),
   else `403`. CORS is off: no `Access-Control-*` header is ever sent. A path that is not one of
   our endpoints then gets `404` with no body (default deny, spec 2);
4. bearer: missing, malformed, unknown, revoked, expired or wrong-env keys are all one `401` with
   `WWW-Authenticate: Bearer` and the same body;
5. scope: a valid key of the wrong scope is `403` with no detail;
6. per-key rate limit (a `RateLimiter`; none is installed yet, S3-LIMITS owns the numbers):
   `429` with `Retry-After`;
7. tailnet identity, when `A2A_ENFORCE_TAILNET_IDENTITY=1`: `403`.

Every error is `application/problem+json` (RFC 9457) with `Cache-Control: no-store`. Every
response of a non-card path carries `Cache-Control: no-store`; Agent Card responses keep the
card handler's own header.

The middleware sits inside the S1-OBS `AuthorizationRedactionMiddleware` (app.py puts the
redaction first): the `Authorization` header it sees is already masked in `scope["headers"]`, and
the credential comes from `credential_from_scope`. After a successful check it adds a `Principal`
to the scope (`principal_from_scope`). A client cannot plant one: the scope key is overwritten.
"""

from __future__ import annotations

import ipaddress
import json
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from coordination.audit import AuditLog
from coordination.auth.keys import Verdict, parse_key, verify_key
from coordination.auth.records import LOCAL_HARNESS, Principal
from coordination.auth.scopes import Access, Rule, classify
from coordination.auth.store import ApiKeyStore
from coordination.clock import Clock
from coordination.config import Config
from coordination.logging import credential_from_scope

logger = logging.getLogger("coordination.auth")

PRINCIPAL_KEY = "coordination.principal"
#: Total request header size above which a request is refused with 413 [design]. It matches the
#: h11 default of uvicorn (16 KiB); the spec names "header size limits" without a number.
MAX_HEADER_BYTES = 16 * 1024


def principal_from_scope(scope: Scope) -> Principal | None:
    """The authenticated caller, or None on a path that needs no key."""
    value = scope.get(PRINCIPAL_KEY)
    return value if isinstance(value, Principal) else None


@dataclass(frozen=True)
class TailnetIdentity:
    """The Tailscale identity of a request: a node name, a user login, or both."""

    node: str | None = None
    login: str | None = None


#: Reads the Tailscale identity out of a request. The real source is S2-TS ([unverified] how the
#: identity reaches the server). The middleware calls it only for a peer in
#: `A2A_TRUSTED_PROXY_IPS`; a request from any other peer has no identity, whatever it sends.
IdentitySource = Callable[[Scope], TailnetIdentity | None]


@runtime_checkable
class RateLimiter(Protocol):
    async def retry_after(self, principal: Principal, scope: Scope) -> float | None:
        """None if the request may proceed, else the seconds the caller should wait."""
        ...


class _BodyTooLarge(Exception):
    pass


def is_trusted_peer(ip: str | None, trusted: Iterable[str]) -> bool:
    """True if `ip` is one of `trusted` (addresses or CIDR ranges). A bad entry never matches."""
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for entry in trusted:
        try:
            if addr in ipaddress.ip_network(entry, strict=False):
                return True
        except ValueError:
            continue
    return False


def _problem(status: int, title: str, detail: str, headers: dict[str, str] | None = None) -> tuple[int, list, bytes]:
    body = json.dumps({"type": "about:blank", "title": title, "status": status, "detail": detail}).encode()
    out = [
        (b"content-type", b"application/problem+json"),
        (b"content-length", str(len(body)).encode()),
        (b"cache-control", b"no-store"),
    ]
    for name, value in (headers or {}).items():
        out.append((name.lower().encode(), value.encode()))
    return status, out, body


_UNAUTHORIZED = _problem(401, "Unauthorized", "Authentication required.", {"WWW-Authenticate": "Bearer"})
_FORBIDDEN = _problem(403, "Forbidden", "Access denied.")
_ORIGIN = _problem(403, "Forbidden", "Origin not allowed.")
_MISDIRECTED = _problem(421, "Misdirected Request", "Host not allowed.")
_TOO_LARGE = _problem(413, "Content Too Large", "Request too large.")
_UNAVAILABLE = _problem(503, "Service Unavailable", "Temporarily unavailable.", {"Retry-After": "5"})
# Spec 2: anything else is `404` without a body.
_NOT_FOUND: tuple[int, list, bytes] = (404, [(b"cache-control", b"no-store"), (b"content-length", b"0")], b"")


async def _respond(send: Send, reply: tuple[int, list, bytes]) -> None:
    status, headers, body = reply
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


def _header_values(scope: Scope, name: bytes) -> list[str]:
    return [v.decode("latin-1") for k, v in scope.get("headers", []) if k.lower() == name]


class AccessControlMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        config: Config,
        keys: ApiKeyStore,
        clock: Clock,
        audit: AuditLog | None = None,
        rate_limiter: RateLimiter | None = None,
        identity_source: IdentitySource | None = None,
    ) -> None:
        self.app = app
        self._config = config
        self._keys = keys
        self._clock = clock
        self._audit = audit
        self._limiter = rate_limiter
        self._identity_source = identity_source
        self._hosts = frozenset(h.lower() for h in config.allowed_hosts)
        self._origins = frozenset(config.allowed_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] != "http":
            # No websocket endpoint exists. Refuse before any handler sees it.
            await send({"type": "websocket.close", "code": 1008})
            return

        rule = classify(scope["path"], status_enabled=self._config.status_enabled)
        if rule is not None and rule.access is Access.EXEMPT:
            await self.app(scope, receive, self._no_store(send))
            return

        request_scope = dict(scope)
        request_scope.pop(PRINCIPAL_KEY, None)  # a client cannot plant a principal

        refusal = self._pre_auth(request_scope)
        if refusal is None and rule is None:
            refusal = _NOT_FOUND
        if refusal is None:
            assert rule is not None
            refusal = await self._authenticate(request_scope, rule)
        if refusal is not None:
            await _respond(send, refusal)
            return
        assert rule is not None

        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await inner_send(message)

        inner_send = send if rule.card else self._no_store(send)
        try:
            await self.app(request_scope, self._limited(receive), tracking_send)
        except _BodyTooLarge:
            if started:
                raise
            await _respond(send, _TOO_LARGE)

    # steps -------------------------------------------------------------------------------

    def _pre_auth(self, scope: Scope):
        """Checks 1 to 3. Returns the refusal, or None to go on."""
        max_body = self._config.max_body_bytes
        lengths = _header_values(scope, b"content-length")
        for raw in lengths:
            if raw.isdigit() and int(raw) > max_body:
                return _TOO_LARGE
        header_bytes = sum(len(k) + len(v) + 4 for k, v in scope.get("headers", []))
        credential = credential_from_scope(scope)
        if credential is not None:
            header_bytes += len(credential.reveal())
        if header_bytes > MAX_HEADER_BYTES:
            return _TOO_LARGE
        hosts = _header_values(scope, b"host")
        if len(hosts) != 1 or hosts[0].lower() not in self._hosts:
            return _MISDIRECTED
        origins = _header_values(scope, b"origin")
        if origins and (len(origins) > 1 or origins[0] not in self._origins):
            return _ORIGIN
        return None

    async def _authenticate(self, scope: Scope, rule: Rule):
        """Checks 4 to 7. On success it puts the principal in `scope` and returns None."""
        if rule.access is Access.PUBLIC:
            return None

        credential = credential_from_scope(scope)
        token = credential.bearer() if credential is not None else None
        if token is None:
            await self._count_failure()
            return _UNAUTHORIZED
        env = self._config.env
        parsed = parse_key(token)
        record = None
        if parsed is not None and parsed.env == env:
            try:
                record = await self._keys.get(parsed.key_id)
            except Exception as exc:  # noqa: BLE001 - fail closed on any store error
                logger.error("api key lookup failed", extra={"fields": {"error": type(exc).__name__}})
                return _UNAVAILABLE
        now = self._clock.now()
        verdict = verify_key(token, record, env=env, pepper=self._config.key_pepper, now=now)
        if verdict is not Verdict.OK:
            fields: dict[str, object] = {"reason": verdict.value}
            if record is not None:
                fields["key_id"] = record.key_id
            logger.info("api key refused", extra={"fields": fields})
            await self._count_failure()
            return _UNAUTHORIZED
        assert record is not None
        principal = Principal.from_record(record)

        if rule.access is Access.SCOPED and principal.scope not in rule.scopes:
            return _FORBIDDEN

        if self._limiter is not None:
            wait = await self._limiter.retry_after(principal, scope)
            if wait is not None:
                seconds = max(1, int(wait + 0.999))
                return _problem(429, "Too Many Requests", "Rate limit exceeded.", {"Retry-After": str(seconds)})

        if self._config.enforce_tailnet_identity and principal.scope == LOCAL_HARNESS:
            if not self._tailnet_identity_matches(scope, principal):
                return _FORBIDDEN

        try:
            await self._keys.touch(principal.key_id, now)
        except Exception as exc:  # noqa: BLE001 - bookkeeping only, never a reason to refuse
            logger.warning("api key last_used update failed", extra={"fields": {"error": type(exc).__name__}})
        scope[PRINCIPAL_KEY] = principal
        return None

    def _tailnet_identity_matches(self, scope: Scope, principal: Principal) -> bool:
        """Spec 2.1 step 7. [design] Fails closed: a `local-harness` key with no tailnet binding
        is refused while enforcement is on, because spec 1.5 refuses a harness request without a
        verifiable identity and 8.3 requires a binding on every harness key at S2 and S3."""
        if not principal.has_tailnet_binding:
            return False
        client = scope.get("client")
        peer = client[0] if client else None
        if self._identity_source is None or not is_trusted_peer(peer, self._config.trusted_proxy_ips):
            return False  # identity is believed only from a trusted proxy peer
        identity = self._identity_source(scope)
        if identity is None:
            return False
        if principal.tailnet_node and identity.node != principal.tailnet_node:
            return False
        if principal.tailnet_login and identity.login != principal.tailnet_login:
            return False
        return True

    async def _count_failure(self) -> None:
        if self._audit is None:
            return
        try:
            await self._audit.auth_failure()
        except Exception as exc:  # noqa: BLE001 - the audit sink must not decide who gets in
            logger.warning("audit write failed", extra={"fields": {"error": type(exc).__name__}})

    # plumbing ----------------------------------------------------------------------------

    @staticmethod
    def _no_store(send: Send) -> Send:
        async def wrapped(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"]
                headers.append((b"cache-control", b"no-store"))
                message = {**message, "headers": headers}
            await send(message)

        return wrapped

    def _limited(self, receive: Receive) -> Receive:
        limit = self._config.max_body_bytes
        seen = 0

        async def wrapped() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    raise _BodyTooLarge
            return message

        return wrapped
