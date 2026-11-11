"""Storage interface. S1-STORE implements it and extends it with the task and table operations."""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class Store(Protocol):
    async def start(self) -> None:
        """Open the connection pool. Raises if the schema is newer than the code knows."""
        ...

    async def stop(self) -> None:
        """Close the pool."""
        ...

    async def ping(self) -> bool:
        """True if the database answers."""
        ...

    async def schema_version(self) -> int:
        """The `coord_schema_version` of our migration stream."""
        ...
