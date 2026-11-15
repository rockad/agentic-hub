"""The storage side of the audit log, as the audit writer sees it (S1-OBS).

S1-STORE owns the `audit` table and the real `Store`. It does not exist yet, and
`store/protocol.py` is outside S1-OBS's scope, so the narrow interface the writer needs is
declared here. S1-STORE's store must provide `append_audit` (a method on `Store`, or a small
adapter) before the audit writer is wired to a real database.

For "exactly one audit row per state transition" the transition and its row must commit
together. `AuditStore.append_audit` is the simple form, in its own transaction. The
transaction-joining variant (S1-STATE, decision Z6) is `TransactionalAuditStore.append_audit_in`
and the module function `coordination.audit.sql.insert_audit`, both of which write on a
connection or session the caller already holds. The state machine does not call them through
this protocol: `CoordTaskStore.transition` takes the rows and writes them inside its own
transaction. The writer (`AuditLog`) has no part in the transaction; it only builds rows.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from coordination.audit.events import AuditRow


@runtime_checkable
class AuditStore(Protocol):
    async def append_audit(self, row: AuditRow) -> None:
        """Insert one row into the append-only `audit` table. Never updates or deletes."""
        ...


@runtime_checkable
class TransactionalAuditStore(AuditStore, Protocol):
    async def append_audit_in(self, tx: Any, row: AuditRow) -> None:
        """Insert one row on the caller's open connection or session, so it commits or rolls
        back with the caller's other writes. Opens and closes no transaction of its own."""
        ...
