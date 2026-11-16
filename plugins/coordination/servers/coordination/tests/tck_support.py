"""Support for the A2A TCK gate (`test_a2a_tck.py`): the stand-in front for the TCK, the allowlist
reader and the gate itself.

The gate is pure: it takes the JUnit XML the TCK wrote and the allowlist, and says which failures
are not allowed, which allowlist entries no longer fail (stale) and which entries are malformed.
It is tested offline in `test_a2a_tck_gate.py`; running the TCK itself needs a checkout of the TCK
and Python 3.15 and is `test_a2a_tck.py`.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

import yaml

TCK_DIR = Path(__file__).resolve().parent / "tck"
ALLOWLIST_FILE = TCK_DIR / "allowlist.yaml"

#: The TCK commit the allowlist was written against (`a2aproject/a2a-tck`, HEAD on 2026-11-16).
#: CI checks out exactly this commit; a bump needs a new run and a re-reviewed allowlist.
TCK_COMMIT = "104a7b4"

# A test id as the gate spells it: JUnit `classname::name`, the same string pytest prints.
_ID_RE = re.compile(r"^\S+$")
REVIEW_STATES = ("proposed", "reviewed")


class AllowlistError(ValueError):
    """The allowlist file is malformed. The gate refuses to run on one: a typo must not widen it."""


@dataclass(frozen=True)
class Deviation:
    """One reviewed deviation: a TCK test that is allowed to fail, and why."""

    test: str
    decision: str  # the plan decision or spec section that makes this a deliberate deviation
    reason: str
    review: str  # "proposed" (written by the builder) or "reviewed" (the user signed it off)


@dataclass(frozen=True)
class Allowlist:
    tck_commit: str
    entries: tuple[Deviation, ...]

    def by_test(self) -> dict[str, Deviation]:
        return {d.test: d for d in self.entries}

    @property
    def unreviewed(self) -> tuple[Deviation, ...]:
        return tuple(d for d in self.entries if d.review != "reviewed")


def parse_allowlist(text: str) -> Allowlist:
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise AllowlistError(f"not valid YAML: {exc}") from exc
    if not isinstance(raw, dict) or set(raw) - {"tck_commit", "deviations"}:
        raise AllowlistError("expected a mapping with only `tck_commit` and `deviations`")
    commit = raw.get("tck_commit")
    if not isinstance(commit, str) or not commit:
        raise AllowlistError("`tck_commit` must be a non-empty string")
    items = raw.get("deviations") or []
    if not isinstance(items, list):
        raise AllowlistError("`deviations` must be a list")
    entries: list[Deviation] = []
    seen: set[str] = set()
    for i, item in enumerate(items):
        if not isinstance(item, dict) or set(item) != {"test", "decision", "reason", "review"}:
            raise AllowlistError(f"deviation {i}: needs exactly `test`, `decision`, `reason`, `review`")
        for key in ("test", "decision", "reason"):
            if not isinstance(item[key], str) or not item[key].strip():
                raise AllowlistError(f"deviation {i}: `{key}` must be a non-empty string")
        if not _ID_RE.match(item["test"]) or "*" in item["test"]:
            raise AllowlistError(f"deviation {i}: `test` must be one exact test id with no wildcard and no spaces")
        if item["review"] not in REVIEW_STATES:
            raise AllowlistError(f"deviation {i}: `review` must be one of {REVIEW_STATES}")
        if item["test"] in seen:
            raise AllowlistError(f"deviation {i}: {item['test']} is listed twice")
        seen.add(item["test"])
        entries.append(Deviation(item["test"], item["decision"].strip(), item["reason"].strip(), item["review"]))
    return Allowlist(commit, tuple(entries))


def load_allowlist(path: Path = ALLOWLIST_FILE) -> Allowlist:
    return parse_allowlist(path.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class Outcome:
    test: str
    status: str  # passed, failed, skipped, xfailed, xpassed
    message: str = ""


def parse_junit(xml_text: str) -> list[Outcome]:
    """Every test case of a pytest JUnit report as an `Outcome`.

    `error` (a fixture or setup failure) counts as failed. `skipped` with type `pytest.xfail` is an
    expected failure (the TCK marks SHOULD-level requirements that way, and they do not block).
    """
    root = ET.fromstring(xml_text)  # the TCK's own output, written by us
    outcomes: list[Outcome] = []
    for case in root.iter("testcase"):
        test = f"{case.get('classname', '')}::{case.get('name', '')}"
        failure = case.find("failure")
        error = case.find("error")
        skipped = case.find("skipped")
        if failure is not None or error is not None:
            node = failure if failure is not None else error
            assert node is not None
            outcomes.append(Outcome(test, "failed", (node.get("message") or "")[:300]))
        elif skipped is not None:
            kind = skipped.get("type", "")
            outcomes.append(Outcome(test, "xfailed" if "xfail" in kind else "skipped", (skipped.get("message") or "")[:300]))
        else:
            outcomes.append(Outcome(test, "passed"))
    return outcomes


@dataclass
class GateResult:
    blocking: list[Outcome] = field(default_factory=list)  # failed and not on the allowlist
    allowed: list[tuple[Outcome, Deviation]] = field(default_factory=list)  # failed and on the allowlist
    stale: list[Deviation] = field(default_factory=list)  # on the allowlist but passed, or not run at all
    ran: int = 0

    @property
    def ok(self) -> bool:
        return self.ran > 0 and not self.blocking and not self.stale

    def report(self) -> str:
        lines = [f"TCK gate: {self.ran} test cases, {len(self.allowed)} allowed deviations failed, "
                 f"{len(self.blocking)} blocking, {len(self.stale)} stale allowlist entries"]
        if self.ran == 0:
            lines.append("no test case ran: the TCK did not produce a usable report")
        for o in self.blocking:
            lines.append(f"  BLOCKING {o.test}: {o.message}")
        for d in self.stale:
            lines.append(f"  STALE    {d.test}: listed ({d.decision}) but it did not fail; remove it")
        return "\n".join(lines)


def gate(outcomes: list[Outcome], allowlist: Allowlist) -> GateResult:
    """A failure not on the allowlist blocks. An allowlist entry that did not fail is stale and also
    blocks (so the list cannot grow into a place where fixed deviations hide)."""
    listed = allowlist.by_test()
    result = GateResult(ran=len(outcomes))
    failed: set[str] = set()
    for o in outcomes:
        if o.status != "failed":
            continue
        failed.add(o.test)
        if o.test in listed:
            result.allowed.append((o, listed[o.test]))
        else:
            result.blocking.append(o)
    result.stale = [d for d in allowlist.entries if d.test not in failed]
    return result


