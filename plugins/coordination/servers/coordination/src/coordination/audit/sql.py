"""The SQL side of the audit log: the `audit` table writer, alone or inside a caller's transaction.

Two entry points, one statement:

- `insert_audit(tx, row)` writes one row on a connection or session the caller already holds, so
  the row commits or rolls back with whatever else that transaction does. This is the
  transaction-joining variant (decision Z6, 2026-11-15). `CoordTaskStore.transition` and
  `CoordTaskStore.create` use it so a task write, its `task_index` update and its
  `state_transition` row are ONE database transaction.
- `SqlAuditStore.append_audit(row)` opens its own transaction for the events that do not ride on a
  task write (registration, wake sent, key lifecycle, and so on). It is the `AuditStore` the
  server wires to the audit writer.

The row has been checked by `events.validate` before it gets here; nothing in this module looks at
content. `detail` goes into the JSON column as a dict, never as a pre-encoded string.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession

from coordination.audit.events import AuditRow
from coordination.store.tables import audit


async def insert_audit(tx: AsyncConnection | AsyncSession, row: AuditRow) -> None:
    """Insert one `audit` row on the caller's transaction. Never updates or deletes."""
    await tx.execute(
        sa.insert(audit).values(
            at=row.at,
            actor=row.actor,
            event=row.event.value,
            subject=row.subject,
            detail_json=dict(row.detail),
        )
    )


class SqlAuditStore:
    """`AuditStore` over the `audit` table, plus the transaction-joining `append_audit_in`."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def append_audit(self, row: AuditRow) -> None:
        async with self._engine.begin() as conn:
            await insert_audit(conn, row)

    async def append_audit_in(self, tx: AsyncConnection | AsyncSession, row: AuditRow) -> None:
        await insert_audit(tx, row)
