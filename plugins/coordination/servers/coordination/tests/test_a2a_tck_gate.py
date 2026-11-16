"""The TCK gate and the allowlist file, offline: no TCK, no server, no database.

The gate decides whether the CI job blocks, so it is tested on its own: a failure that is not on the
list blocks, a listed failure does not, a listed test that no longer fails is stale and blocks, an
empty or missing report blocks, and a malformed allowlist is refused instead of read loosely.
"""

from __future__ import annotations

import pytest
from tck_support import (
    ALLOWLIST_FILE,
    TCK_COMMIT,
    AllowlistError,
    Outcome,
    gate,
    load_allowlist,
    parse_allowlist,
    parse_junit,
)

JUNIT = """<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" tests="6">
<testcase classname="tests.compatibility.core.test_a" name="test_ok[jsonrpc]"/>
<testcase classname="tests.compatibility.core.test_a" name="test_bad[jsonrpc]"><failure message="AssertionError: nope">trace</failure></testcase>
<testcase classname="tests.compatibility.core.test_a" name="test_err[http_json]"><error message="fixture blew up">trace</error></testcase>
<testcase classname="tests.compatibility.core.test_a" name="test_should[jsonrpc]"><skipped type="pytest.xfail" message="should">x</skipped></testcase>
<testcase classname="tests.compatibility.core.test_a" name="test_may[jsonrpc]"><skipped type="pytest.skip" message="not declared">x</skipped></testcase>
</testsuite></testsuites>
"""

BAD = "tests.compatibility.core.test_a::test_bad[jsonrpc]"
ERR = "tests.compatibility.core.test_a::test_err[http_json]"


def allowlist(*tests: str, review: str = "proposed"):
    items = "\n".join(
        f"  - {{test: '{t}', decision: Z1, reason: because, review: {review}}}" for t in tests
    )
    return parse_allowlist(f"tck_commit: abc\ndeviations:\n{items}\n" if tests else "tck_commit: abc\ndeviations: []\n")


def test_junit_cases_become_outcomes():
    by_test = {o.test.split("::")[1]: o.status for o in parse_junit(JUNIT)}
    assert by_test == {
        "test_ok[jsonrpc]": "passed",
        "test_bad[jsonrpc]": "failed",
        "test_err[http_json]": "failed",  # a fixture or setup error is a failure
        "test_should[jsonrpc]": "xfailed",  # a SHOULD requirement: expected, does not block
        "test_may[jsonrpc]": "skipped",
    }


def test_a_failure_not_on_the_allowlist_blocks():
    result = gate(parse_junit(JUNIT), allowlist(BAD))
    assert not result.ok
    assert [o.test for o in result.blocking] == [ERR]
    assert [o.test for o, _ in result.allowed] == [BAD]
    assert "BLOCKING" in result.report() and ERR in result.report()


def test_every_failure_listed_passes_the_gate():
    result = gate(parse_junit(JUNIT), allowlist(BAD, ERR))
    assert result.ok and not result.blocking and not result.stale
    assert len(result.allowed) == 2


def test_a_listed_test_that_no_longer_fails_is_stale_and_blocks():
    ok_test = "tests.compatibility.core.test_a::test_ok[jsonrpc]"
    gone = "tests.compatibility.core.test_a::test_gone[jsonrpc]"  # not in the run at all
    result = gate(parse_junit(JUNIT), allowlist(BAD, ERR, ok_test, gone))
    assert not result.ok
    assert [d.test for d in result.stale] == [ok_test, gone]
    assert "STALE" in result.report()


def test_a_report_with_no_test_cases_blocks():
    result = gate([], allowlist())
    assert not result.ok and "did not produce a usable report" in result.report()


def test_xfailed_and_skipped_never_block():
    outcomes = [Outcome("a::b", "xfailed"), Outcome("a::c", "skipped"), Outcome("a::d", "passed")]
    assert gate(outcomes, allowlist()).ok


@pytest.mark.parametrize(
    "text, why",
    [
        ("- not a mapping", "mapping"),
        ("tck_commit: abc\nextra: 1\ndeviations: []", "mapping"),
        ("deviations: []", "tck_commit"),
        ("tck_commit: abc\ndeviations: nope", "list"),
        ("tck_commit: abc\ndeviations:\n  - {test: a::b}", "exactly"),
        ("tck_commit: abc\ndeviations:\n  - {test: 'a::*', decision: Z1, reason: r, review: proposed}", "wildcard"),
        ("tck_commit: abc\ndeviations:\n  - {test: 'a b', decision: Z1, reason: r, review: proposed}", "no spaces"),
        ("tck_commit: abc\ndeviations:\n  - {test: a::b, decision: Z1, reason: '', review: proposed}", "reason"),
        ("tck_commit: abc\ndeviations:\n  - {test: a::b, decision: Z1, reason: r, review: maybe}", "review"),
        (
            "tck_commit: abc\ndeviations:\n"
            "  - {test: a::b, decision: Z1, reason: r, review: proposed}\n"
            "  - {test: a::b, decision: Z1, reason: r, review: proposed}",
            "twice",
        ),
        ("tck_commit: [", "YAML"),
    ],
)
def test_a_malformed_allowlist_is_refused(text, why):
    with pytest.raises(AllowlistError, match=why):
        parse_allowlist(text)


def test_the_allowlist_file_in_the_repository_is_well_formed_and_matches_the_pinned_tck():
    listed = load_allowlist(ALLOWLIST_FILE)
    assert listed.tck_commit == TCK_COMMIT
    for d in listed.entries:
        assert "::" in d.test, f"{d.test}: a test id is classname::name"
