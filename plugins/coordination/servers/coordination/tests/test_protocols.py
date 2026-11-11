import importlib
from datetime import UTC, datetime

import pytest

from coordination.clock import Clock, SystemClock
from coordination.service.protocol import ServiceLayer
from coordination.store.protocol import Store
from coordination.wake.protocol import Notifier


@pytest.mark.parametrize("pkg", ["service", "store", "mcp", "wake", "auth"])
def test_stream_packages_import(pkg):
    importlib.import_module(f"coordination.{pkg}")


def test_system_clock_satisfies_clock():
    clock = SystemClock()
    assert isinstance(clock, Clock)
    assert clock.now().tzinfo is UTC
    assert abs((datetime.now(UTC) - clock.now()).total_seconds()) < 5
    assert clock.monotonic() <= clock.monotonic()


def test_fakes_satisfy_protocols():
    class FakeStore:
        async def start(self): ...
        async def stop(self): ...
        async def ping(self): return True
        async def schema_version(self): return 1

    class FakeNotifier:
        async def notify_pending(self, handle): ...

    class FakeService:
        async def pending_count(self, handle): return 0

    assert isinstance(FakeStore(), Store)
    assert isinstance(FakeNotifier(), Notifier)
    assert isinstance(FakeService(), ServiceLayer)
    assert not isinstance(object(), Store)


def test_a2a_sdk_is_pinned_exactly():
    from importlib.metadata import version

    assert version("a2a-sdk") == "1.3.0"
