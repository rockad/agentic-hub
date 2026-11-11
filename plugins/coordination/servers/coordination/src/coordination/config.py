"""The one configuration module.

Reads exactly the variables listed in docs/specs/server-api.md section 1.5, from
the environment and nowhere else (no file, no `.env`). Nothing else in the
server reads `os.environ`. Defaults are the ones the spec states.

Two rows of that table are not read here because they are not server variables:
`COMPOSE_PROFILES` belongs to Docker Compose. `A2A_PORT` and `A2A_PUBLIC_PORT`
are read only so the table stays complete; they are the host side of the compose
port mapping and the server does not listen on them.

Start-up checks (spec 1.6) are not part of this module. It only parses and types.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, fields
from typing import Any

ENVS = ("dev", "live")
STAGES = ("s1", "s2", "s3")


class ConfigError(ValueError):
    """A variable is present but cannot be parsed. The message names the variable."""


def _str(name: str, raw: str) -> str:
    return raw


def _int(name: str, raw: str) -> int:
    try:
        return int(raw)
    except ValueError:
        raise ConfigError(f"{name}: expected an integer, got {raw!r}") from None


def _flag(name: str, raw: str) -> bool:
    if raw in ("0", "1"):
        return raw == "1"
    raise ConfigError(f"{name}: expected 0 or 1, got {raw!r}")


def _csv(name: str, raw: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _choice(options: tuple[str, ...]) -> Callable[[str, str], str]:
    def parse(name: str, raw: str) -> str:
        if raw in options:
            return raw
        raise ConfigError(f"{name}: expected one of {', '.join(options)}, got {raw!r}")

    return parse


@dataclass(frozen=True)
class Config:
    """Typed server configuration. Build it with `Config.from_env`."""

    port: int = 8120  # A2A_PORT, compose host port
    public_port: int = 8121  # A2A_PUBLIC_PORT, compose host port
    listen: str = "0.0.0.0:8120"  # A2A_LISTEN
    public_listen: str = "0.0.0.0:8121"  # A2A_PUBLIC_LISTEN
    db_url: str = "postgresql+asyncpg://coordination@postgres:5432/coordination"
    db_password_file: str = "/run/secrets/a2a_db_password"
    dump_last_ok_file: str = "/dumps/last_ok"
    public_url: str = "http://127.0.0.1:8120"
    deploy_host: str = "local"  # a label, never a trust input (D23)
    env: str = "dev"
    exposure_stage: str = "s1"
    allow_writes: bool = False
    allowed_hosts: tuple[str, ...] = ("127.0.0.1:8120", "localhost:8120")
    allowed_origins: tuple[str, ...] = ()
    trusted_proxy_ips: tuple[str, ...] = ()
    cards_file: str = "/config/cards.yaml"
    key_pepper: str | None = field(default=None, repr=False)  # secret
    wake_round_s: int = 900
    wake_budget_per_h: int = 20
    reoffer_after_s: int = 600
    reoffer_max: int = 5
    submitted_ttl_h: int = 168
    quarantine_ttl_h: int = 72
    working_ttl_h: int = 24
    session_idle_ttl_h: int = 12
    max_body_bytes: int = 65536
    max_wait_s: int = 50
    send_block_max_s: int = 60
    push_enabled: bool = False
    push_allow_hosts: tuple[str, ...] = ()
    push_enc_key: str | None = field(default=None, repr=False)  # secret
    status_enabled: bool = False
    enforce_tailnet_identity: bool = False  # default is stage-dependent, see from_env
    admin_socket: str = "/run/a2a/admin.sock"
    log_level: str = "info"

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> Config:
        """Parse `environ`. Only the variables in `ENV_VARS` are looked at."""
        values: dict[str, Any] = {}
        for attr, (name, parse) in _SPEC.items():
            raw = environ.get(name)
            if raw is not None:
                values[attr] = parse(name, raw)
        if "enforce_tailnet_identity" not in values:
            # Spec 1.5: "0 at s1, 1 at s2 and s3".
            stage = values.get("exposure_stage", cls.exposure_stage)
            values["enforce_tailnet_identity"] = stage != "s1"
        return cls(**values)

    @property
    def listen_host_port(self) -> tuple[str, int]:
        """`A2A_LISTEN` split into (host, port)."""
        host, sep, port = self.listen.rpartition(":")
        if not sep or not host:
            raise ConfigError(f"A2A_LISTEN: expected host:port, got {self.listen!r}")
        return host, _int("A2A_LISTEN", port)


# attribute -> (environment variable, parser). Secrets (key_pepper, push_enc_key)
# stay plain strings here and are marked repr=False on the dataclass.
_SPEC: dict[str, tuple[str, Callable[[str, str], Any]]] = {
    "port": ("A2A_PORT", _int),
    "public_port": ("A2A_PUBLIC_PORT", _int),
    "listen": ("A2A_LISTEN", _str),
    "public_listen": ("A2A_PUBLIC_LISTEN", _str),
    "db_url": ("A2A_DB_URL", _str),
    "db_password_file": ("A2A_DB_PASSWORD_FILE", _str),
    "dump_last_ok_file": ("A2A_DUMP_LAST_OK_FILE", _str),
    "public_url": ("A2A_PUBLIC_URL", _str),
    "deploy_host": ("A2A_DEPLOY_HOST", _str),
    "env": ("A2A_ENV", _choice(ENVS)),
    "exposure_stage": ("A2A_EXPOSURE_STAGE", _choice(STAGES)),
    "allow_writes": ("A2A_ALLOW_WRITES", _flag),
    "allowed_hosts": ("A2A_ALLOWED_HOSTS", _csv),
    "allowed_origins": ("A2A_ALLOWED_ORIGINS", _csv),
    "trusted_proxy_ips": ("A2A_TRUSTED_PROXY_IPS", _csv),
    "cards_file": ("A2A_CARDS_FILE", _str),
    "key_pepper": ("A2A_KEY_PEPPER", _str),
    "wake_round_s": ("A2A_WAKE_ROUND_S", _int),
    "wake_budget_per_h": ("A2A_WAKE_BUDGET_PER_H", _int),
    "reoffer_after_s": ("A2A_REOFFER_AFTER_S", _int),
    "reoffer_max": ("A2A_REOFFER_MAX", _int),
    "submitted_ttl_h": ("A2A_SUBMITTED_TTL_H", _int),
    "quarantine_ttl_h": ("A2A_QUARANTINE_TTL_H", _int),
    "working_ttl_h": ("A2A_WORKING_TTL_H", _int),
    "session_idle_ttl_h": ("A2A_SESSION_IDLE_TTL_H", _int),
    "max_body_bytes": ("A2A_MAX_BODY_BYTES", _int),
    "max_wait_s": ("A2A_MAX_WAIT_S", _int),
    "send_block_max_s": ("A2A_SEND_BLOCK_MAX_S", _int),
    "push_enabled": ("A2A_PUSH_ENABLED", _flag),
    "push_allow_hosts": ("A2A_PUSH_ALLOW_HOSTS", _csv),
    "push_enc_key": ("A2A_PUSH_ENC_KEY", _str),
    "status_enabled": ("A2A_STATUS_ENABLED", _flag),
    "enforce_tailnet_identity": ("A2A_ENFORCE_TAILNET_IDENTITY", _flag),
    "admin_socket": ("A2A_ADMIN_SOCKET", _str),
    "log_level": ("A2A_LOG_LEVEL", _str),
}

#: Every environment variable this module reads, in table order.
ENV_VARS: tuple[str, ...] = tuple(name for name, _ in _SPEC.values())

assert set(_SPEC) == {f.name for f in fields(Config)}, "Config fields and _SPEC differ"


def load() -> Config:
    """Read the process environment."""
    return Config.from_env(os.environ)
