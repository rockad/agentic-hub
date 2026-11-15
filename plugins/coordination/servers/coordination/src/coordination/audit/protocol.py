"""The storage side of the audit log, as the audit writer sees it (S1-OBS).

S1-STORE owns the `audit` table and the real `Store`. It does not exist yet, and
`store/protocol.py` is outside S1-OBS's scope, so the narrow interface the writer needs is
declared here. S1-STORE's store must provide `append_audit` (a method on `Store`, or a small
adapter) before the audit writer is wired to a real database.

For "exactly one audit row per state transition" the transition and its row must commit
together. `AuditStore.append_audit` is the simple form. S1-STORE and S1-STATE may add a
transaction-scoped variant; the writer does not depend on it.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from coordination.audit.events import AuditRow


@runtime_checkable
class AuditStore(Protocol):
    async def append_audit(self, row: AuditRow) -> None:
        """Insert one row into the append-only `audit` table. Never updates or deletes."""
        ...
