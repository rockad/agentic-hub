"""Push notification configuration and delivery: code present, off at S1 (spec 3.3.4, 10).

Nothing here is reachable while `A2A_PUSH_ENABLED=0`: the four push operations answer -32003 before
they look at anything (`operations.py`), and no sender is built. With the flag on:

- Store: the SDK's `DatabasePushNotificationConfigStore` over the `push_notification_configs` table
  (migration stream of the SDK, S1-STORE), with the Fernet `encryption_key` (`A2A_PUSH_ENC_KEY`):
  the whole config, token and credentials included, is encrypted at rest.
- Screen: `screen_push_url`, run at config time and again at send time. The SDK's
  `validate_push_notification_url` is always passed, with one documented exception [design]: a
  hostname in `A2A_PUSH_ALLOW_HOSTS` is the one way to permit a private or tailnet target, and the
  SDK's validator would refuse exactly those, so an allow-listed name skips it (and only it).
  The rules of spec 3.3.4: `https` only, no userinfo, every resolved address public (not loopback,
  link-local, private, unique-local, multicast, reserved, the metadata address or `100.64.0.0/10`),
  port 443 unless an allow-list entry names another.
- Pin: the sender connects to the address the screen approved, not to a second resolution of the
  name (the URL carries the address, `Host` and the TLS server name carry the hostname), does not
  follow redirects, reads no proxy settings from the environment, has 5 s connect and read
  timeouts and ignores the response body beyond a small cap. A name that was public at config time
  and private at send time is refused at send time because the screen runs again.
- Originator only, at most 3 configs per task (`PushConfigs`; the originator check itself is in
  `operations.py`, which has the task index).
- The pushed payload is the Task with the internal `coord.*` metadata removed. A push failure
  never changes task state and never raises.

NOT built: the trigger. The service layer has no event hook other than the wake `Notifier`, so
nothing calls `PushSender.send` when a task changes state. S1-STATE would have to publish one, or
S2-STREAM (optional, unscheduled) build the event fan-out. See docs/specs/a2a.md.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import urllib.parse
import uuid
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass

import httpx
from a2a.auth.user import User
from a2a.server.context import ServerCallContext
from a2a.server.tasks.database_push_notification_config_store import DatabasePushNotificationConfigStore
from a2a.types import a2a_pb2 as pb
from a2a.utils.push_url_validator import validate_push_notification_url
from google.protobuf import json_format
from sqlalchemy.ext.asyncio import AsyncEngine

from coordination.a2a import errors as E

log = logging.getLogger("coordination.a2a.push")

MAX_CONFIGS_PER_TASK = 3  # spec 3.3.4
MAX_URL_BYTES = 2048
MAX_TOKEN_BYTES = 256
MAX_CREDENTIALS_BYTES = 1024
TIMEOUT_S = 5.0  # connect and read (spec 3.3.4)
MAX_RESPONSE_BYTES = 4096  # the response body is ignored beyond this

Resolver = Callable[[str, int], Awaitable[list[str]]]
UrlValidator = Callable[[str], Awaitable[bool]]


class PushUrlRefused(ValueError):
    """The URL failed the screen. The reason is a short constant; the URL is never in it."""


async def system_resolver(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        return []
    seen: dict[str, None] = {}
    for info in infos:
        seen.setdefault(str(info[4][0]), None)
    return list(seen)


def address_is_blocked(value: str) -> bool:
    """True unless `value` is a public unicast address. 100.64.0.0/10 (carrier-grade NAT, which
    covers tailnet addresses) is not global, so `is_global` already refuses it; the explicit tests
    are there so the rule reads as the spec's list. An IPv4-mapped IPv6 address is judged as the
    IPv4 address inside it."""
    try:
        addr = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return True
    mapped = getattr(addr, "ipv4_mapped", None)
    if mapped is not None:
        addr = mapped
    return (
        not addr.is_global
        or addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
        or (addr.version == 4 and addr in _CGNAT)
    )


_CGNAT = ipaddress.ip_network("100.64.0.0/10")


@dataclass(frozen=True)
class PinnedTarget:
    """A URL that passed the screen, and the one address the sender may connect to."""

    host: str
    port: int
    address: str
    path: str  # path and query, as given
    allowlisted: bool

    @property
    def connect_url(self) -> str:
        literal = f"[{self.address}]" if ":" in self.address else self.address
        return f"https://{literal}:{self.port}{self.path}"

    @property
    def host_header(self) -> str:
        return self.host if self.port == 443 else f"{self.host}:{self.port}"


def _allowed(host: str, port: int, allow_hosts: Collection[str]) -> bool:
    entries = {e.strip().lower().rstrip(".") for e in allow_hosts if e.strip()}
    return f"{host}:{port}" in entries or (port == 443 and host in entries)


async def screen_push_url(
    url: str,
    allow_hosts: Collection[str] = (),
    *,
    resolve: Resolver = system_resolver,
    validator: UrlValidator = validate_push_notification_url,
) -> PinnedTarget:
    """The screen of spec 3.3.4. Returns the target to connect to, or raises `PushUrlRefused`."""
    if not isinstance(url, str) or not url or len(url.encode()) > MAX_URL_BYTES:
        raise PushUrlRefused("url_invalid")
    try:
        parts = urllib.parse.urlsplit(url)
        explicit_port = parts.port
    except ValueError:
        raise PushUrlRefused("url_invalid") from None
    if parts.scheme != "https":
        raise PushUrlRefused("scheme_not_https")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise PushUrlRefused("userinfo_not_allowed")
    host = (parts.hostname or "").lower().rstrip(".")
    if not host:
        raise PushUrlRefused("host_missing")
    port = explicit_port or 443
    allowlisted = _allowed(host, port, allow_hosts)
    if port != 443 and not allowlisted:
        raise PushUrlRefused("port_not_allowed")
    try:
        addresses = [str(ipaddress.ip_address(host))]  # an address literal is its own resolution
    except ValueError:
        addresses = await resolve(host, port)
    if not addresses:
        raise PushUrlRefused("host_unresolvable")
    if not allowlisted:
        if any(address_is_blocked(a) for a in addresses):
            raise PushUrlRefused("address_not_public")
        if not await validator(url):  # the SDK's screen, always passed
            raise PushUrlRefused("address_not_public")
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return PinnedTarget(host=host, port=port, address=addresses[0], path=path, allowlisted=allowlisted)


# -- config store ---------------------------------------------------------------------------


class PrincipalUser(User):
    """The SDK's `User`, carrying the caller's principal string: the store's `owner`."""

    def __init__(self, principal: str) -> None:
        self._principal = principal

    @property
    def is_authenticated(self) -> bool:
        return True

    @property
    def user_name(self) -> str:
        return self._principal


