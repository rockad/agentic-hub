"""Minimal database connection for S1-PG: prove at start-up that Postgres answers.

S1-STORE replaces the use of this module with its own engine. What stays is the rule it
enforces (spec 1.2, 1.5): `A2A_DB_URL` carries no password; the password is read from the file
`A2A_DB_PASSWORD_FILE` and handed to the driver as a connect argument. It is never put into a
URL string, a log line or an exception message.
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from coordination.config import Config

SCHEMES = ("postgresql+asyncpg", "postgresql")


class DbConfigError(ValueError):
    """The URL or the password file is unusable. The message never contains the password."""


@dataclass(frozen=True)
class ConnectParams:
    """Connection arguments for asyncpg. `password` is kept out of `repr`."""

    host: str
    port: int
    user: str
    database: str
    password: str = field(repr=False)

    def kwargs(self) -> dict[str, Any]:
        return {
            "host": self.host,
            "port": self.port,
            "user": self.user,
            "database": self.database,
            "password": self.password,
        }

    @property
    def target(self) -> str:
        """Where we connect, for messages: no password in it."""
        return f"{self.user}@{self.host}:{self.port}/{self.database}"


def read_password(path: str | Path) -> str:
    """Read the secret file. Trailing newlines are stripped, as the Postgres entrypoint does."""
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        raise DbConfigError(
            f"cannot read the database password file {path}: {exc.strerror or type(exc).__name__}"
        ) from None
    try:
        password = raw.decode("utf-8").rstrip("\n")
    except UnicodeDecodeError:
        raise DbConfigError(f"the database password file {path} is not UTF-8") from None
    if not password:
        raise DbConfigError(f"the database password file {path} is empty")
    return password


def params_from(db_url: str, password: str) -> ConnectParams:
    """Split `A2A_DB_URL` (no password in it) and add the password as a separate value."""
    try:
        parts = urlsplit(db_url)
        port = parts.port or 5432
    except ValueError:
        raise DbConfigError("A2A_DB_URL is not a valid URL") from None
    if parts.scheme not in SCHEMES:
        raise DbConfigError(f"A2A_DB_URL: expected a postgresql+asyncpg:// URL, got scheme {parts.scheme!r}")
    if parts.password is not None:
        # Do not echo the URL: it holds the very thing that must not be there.
        raise DbConfigError("A2A_DB_URL must not contain a password; use A2A_DB_PASSWORD_FILE")
    if not parts.hostname or not parts.username:
        raise DbConfigError("A2A_DB_URL: expected user and host, as in postgresql+asyncpg://user@host:5432/db")
    database = unquote(parts.path.lstrip("/"))
    if not database:
        raise DbConfigError("A2A_DB_URL: the database name is missing")
    return ConnectParams(
        host=parts.hostname,
        port=port,
        user=unquote(parts.username),
        database=database,
        password=password,
    )


def params_from_config(config: Config) -> ConnectParams:
    return params_from(config.db_url, read_password(config.db_password_file))


class DatabaseUnavailable(RuntimeError):
    """No connection after the bounded retries. The message never contains the password."""


async def _asyncpg_ping(params: ConnectParams) -> None:
    import asyncpg

    conn = await asyncpg.connect(**params.kwargs(), timeout=5)
    try:
        if await conn.fetchval("SELECT 1") != 1:
            raise RuntimeError("SELECT 1 did not return 1")
    finally:
        await conn.close()


async def wait_for_database(
    params: ConnectParams,
    *,
    attempts: int = 10,
    delay_s: float = 2.0,
    ping: Callable[[ConnectParams], Awaitable[None]] = _asyncpg_ping,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    log: Callable[[str], None] = lambda m: print(m, file=sys.stderr, flush=True),
) -> None:
    """Run `SELECT 1`, retrying up to `attempts` times, `delay_s` apart.

    Compose already holds the server back until Postgres is healthy; the retries cover the
    restart of the Postgres container while the server is up and a slow first start.
    """
    last = ""
    for attempt in range(1, attempts + 1):
        try:
            await ping(params)
            return
        except Exception as exc:  # noqa: BLE001 - any failure means "not reachable yet"
            last = _describe(exc, params.password)
            log(f"database {params.target}: attempt {attempt}/{attempts} failed: {last}")
        if attempt < attempts:
            await sleep(delay_s)
    raise DatabaseUnavailable(
        f"cannot connect to the database {params.target} after {attempts} attempts; last error: {last}"
    )


def _describe(exc: BaseException, password: str) -> str:
    text = f"{type(exc).__name__}: {exc}".strip()
    return text.replace(password, "***") if password else text


def check_database(config: Config, *, attempts: int = 10, delay_s: float = 2.0) -> None:
    """Start-up check. Exits non-zero with a clear message if the database cannot be reached."""
    try:
        params = params_from_config(config)
        asyncio.run(wait_for_database(params, attempts=attempts, delay_s=delay_s))
    except (DbConfigError, DatabaseUnavailable) as exc:
        raise SystemExit(f"coordination: {exc}") from None
