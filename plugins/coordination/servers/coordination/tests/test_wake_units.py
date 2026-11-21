"""S1-WAKE without a database: the listener table, the release outcomes, and the three small rules
(anti-loop over wake rows, announce dedupe, park limiter). The behaviour of the endpoints over a real Postgres is
in `test_wake.py` and `test_wake_e2e.py`."""

from __future__ import annotations

import asyncio
import inspect
import random
import re
from datetime import UTC, datetime, timedelta

import pytest

from coordination.wake import outcomes
from coordination.wake.outcomes import (
    COUNT_BODY_RE,
    ENDED,
    GONE,
    KEY_REVOKED,
    ROUND_END,
    SHUTDOWN,
    SUPERSEDED,
    Release,
    woken,
)
from coordination.wake.routes import response_for
from coordination.wake.rules import Announcer, ParkLimiter, anti_loop_blocked, fingerprint
from coordination.wake.store import WakeRow
from coordination.wake.table import ListenerTable

T0 = datetime(2026, 11, 18, 12, 0, 0, tzinfo=UTC)
CARD = "claude-code@box"
H1 = f"{CARD}/one~aaaaaaa1"
H2 = f"{CARD}/two~aaaaaaa2"
H3 = "claude-code@mac/one~ccccccc1"


def run(coro):
    return asyncio.run(coro)


# -- Release -------------------------------------------------------------------------------


def test_the_only_body_a_release_can_carry_is_a_count_in_a_200():
    assert woken(3).body == "3" and woken(3).status == 200
    for bad in ("", "hello", "1 2", "12345", "-1", "1.5", "[a2a] 1 pending", "12\n", " 1", "\u0663"):
        with pytest.raises(ValueError):
            Release(200, body=bad)
    for status in (403, 408, 409, 410, 429, 503):
        with pytest.raises(ValueError):
            Release(status, body="1")


@pytest.mark.parametrize("count", [-5, 0, 1, 9, 10, 9999, 10000, 123456789])
def test_woken_is_clamped_to_one_to_four_digits(count):
    body = woken(count).body
    assert COUNT_BODY_RE.fullmatch(body) and 1 <= int(body) <= 9999


def test_status_table_of_the_release_constants():
    assert (ROUND_END.status, ROUND_END.reason) == (408, None)
    assert (SUPERSEDED.status, SUPERSEDED.reason) == (409, "superseded")
    assert (KEY_REVOKED.status, KEY_REVOKED.reason) == (403, None)
    assert (ENDED.status, ENDED.reason) == (410, "ended")
    assert (SHUTDOWN.status, SHUTDOWN.retry_after) == (503, 5)
    assert GONE.status == 499 and not GONE.body


def test_response_for_never_writes_a_body_except_the_200_count():
    ok = response_for(woken(7))
    assert ok.status_code == 200 and ok.body == b"7" and ok.media_type == "text/plain"
    for release in (ROUND_END, SUPERSEDED, KEY_REVOKED, ENDED, SHUTDOWN, GONE):
        r = response_for(release)
        assert r.body == b""
        assert r.headers["cache-control"] == "no-store"
    assert response_for(SUPERSEDED).headers["x-coord-reason"] == "superseded"
    assert response_for(ENDED).headers["x-coord-reason"] == "ended"
    shutdown = response_for(SHUTDOWN)
    assert shutdown.status_code == 503 and shutdown.headers["retry-after"] == "5"
    assert response_for(GONE).status_code == 408  # the client is gone; nobody reads it


# -- the listener table ---------------------------------------------------------------------


def test_newest_listener_wins_and_the_old_one_gets_409():
    async def go():
        table = ListenerTable()
        first = table.park(H1, CARD, "k1")
        assert table.is_listening(H1) and len(table) == 1
        second = table.park(H1, CARD, "k2")
        assert first.future.result() == SUPERSEDED and not second.done
        assert table.get(H1) is second and len(table) == 1
        table.remove(first)  # the old request finishing must not evict the new listener
        assert table.get(H1) is second
        table.remove(second)
        assert not table.is_listening(H1) and len(table) == 0

    run(go())


def test_listening_views_agree_with_the_table():
    async def go():
        table = ListenerTable()
        a = table.park(H1, CARD, "k1")
        b = table.park(H2, CARD, "k1")
        c = table.park(H3, "claude-code@mac", "k2")
        assert table.newest_listening(CARD) == H2  # the newest of the card
        assert table.newest_listening("claude-code@mac") == H3
        assert table.newest_listening("antigravity@box") is None
        a.release(ROUND_END)
        assert not table.is_listening(H1) and table.count() == 2  # an ended listener is not listening
        b.release(ROUND_END)
        assert table.newest_listening(CARD) is None
        c.release(ROUND_END)
        assert table.count() == 0

    run(go())


def test_close_key_answers_only_that_keys_listeners_with_403():
    async def go():
        table = ListenerTable()
        a = table.park(H1, CARD, "k1")
        b = table.park(H2, CARD, "k1")
        c = table.park(H3, "claude-code@mac", "k2")
        assert table.close_key("k1") == 2
        assert a.future.result() == KEY_REVOKED and b.future.result() == KEY_REVOKED and not c.done
        assert table.close_key("k1") == 0  # nothing left to close
        assert table.close_key("nobody") == 0

    run(go())


