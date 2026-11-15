"""In-memory `AuditStore`, a test double (S1-OBS). Not used by the server."""

from __future__ import annotations

from coordination.audit.events import AuditEvent, AuditRow


class InMemoryAuditStore:
    def __init__(self) -> None:
        self.rows: list[AuditRow] = []
        self.fail_with: Exception | None = None  # set to make the next appends raise

    async def append_audit(self, row: AuditRow) -> None:
        if self.fail_with is not None:
            raise self.fail_with
        self.rows.append(row)

    def of(self, event: AuditEvent) -> list[AuditRow]:
        return [r for r in self.rows if r.event == event]
