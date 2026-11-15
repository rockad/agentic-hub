import asyncio
import json
from datetime import UTC, datetime, timedelta

import pytest

from coordination.audit import (
    REQUIRED_DETAIL,
    SYSTEM_ACTOR,
    AuditError,
    AuditEvent,
    AuditLog,
    AuditStore,
    InMemoryAuditStore,
    make_row,
)

T0 = datetime(2026, 11, 14, 12, 0, 0, tzinfo=UTC)


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def now(self):
        return T0 + timedelta(seconds=self.t - 1000.0)

    def monotonic(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def store():
    return InMemoryAuditStore()


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def log(store, clock):
    return AuditLog(store, clock)


def test_in_memory_store_satisfies_the_protocol(store):
    assert isinstance(store, AuditStore)
    assert not isinstance(object(), AuditStore)


def test_every_event_type_in_the_plan_exists():
    assert {e.value for e in AuditEvent} == {
        "key_created", "key_rotated", "key_revoked", "auth_failure_sampled", "registration",
        "wake_sent", "hold_entered", "hold_released", "hold_denied", "state_transition",
        "budget_exhausted", "handle_probe_limited",
    }  # fmt: skip
    # the one name the spec fixes, with its two fields (spec 1.3)
    assert AuditEvent.HANDLE_PROBE_LIMITED == "handle_probe_limited"
    assert REQUIRED_DETAIL[AuditEvent.HANDLE_PROBE_LIMITED] == {"key_id", "window_count"}


def test_each_writer_method_writes_one_valid_row(log, store):
    async def go():
        await log.key_created(actor="admin", key_id="k1", scope="local-harness")
        await log.key_rotated(actor="admin", key_id="k1", new_key_id="k2")
        await log.key_revoked(actor="admin", key_id="k2")
        await log.registration(actor="k1", handle="claude-code@box/x~3f2a9c1d", card_id="claude-code@box")
        await log.wake_sent(actor=SYSTEM_ACTOR, handle="claude-code@box/x~3f2a9c1d", pending_n=2)
        await log.budget_exhausted(actor=SYSTEM_ACTOR, handle="claude-code@box/x~3f2a9c1d", budget_per_h=20)
        await log.hold_entered(actor="k9", task_id="t1", origin="remote")
        await log.hold_released(actor="admin", task_id="t1")
        await log.hold_denied(actor="admin", task_id="t2")
        await log.state_transition(
            actor="k1", task_id="t1", from_state="TASK_STATE_SUBMITTED", to_state="TASK_STATE_WORKING"
        )
        await log.handle_probe_limited(actor="k9", key_id="k9", window_count=10)

    run(go())
    assert [r.event for r in store.rows] == [
        AuditEvent.KEY_CREATED, AuditEvent.KEY_ROTATED, AuditEvent.KEY_REVOKED,
        AuditEvent.REGISTRATION, AuditEvent.WAKE_SENT, AuditEvent.BUDGET_EXHAUSTED,
        AuditEvent.HOLD_ENTERED, AuditEvent.HOLD_RELEASED, AuditEvent.HOLD_DENIED,
        AuditEvent.STATE_TRANSITION, AuditEvent.HANDLE_PROBE_LIMITED,
    ]  # fmt: skip
    assert all(r.actor and r.at.tzinfo is not None for r in store.rows)


def test_handle_probe_limited_row_has_key_id_and_window_count(log, store):
    run(log.handle_probe_limited(actor="k9", key_id="k9", window_count=10))
    (row,) = store.of(AuditEvent.HANDLE_PROBE_LIMITED)
    assert row.subject == "k9"
    assert json.loads(row.detail_json()) == {"key_id": "k9", "window_count": 10}


def test_detail_json_is_compact_and_sorted(log, store):
    run(log.key_created(actor="admin", key_id="k1", scope="local-harness"))
    assert store.rows[0].detail_json() == '{"key_id":"k1","scope":"local-harness"}'


def test_state_transition_names_its_actor_and_is_one_row_each(log, store):
    chain = [
        (None, "TASK_STATE_SUBMITTED", "k1"),
        ("TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "k2"),
        ("TASK_STATE_WORKING", "TASK_STATE_COMPLETED", "k2"),
    ]

    async def go():
        for src, dst, actor in chain:
            await log.state_transition(actor=actor, task_id="t1", from_state=src, to_state=dst)

    run(go())
    rows = store.of(AuditEvent.STATE_TRANSITION)
    assert len(rows) == len(chain)
    assert [(r.detail["from_state"], r.detail["to_state"], r.actor) for r in rows] == chain


@pytest.mark.parametrize("actor", ["", "   "])
def test_state_transition_without_an_actor_is_refused(log, store, actor):
    with pytest.raises(AuditError):
        run(log.state_transition(actor=actor, task_id="t1", from_state=None, to_state="TASK_STATE_SUBMITTED"))
    assert store.rows == []


def test_unknown_task_state_is_refused(log, store):
    with pytest.raises(ValueError):
        run(log.state_transition(actor="k1", task_id="t1", from_state=None, to_state="TASK_STATE_AUTH_REQUIRED"))
    with pytest.raises(ValueError):
        run(log.state_transition(actor="k1", task_id="t1", from_state="bogus", to_state="QUARANTINED"))
    assert store.rows == []


def test_quarantined_is_a_valid_state(log, store):
    run(log.state_transition(actor="k1", task_id="t1", from_state="TASK_STATE_SUBMITTED", to_state="QUARANTINED"))
    assert len(store.rows) == 1


@pytest.mark.parametrize(
    "detail",
    [
        {"body": "hello"},
        {"message_text": "hello"},
        {"api_key": "x"},
        {"authorization": "x"},
        {"secret_hash": "x"},
        {"prompt": "x"},
        {"parts": "x"},
        {"Key_ID": "x"},  # not lower_snake_case
        {"nested": {"a": 1}},
        {"items": ["a"]},
        {"blob": b"bytes"},
    ],
)
def test_content_shaped_detail_is_refused(detail):
    with pytest.raises(AuditError):
        make_row(T0, AuditEvent.REGISTRATION, "k1", "h", **detail)


@pytest.mark.parametrize(
    "value",
    [
        "a2ak_dev_abc123_SECRETSECRETSECRET",
        "Bearer abcdefghijklmnop",
        "Authorization: Bearer abcdefghijklmnop",
        "x" * 257,
    ],
)
def test_secret_or_long_values_are_refused_in_detail_actor_and_subject(value):
    with pytest.raises(AuditError):
        make_row(T0, AuditEvent.REGISTRATION, "k1", "h", card_id=value)
    with pytest.raises(AuditError):
        make_row(T0, AuditEvent.REGISTRATION, value, "h")
    with pytest.raises(AuditError):
        make_row(T0, AuditEvent.REGISTRATION, "k1", value)


def test_key_id_alone_is_allowed():
    row = make_row(T0, AuditEvent.KEY_REVOKED, "admin", "k1", key_id="k1")
    assert row.detail == {"key_id": "k1"}


def test_required_detail_is_enforced():
    with pytest.raises(AuditError, match="window_count"):
        make_row(T0, AuditEvent.HANDLE_PROBE_LIMITED, "k9", "k9", key_id="k9")
    with pytest.raises(AuditError):
        make_row(T0, AuditEvent.STATE_TRANSITION, "k1", "t1", task_id="t1")


def test_naive_time_and_unknown_event_are_refused():
    with pytest.raises(AuditError):
        make_row(datetime(2026, 11, 14), AuditEvent.KEY_REVOKED, "a", "k", key_id="k")
    with pytest.raises(AuditError):
        make_row(T0, "made_up", "a")  # type: ignore[arg-type]


def test_a_refused_row_never_reaches_the_store(log, store):
    with pytest.raises(AuditError):
        run(log.registration(actor="k1", handle="a2ak_dev_abc_SECRETSECRETSECRET", card_id="c"))
    assert store.rows == []


def test_store_failure_propagates(log, store):
    store.fail_with = RuntimeError("db down")
    with pytest.raises(RuntimeError):
        run(log.key_revoked(actor="admin", key_id="k1"))


def test_failed_transition_append_leaves_no_row_and_is_never_retried_behind_the_caller(
    log, store
):
    """The OBS half of "transition and audit row commit together" (acceptance 3b).

    The writer must not swallow, buffer or retry a failed append. The error reaches the code that
    owns the transaction, which can then roll the transition back; and a later successful call
    writes its own row only, so a failed attempt never turns into a stray or duplicate row.
    """
    store.fail_with = RuntimeError("db down")
    with pytest.raises(RuntimeError):
        run(log.state_transition(actor="k1", task_id="t1", from_state=None, to_state="TASK_STATE_SUBMITTED"))
    assert store.rows == []

    store.fail_with = None
    run(log.state_transition(actor="k1", task_id="t2", from_state=None, to_state="TASK_STATE_SUBMITTED"))
    assert [r.subject for r in store.rows] == ["t2"]


def test_one_state_transition_call_makes_exactly_one_append(log, store):
    appended = []
    original = store.append_audit

    async def counting(row):
        appended.append(row)
        await original(row)

    store.append_audit = counting
    run(log.state_transition(actor="k1", task_id="t1", from_state="TASK_STATE_SUBMITTED", to_state="TASK_STATE_WORKING"))
    assert len(appended) == 1
    assert len(store.rows) == 1


@pytest.mark.skip(
    reason=(
        "Acceptance 3b end to end needs S1-STATE (state machine) and S1-STORE (audit table, "
        "transaction scope); neither exists in this stream. Handed over as an exit test of "
        "S1-STATE and S1-STORE: see docs/specs/audit-events.md section 2."
    )
)
def test_transition_and_its_audit_row_commit_together_against_postgres():
    """Placeholder, not a passing test. Intended shape for S1-STATE: against the real state
    machine and the Postgres test container, force the audit insert to fail mid-transition and
    assert the task state and version are unchanged and no audit row exists; then run a normal
    transition and assert exactly one `state_transition` row naming the actor."""


# sampled auth failures -------------------------------------------------------------------


def test_many_failures_in_one_window_make_no_row_until_the_window_closes(log, store, clock):
    async def go():
        for _ in range(500):
            assert await log.auth_failure() is None
            clock.advance(0.05)  # 25 s in total, inside the 60 s window

    run(go())
    assert store.rows == []


def test_one_sampled_row_per_window_with_the_count(log, store, clock):
    async def go():
        for _ in range(100):  # window 1: 100 failures over 50 s
            await log.auth_failure()
            clock.advance(0.5)
        clock.advance(20)  # window 1 is now closed
        row = await log.auth_failure()  # first failure of window 2 closes window 1
        assert row is not None
        for _ in range(49):
            await log.auth_failure()
        clock.advance(61)
        await log.flush_auth_failures()

    run(go())
    rows = store.of(AuditEvent.AUTH_FAILURE_SAMPLED)
    assert len(rows) == 2 and len(store.rows) == 2  # never one per failed request
    assert [r.detail["count"] for r in rows] == [100, 50]
    assert all(r.actor == SYSTEM_ACTOR and r.subject is None for r in rows)
    assert rows[0].detail["window_s"] == 60.0
    assert rows[0].detail["window_started_at"] == T0.isoformat()


def test_flush_writes_the_open_window_when_due_or_forced(log, store, clock):
    async def go():
        await log.auth_failure()
        assert await log.flush_auth_failures() is None  # not due yet
        assert await log.flush_auth_failures(force=True) is not None
        assert await log.flush_auth_failures(force=True) is None  # nothing pending
        await log.auth_failure()
        clock.advance(60)
        assert await log.flush_auth_failures() is not None

    run(go())
    assert [r.detail["count"] for r in store.rows] == [1, 1]


def test_concurrent_failures_are_all_counted_once(store, clock):
    log = AuditLog(store, clock)

    async def go():
        await asyncio.gather(*(log.auth_failure() for _ in range(200)))
        await log.flush_auth_failures(force=True)

    run(go())
    assert [r.detail["count"] for r in store.rows] == [200]


def test_window_must_be_positive(store, clock):
    with pytest.raises(ValueError):
        AuditLog(store, clock, auth_failure_window_s=0)
