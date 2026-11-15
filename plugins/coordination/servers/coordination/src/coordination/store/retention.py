"""The retention job (spec 1.3).

Rules, nothing else:
- a terminal task (`COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`) is purged `A2A_RETAIN_DAYS` days
  (default 30) after its last status change;
- a `REJECTED` task of remote origin is purged 24 hours after its last status change;
- `audit` is never pruned.

Open tasks are never touched, however old: they leave through the TTL sweeps of S1-STATE, which
move them to a terminal state first. A terminal task has no outgoing transition, so a task the
query selected cannot become live again before it is deleted. A task whose status carries no
timestamp has no age and is kept (the store stamps every task it writes, so this should not occur).

The job takes a `Clock`, so the rule is tested with a fake one. It deletes in batches, each batch in
one transaction, so a purge of many rows never holds one long transaction.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import timedelta

from coordination.clock import Clock
from coordination.store.task_store import CoordTaskStore

log = logging.getLogger("coordination.retention")

REMOTE_REJECTED_AFTER = timedelta(hours=24)
DEFAULT_BATCH = 500
DEFAULT_INTERVAL_S = 3600.0


@dataclass(frozen=True)
class PurgeResult:
    terminal: int  # removed by the `A2A_RETAIN_DAYS` rule
    remote_rejected: int  # removed by the 24 h rule

    @property
    def total(self) -> int:
        return self.terminal + self.remote_rejected


class RetentionJob:
    def __init__(
        self,
        store: CoordTaskStore,
        clock: Clock,
        *,
        retain_days: int = 30,
        batch_size: int = DEFAULT_BATCH,
    ) -> None:
        if retain_days < 1:
            raise ValueError("A2A_RETAIN_DAYS must be at least 1")
        if batch_size < 1:
            raise ValueError("batch_size must be at least 1")
        self._store = store
        self._clock = clock
        self._retain = timedelta(days=retain_days)
        self._batch = batch_size

    async def run_once(self) -> PurgeResult:
        now = self._clock.now()
        # The 24 h rule goes first; what it leaves is then covered by the long rule when it is due.
        remote = await self._purge(self._store.remote_rejected_ids_older_than, now - REMOTE_REJECTED_AFTER)
        terminal = await self._purge(self._store.terminal_ids_older_than, now - self._retain)
        return PurgeResult(terminal=terminal, remote_rejected=remote)

    async def _purge(self, find: Callable, cutoff) -> int:
        removed = 0
        while True:
            ids = await find(cutoff, self._batch)
            if not ids:
                return removed
            removed += await self._store.delete_tasks(ids)
            if len(ids) < self._batch:
                return removed

    async def run_forever(
        self,
        interval_s: float = DEFAULT_INTERVAL_S,
        *,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        """Run `run_once` every `interval_s` seconds until cancelled.

        A failed run is logged without task data and tried again next round: the database
        being briefly away must not end the job.
        """
        while True:
            try:
                result = await self.run_once()
                if result.total:
                    log.info("retention purged %d terminal and %d remote rejected tasks", result.terminal, result.remote_rejected)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("retention run failed: %s", type(exc).__name__)
            await sleep(interval_s)