def test_close_session_answers_that_handle_with_410():
    async def go():
        table = ListenerTable()
        a = table.park(H1, CARD, "k1")
        b = table.park(H2, CARD, "k1")
        assert table.close_session(H1) == 1
        assert a.future.result() == ENDED and not b.done
        assert table.close_session(H1) == 0 and table.close_session("claude-code@box/none~00000000") == 0

    run(go())


def test_shutdown_answers_everyone_503_and_refuses_new_listeners():
    async def go():
        table = ListenerTable()
        a = table.park(H1, CARD, "k1")
        b = table.park(H3, "claude-code@mac", "k2")
        assert not table.closing
        assert table.begin_shutdown() == 2
        assert a.future.result() == SHUTDOWN and b.future.result() == SHUTDOWN
        assert table.closing and table.count() == 0
        assert table.begin_shutdown() == 0  # idempotent

    run(go())


def test_a_released_listener_cannot_be_released_twice():
    async def go():
        table = ListenerTable()
        a = table.park(H1, CARD, "k1")
        assert a.release(woken(2)) is True
        assert a.release(ROUND_END) is False
        assert a.future.result() == woken(2)

    run(go())


# -- the anti-loop rule ---------------------------------------------------------------------


def test_fingerprint_names_a_set_not_an_order():
    assert fingerprint(frozenset({"a", "b"})) == fingerprint(frozenset({"b", "a"}))
    assert fingerprint(frozenset({"a"})) != fingerprint(frozenset({"a", "b"}))
    assert fingerprint(frozenset()) == fingerprint(frozenset())


KEY = fingerprint(frozenset({"t1"}))
OTHER = fingerprint(frozenset({"t1", "t2"}))


def wake_row(n: int, at: datetime, set_hash: str | None = KEY, *, confirmed: bool = False) -> WakeRow:
    return WakeRow(n, at, 1, at + timedelta(seconds=30) if confirmed else None, set_hash)


def newest_first(*rows: WakeRow) -> list[WakeRow]:
    return sorted(rows, key=lambda r: r.at, reverse=True)


def three_wakes(first: datetime = T0, gap: timedelta = timedelta(seconds=130)) -> list[WakeRow]:
    return newest_first(*(wake_row(n, first + gap * n) for n in (1, 2, 3)))


def test_three_unconfirmed_wakes_for_one_set_stop_wakes_for_an_hour():
    assert not anti_loop_blocked([], KEY, T0)
    rows = three_wakes()
    last = rows[0].at
    assert not anti_loop_blocked(rows[1:], KEY, last)  # two wakes are not a streak
    assert anti_loop_blocked(rows, KEY, last + timedelta(seconds=1))
    assert anti_loop_blocked(rows, KEY, last + timedelta(minutes=59))
    assert not anti_loop_blocked(rows, KEY, last + timedelta(hours=1))  # one hour since the last wake


def test_a_changed_pending_set_lifts_the_stop():
    rows = three_wakes()
    now = rows[0].at + timedelta(minutes=1)
    assert anti_loop_blocked(rows, KEY, now)
    assert not anti_loop_blocked(rows, OTHER, now)  # a new set has a new hash and no streak


def test_a_set_that_came_back_after_another_does_not_continue_the_old_streak():
    a, b, c = wake_row(1, T0), wake_row(2, T0 + timedelta(minutes=3), OTHER), wake_row(3, T0 + timedelta(minutes=6))
    assert not anti_loop_blocked(newest_first(a, b, c), KEY, T0 + timedelta(minutes=7))


def test_a_confirmed_wake_ends_the_streak():
    first, second, third = three_wakes()[::-1]
    confirmed_third = wake_row(3, third.at, confirmed=True)
    assert not anti_loop_blocked(newest_first(first, second, confirmed_third), KEY, third.at + timedelta(minutes=1))
    # after the confirmation the same set counts afresh: two more wakes are not yet a stop
    later = [wake_row(4, T0 + timedelta(minutes=20)), wake_row(5, T0 + timedelta(minutes=23))]
    rows = newest_first(first, second, confirmed_third, *later)
    assert not anti_loop_blocked(rows, KEY, T0 + timedelta(minutes=24))
    rows = newest_first(*rows, wake_row(6, T0 + timedelta(minutes=26)))
    assert anti_loop_blocked(rows, KEY, T0 + timedelta(minutes=27))


def test_a_gap_of_an_hour_between_wakes_ends_the_streak():
    rows = newest_first(wake_row(1, T0), wake_row(2, T0 + timedelta(minutes=70)), wake_row(3, T0 + timedelta(minutes=75)))
    assert not anti_loop_blocked(rows, KEY, T0 + timedelta(minutes=76))
    rows = newest_first(wake_row(1, T0), wake_row(2, T0 + timedelta(minutes=50)), wake_row(3, T0 + timedelta(minutes=75)))
    assert anti_loop_blocked(rows, KEY, T0 + timedelta(minutes=76))  # each gap under an hour: still one streak


