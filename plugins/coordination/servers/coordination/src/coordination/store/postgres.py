"""`PostgresStore`: the `Store` protocol on Postgres, plus what the other streams reach through it.

`start` opens the engine, waits for the database (bounded retries), brings both migration streams
to head in one transaction (the SDK's first, ours second) and refuses a schema newer than this
code knows. It builds `tasks` (the `CoordTaskStore`) and `retention` (the job; `start` does not
schedule it, the application decides when `run_forever` runs).
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine

from coordination.clock import Clock, SystemClock
from coordination.config import Config
from coordination.store import schema
from coordination.store.connect import params_from_config, wait_for_database
from coordination.store.engine import make_engine_from_params
from coordination.store.retention import RetentionJob
from coordination.store.task_store import CoordTaskStore


class PostgresStore:
    def __init__(self, config: Config, *, clock: Clock | None = None) -> None:
        self._config = config
        self._clock = clock if clock is not None else SystemClock()
        self._engine: AsyncEngine | None = None
        self._tasks: CoordTaskStore | None = None
        self._retention: RetentionJob | None = None

    async def start(self) -> None:
        """Connect, migrate, build the task store. Raises `SchemaTooNew` and `MigrationError`."""
        params = params_from_config(self._config)
        await wait_for_database(params)
        engine = make_engine_from_params(params)
        try:
            await schema.migrate_all(engine)
        except BaseException:
            await engine.dispose()
            raise
        self._engine = engine
        self._tasks = CoordTaskStore(engine, clock=self._clock)
        self._retention = RetentionJob(self._tasks, self._clock, retain_days=self._config.retain_days)

    async def stop(self) -> None:
        engine, self._engine = self._engine, None
        self._tasks = self._retention = None
        if engine is not None:
            await engine.dispose()

    async def ping(self) -> bool:
        if self._engine is None:
            return False
        try:
            async with self._engine.connect() as conn:
                return (await conn.execute(sa.text("SELECT 1"))).scalar_one() == 1
        except Exception:  # noqa: BLE001 - any failure means "does not answer"
            return False

    async def schema_version(self) -> int:
        """The `coord_schema_version` of our migration stream."""
        return (await schema.versions(self.engine)).coord_schema_version

    @property
    def engine(self) -> AsyncEngine:
        if self._engine is None:
            raise RuntimeError("the store is not started")
        return self._engine

    @property
    def tasks(self) -> CoordTaskStore:
        if self._tasks is None:
            raise RuntimeError("the store is not started")
        return self._tasks

    @property
    def retention(self) -> RetentionJob:
        if self._retention is None:
            raise RuntimeError("the store is not started")
        return self._retention
