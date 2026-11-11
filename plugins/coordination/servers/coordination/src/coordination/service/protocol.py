"""Service layer interface. S1-STATE implements it; `/a2a/v1` and `/mcp` both call it."""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class ServiceLayer(Protocol):
    async def pending_count(self, handle: str) -> int:
        """Wakeable-eligible tasks for `handle`, no bodies (spec 7.5). S1-STATE adds the rest."""
        ...
