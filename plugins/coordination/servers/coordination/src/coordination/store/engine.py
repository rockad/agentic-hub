"""The async Postgres engine (spec 1.2, D4, D37).

`A2A_DB_URL` carries no password. The password comes from the mode-0600 file named by
`A2A_DB_PASSWORD_FILE` and reaches asyncpg as a connect argument, so it is never in a URL, a
repr, a log line or an exception message. No `BEGIN IMMEDIATE`, no single-connection write
engine and no PRAGMA setup: those were the SQLite design and D4 retired them.

Pool settings are [design]. SP5b ran SQLAlchemy's defaults (pool of 5 with an overflow of 10; its
scratch driver passes pool arguments only for SQLite URLs), and that run met every gate, so the
defaults are kept and written down here. `pool_pre_ping` is ours: after a restart of the Postgres
container the pool would otherwise hand out dead connections once each.
"""

from __future__ import annotations

from sqlalchemy import URL
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from coordination.config import Config
from coordination.store.connect import ConnectParams, params_from_config

DRIVER = "postgresql+asyncpg"
POOL_SIZE = 5  # SQLAlchemy default, what SP5b ran
MAX_OVERFLOW = 10  # SQLAlchemy default, what SP5b ran
POOL_TIMEOUT_S = 30
CONNECT_TIMEOUT_S = 10
APPLICATION_NAME = "a2a-coord"


def make_engine_from_params(params: ConnectParams) -> AsyncEngine:
    # The URL has no password; asyncpg gets it from connect_args only.
    url = URL.create(DRIVER, username=params.user, host=params.host, port=params.port, database=params.database)
    return create_async_engine(
        url,
        connect_args={
            "password": params.password,
            "timeout": CONNECT_TIMEOUT_S,
            "server_settings": {"application_name": APPLICATION_NAME},
        },
        pool_size=POOL_SIZE,
        max_overflow=MAX_OVERFLOW,
        pool_timeout=POOL_TIMEOUT_S,
        pool_pre_ping=True,
        # Statement parameters can hold task bodies. They stay out of SQLAlchemy error text.
        hide_parameters=True,
    )


def make_engine(config: Config) -> AsyncEngine:
    """Build the engine from `A2A_DB_URL` and `A2A_DB_PASSWORD_FILE`. Raises `DbConfigError`."""
    return make_engine_from_params(params_from_config(config))
