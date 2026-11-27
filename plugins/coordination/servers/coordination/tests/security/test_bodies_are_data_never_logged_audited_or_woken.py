"""Invariant (api 9, D10; plan S1-SEC "bodies are data"): task bodies reach a model only as tool results or
A2A responses, never in a wake, a hook context line, a log line, an audit row or the health check.

One canary run of the real server (`sec_env.run_canary_scenario`): every body that enters carries its own
unguessable string (a message, a data part, a follow-up, a response, an artifact, a cancel reason, a
remote peer's held task, bodies inside requests that fail, an oversized body, a hook prompt). The tests
below scan what the server wrote and said.

Positive controls come first: the canary IS found where a body is supposed to be (the task store and the
tool results), so a clean scan elsewhere means the bodies are not there, not that the scan cannot see.
"""

from __future__ import annotations

import re

import pytest
from sec_env import CanaryRun, run_canary_scenario, scan


@pytest.fixture(scope="module")
def canary_run(pg_server) -> CanaryRun:
    return run_canary_scenario(pg_server)


STORED = ("send", "data", "respond", "artifact", "peer", "second", "follow", "reason")


def test_positive_control_the_bodies_are_in_the_task_store(canary_run):
    for name in ("send", "data", "respond", "artifact", "peer", "second"):
        assert canary_run.canaries[name] in canary_run.sdk_tables, name


def test_positive_control_the_bodies_reach_the_model_as_tool_results(canary_run):
    texts = {t["name"]: "" for t in canary_run.tool_results}
    for t in canary_run.tool_results:
        texts[t["name"]] += t["result"]["content"][0]["text"]
    assert canary_run.canaries["send"] in texts["a2a_inbox"] and canary_run.canaries["data"] in texts["a2a_inbox"]
    assert canary_run.canaries["respond"] in texts["a2a_get"] and canary_run.canaries["artifact"] in texts["a2a_get"]
    assert canary_run.canaries["peer"] in texts["a2a_inbox"]  # the released remote task


def test_the_scan_finds_a_canary_that_is_planted(canary_run):
    needles = canary_run.all_needles
    assert scan("x " + needles[0] + " y", needles) == [needles[0]]
    assert scan("nothing here", needles) == []


def test_every_canary_run_wrote_the_logs_the_scan_reads(canary_run):
    assert canary_run.raw_log.count("\n") > 20, "the run logged almost nothing: the capture is broken, not the server clean"
    assert canary_run.json_log.count("\n") > 20
    assert "coordination" in canary_run.raw_log


def test_no_body_or_key_in_any_log_output(canary_run):
    assert scan(canary_run.raw_log, canary_run.all_needles) == []  # raw: before any redaction
    assert scan(canary_run.json_log, canary_run.all_needles) == []  # as production formats it
    assert scan(canary_run.stdio, canary_run.all_needles) == []  # nothing printed either


def test_no_body_or_key_in_any_audit_row(canary_run):
    assert canary_run.audit_text.count("\n") > 5, "too few audit rows: the capture is broken"
    assert {"state_transition", "wake_sent", "hold_entered", "hold_released"} <= set(canary_run.audit_events)
    assert scan(canary_run.audit_text, canary_run.all_needles) == []


def test_no_body_or_key_in_any_table_but_the_task_store(canary_run):
    assert {"audit", "wakes", "sessions", "task_index", "api_keys", "cards"} <= set(canary_run.other_tables)
    for table, text in canary_run.other_tables.items():
        if table == "api_keys":
            # the key table holds hashes, not tokens: the secret part of a token must not be there
            assert scan(text, [k.rsplit("_", 1)[-1] for k in canary_run.keys if len(k.rsplit("_", 1)[-1]) > 20]) == [], table
            continue
        assert scan(text, canary_run.all_needles) == [], table


def test_wake_capture_holds_no_body(canary_run):
    capture = "\n".join(canary_run.wake_capture)
    assert len(canary_run.wake_capture) >= 4
    assert re.search(r"^200 [0-9]{1,4} ", canary_run.wake_capture[0]), canary_run.wake_capture[0]  # the listen answer: one integer
    assert scan(capture, canary_run.all_needles) == []
    # the hook form answered with the constant stub and one integer, and nothing else
    stubs = re.findall(r"\[a2a\] [^\"]*", capture)
    assert stubs and all(re.fullmatch(r"\[a2a\] [0-9]{1,4} pending\. Call a2a_inbox\.", s) for s in stubs), stubs


def test_the_health_check_says_only_ok_true(canary_run):
    assert len(canary_run.healthz_capture) == 2
    for capture in canary_run.healthz_capture:
        assert capture.startswith('200 {"ok":true} '), capture
        assert scan(capture, canary_run.all_needles) == []


def test_no_answer_to_a_failed_request_echoes_a_body_or_a_key(canary_run):
    """The answers to the requests that failed (unknown tool, bad method, bad role, 413, 401) and to the
    sessions listing: a refusal never repeats what it refused."""
    assert len(canary_run.a2a_answers) >= 8
    echoed = {name: scan(answer, [canary_run.canaries[name]]) for name in ("mcperr", "rpcerr", "oversize", "authfail") for answer in canary_run.a2a_answers}
    assert not any(echoed.values()), {k: v for k, v in echoed.items() if v}
    assert scan("\n".join(canary_run.a2a_answers), canary_run.keys) == []


def test_the_failed_send_does_not_echo_its_body_in_the_tool_error(canary_run):
    bad = [t for t in canary_run.tool_results if t["arguments"].get("text") == canary_run.canaries["badsend"]]
    assert len(bad) == 1 and bad[0]["result"]["isError"] is True
    assert canary_run.canaries["badsend"] not in bad[0]["result"]["content"][0]["text"]