def _context(principal: str) -> ServerCallContext:
    return ServerCallContext(user=PrincipalUser(principal))


class PushConfigs:
    """The four push operations over the SDK's encrypted store. The caller has already been
    checked as the task's originator; this class owns the screen and the per-task cap."""

    def __init__(
        self,
        engine: AsyncEngine,
        encryption_key: str,
        allow_hosts: Collection[str] = (),
        *,
        resolve: Resolver = system_resolver,
        validator: UrlValidator = validate_push_notification_url,
        max_per_task: int = MAX_CONFIGS_PER_TASK,
    ) -> None:
        if not encryption_key:
            raise ValueError("push configs are stored encrypted: A2A_PUSH_ENC_KEY is required")
        # `create_table=False`: the table belongs to the SDK migration stream (S1-STORE).
        self.store = DatabasePushNotificationConfigStore(engine, create_table=False, encryption_key=encryption_key)
        self._allow = tuple(allow_hosts)
        self._resolve = resolve
        self._validator = validator
        self._max = max_per_task

    async def create(self, principal: str, task_id: str, config: pb.TaskPushNotificationConfig) -> pb.TaskPushNotificationConfig:
        if not config.url:
            raise E.invalid_params("a push configuration needs a url")
        if len(config.token.encode()) > MAX_TOKEN_BYTES:
            raise E.invalid_params(f"token is at most {MAX_TOKEN_BYTES} bytes")
        if len(config.authentication.credentials.encode()) > MAX_CREDENTIALS_BYTES:
            raise E.invalid_params(f"credentials are at most {MAX_CREDENTIALS_BYTES} bytes")
        try:
            await screen_push_url(config.url, self._allow, resolve=self._resolve, validator=self._validator)
        except PushUrlRefused as exc:
            raise E.invalid_params(f"push url refused: {exc}", data={"reason": str(exc)}) from None
        ctx = _context(principal)
        existing = await self.store.get_info(task_id, ctx)
        ids = {c.id for c in existing}
        wanted = pb.TaskPushNotificationConfig()
        wanted.CopyFrom(config)
        wanted.task_id = task_id
        wanted.tenant = ""
        if not wanted.id:
            wanted.id = str(uuid.uuid4())
        if wanted.id not in ids and len(existing) >= self._max:
            raise E.invalid_params(f"a task has at most {self._max} push configurations")
        saved = await self.store.set_info(task_id, wanted, ctx)
        return saved if saved is not None else wanted

    async def get(self, principal: str, task_id: str, config_id: str) -> pb.TaskPushNotificationConfig:
        for config in await self.store.get_info(task_id, _context(principal)):
            if config.id == (config_id or task_id):
                return config
        raise E.task_not_found("Push notification config not found")

    async def list(self, principal: str, task_id: str) -> list[pb.TaskPushNotificationConfig]:
        return list(await self.store.get_info(task_id, _context(principal)))

    async def delete(self, principal: str, task_id: str, config_id: str) -> None:
        await self.store.delete_info(task_id, _context(principal), config_id or None)


