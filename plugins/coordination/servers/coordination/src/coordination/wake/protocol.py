"""Notifier interface: how the service layer tells the wake machinery that work is pending."""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class Notifier(Protocol):
    async def notify_pending(self, handle: str) -> None:
        """Tell the parked listener of `handle`, if any, that tasks are pending.

        Carries no task content: the wake text is a constant stub (security invariant).
        """
        ...