def test_rows_written_before_migration_4_never_count():
    old = [wake_row(n, T0 + timedelta(minutes=n), None) for n in (1, 2, 3)]
    assert not anti_loop_blocked(newest_first(*old), KEY, T0 + timedelta(minutes=4))


# -- the announce dedupe --------------------------------------------------------------------


def test_announce_is_true_once_for_a_stable_count_and_again_after_a_change_or_ten_minutes():
    a = Announcer()
    assert a.check(H1, 2, T0, record=True) is True
    assert a.check(H1, 2, T0 + timedelta(seconds=1), record=True) is False
    assert a.check(H1, 2, T0 + timedelta(minutes=9, seconds=59), record=True) is False
    assert a.check(H1, 2, T0 + timedelta(minutes=10), record=True) is True  # ten minutes passed
    assert a.check(H1, 2, T0 + timedelta(minutes=10, seconds=1), record=True) is False
    assert a.check(H1, 3, T0 + timedelta(minutes=10, seconds=2), record=True) is True  # the count changed
    assert a.check(H1, 1, T0 + timedelta(minutes=10, seconds=3), record=True) is True  # a smaller count is a change too


def test_announce_is_never_true_for_zero_and_zero_clears_the_memory():
    a = Announcer()
    assert a.check(H1, 0, T0, record=True) is False
    assert a.check(H1, 2, T0, record=True) is True
    assert a.check(H1, 0, T0 + timedelta(seconds=5), record=True) is False
    assert a.check(H1, 2, T0 + timedelta(seconds=10), record=True) is True  # new work after an empty inbox [design]


def test_announce_without_record_changes_nothing():
    a = Announcer()
    assert a.check(H1, 2, T0, record=False) is True
    assert a.check(H1, 2, T0, record=False) is True  # still fresh: nothing was remembered
    assert a.check(H1, 2, T0, record=True) is True
    assert a.check(H1, 2, T0, record=False) is False


def test_announce_is_per_handle():
    a = Announcer()
    assert a.check(H1, 2, T0, record=True) is True
    assert a.check(H2, 2, T0, record=True) is True
    assert a.check(H1, 2, T0, record=True) is False


# -- the park limiter -----------------------------------------------------------------------


def test_park_limiter_allows_the_limit_then_gives_a_retry_after():
    limiter = ParkLimiter(limit=3, window_s=60.0)
    for n in range(3):
        assert limiter.check(H1, 100.0 + n) is None
    wait = limiter.check(H1, 103.0)
    assert wait is not None and 1.0 <= wait <= 60.0
    assert limiter.check(H2, 103.0) is None  # per handle
    assert limiter.check(H1, 160.5) is None  # the window slid past the first park
    assert limiter.check(H1, 161.0) is None
    assert limiter.check(H1, 161.5) is not None


# -- structural: nothing on the wake path can reach task text -------------------------------


def test_the_wake_package_never_reads_task_text():
    """The wake path moves integers and ids. It must not import the MCP frame, call the task read
    API, or touch message parts (security invariant: wake text is a constant stub)."""
    from pathlib import Path

    import coordination.wake as wake_pkg

    root = Path(wake_pkg.__file__).parent
    forbidden = [
        r"coordination\.mcp",
        r"\.inbox\(",
        r"\.get_task\(",
        r"\.list_tasks\(",
        r"\.parts\b",
        r"\bhistory\b(?!_)",
        r"\bartifacts?\b",
        r"build_frame",
    ]
    for path in sorted(root.glob("*.py")):
        code = "\n".join(
            line for line in path.read_text().splitlines() if not line.lstrip().startswith("#")
        )
        # docstrings may mention the words; look at the code outside triple-quoted strings
        code = re.sub(r'"""(?:.|\n)*?"""', "", code)
        for pattern in forbidden:
            assert not re.search(pattern, code), f"{path.name} matches {pattern}"


def test_random_text_never_changes_what_the_wake_answer_can_be():
    """Whatever bytes a task carries, a `Release` is an integer or empty: there is no field that
    could take task text, and the constructor refuses anything else."""
    rng = random.Random(1337)
    alphabet = "abc 123\n\x1b[31m\u202e\u0663{}[]approve:ignore previous instructions"
    for _ in range(500):
        text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 60)))
        try:
            release = Release(200, body=text)
        except ValueError:
            continue
        assert COUNT_BODY_RE.fullmatch(release.body) and release.body.isascii()
    assert outcomes.MAX_COUNT == 9999


# -- the interfaces the rest of the server expects -------------------------------------------


def test_the_table_is_the_listener_view_and_the_service_is_the_notifier():
    from coordination.service import ListenerView
    from coordination.wake.protocol import Notifier
    from coordination.wake.service import WakeService

    assert isinstance(ListenerTable(), ListenerView)
    assert callable(getattr(WakeService, "notify_pending", None))

    class _Probe:  # a stand-in with the one method shape the task service calls
        async def notify_pending(self, handle: str) -> None: ...

    assert isinstance(_Probe(), Notifier)
    # the real service has the same method, so the task service can be given it as its notifier
    assert inspect.iscoroutinefunction(WakeService.notify_pending)