# -- delivery -------------------------------------------------------------------------------


@dataclass(frozen=True)
class Delivery:
    config_id: str
    ok: bool
    reason: str  # a short constant: "delivered", "http_<status>", "redirect_not_followed", a screen reason, "error"
    status: int | None = None


def pushed_task(task: pb.Task) -> pb.Task:
    """The Task as pushed: a copy without the server's internal `coord.*` metadata."""
    out = pb.Task()
    out.CopyFrom(task)
    if "coord" in out.metadata.fields:
        del out.metadata.fields["coord"]
    return out


class PushSender:
    """Delivers a task to every config registered for it. Best effort: nothing here raises, and a
    failure never changes task state."""

    def __init__(
        self,
        store: DatabasePushNotificationConfigStore,
        allow_hosts: Collection[str] = (),
        *,
        resolve: Resolver = system_resolver,
        validator: UrlValidator = validate_push_notification_url,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_s: float = TIMEOUT_S,
    ) -> None:
        self._store = store
        self._allow = tuple(allow_hosts)
        self._resolve = resolve
        self._validator = validator
        self._transport = transport
        self._timeout = timeout_s

    async def send(self, task: pb.Task) -> list[Delivery]:
        try:
            configs = await self._store.get_info_for_dispatch(task.id)
        except Exception as exc:  # noqa: BLE001 - never raises
            log.warning("push: reading configs failed (%s)", type(exc).__name__)
            return []
        body = json_format.MessageToJson(pb.StreamResponse(task=pushed_task(task))).encode()
        return [await self._deliver(config, body) for config in configs]

    async def _deliver(self, config: pb.TaskPushNotificationConfig, body: bytes) -> Delivery:
        try:
            # The screen runs again: a name that was public at config time may be private now.
            target = await screen_push_url(config.url, self._allow, resolve=self._resolve, validator=self._validator)
        except PushUrlRefused as exc:
            log.warning("push: refused at send time (%s)", exc)
            return Delivery(config.id, False, str(exc))
        headers = {"Host": target.host_header, "Content-Type": "application/json"}
        if config.token:
            headers["X-A2A-Notification-Token"] = config.token
        if config.authentication.scheme and config.authentication.credentials:
            headers["Authorization"] = f"{config.authentication.scheme} {config.authentication.credentials}"
        timeout = httpx.Timeout(self._timeout, connect=self._timeout)
        try:
            # trust_env=False: no HTTP(S)_PROXY from the environment, which would defeat the pin.
            async with httpx.AsyncClient(
                transport=self._transport, timeout=timeout, follow_redirects=False, trust_env=False
            ) as client:
                async with client.stream(
                    "POST",
                    target.connect_url,
                    content=body,
                    headers=headers,
                    extensions={"sni_hostname": target.host},
                ) as response:
                    read = 0
                    async for chunk in response.aiter_bytes():
                        read += len(chunk)
                        if read > MAX_RESPONSE_BYTES:
                            break
                    status = response.status_code
        except Exception as exc:  # noqa: BLE001 - never raises, never logs the URL
            log.warning("push: delivery failed (%s)", type(exc).__name__)
            return Delivery(config.id, False, "error")
        if 300 <= status < 400:
            return Delivery(config.id, False, "redirect_not_followed", status)
        if 200 <= status < 300:
            return Delivery(config.id, True, "delivered", status)
        return Delivery(config.id, False, f"http_{status}", status)
