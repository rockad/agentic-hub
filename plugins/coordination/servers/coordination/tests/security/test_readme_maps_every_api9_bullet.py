"""The acceptance of S1-SEC: "every api 9 bullet maps to at least one test (a table in the test README)".

Checks on `tests/security/README.md`:

1. Every test it names exists (`T/` is `tests/`, `S/` is `tests/security/`): the file is there and the
   function is defined in it. A renamed or deleted test breaks the table here, not silently.
2. Every row has a status word, and a row that names no test says why (deferred or not testable).
3. Every bullet of `docs/specs/server-api.md` section 9 has a row, in the spec's order, and the row's
   invariant column shares words with the bullet (at least three words of four letters or more, fewer if
   the bullet is short): the row quotes the bullet "in few words".

The checks are plain functions over the parsed rows, so the meta-tests at the bottom can feed them a table
with a missing row, a renamed test and an unexplained deferral and see each one refused.

Check 3 needs the spec, which is outside the server image's build context: it skips there. The CI
checkout run has it.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from conftest import PLUGIN_DIR

HERE = Path(__file__).resolve().parent
TESTS = HERE.parent
README = HERE / "README.md"
SPEC = PLUGIN_DIR / "docs" / "specs" / "server-api.md"
STATUS_WORDS = ("covered-existing", "new", "deferred", "not-testable-at-S1")
ROW = re.compile(r"^\| (B\d\d|P1) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \|\s*$")

Row = tuple[str, str, str, str, str]  # id, invariant, decisions, tests, status


def parse(text: str) -> list[Row]:
    return [m.groups() for m in map(ROW.match, text.splitlines()) if m]  # type: ignore[misc]


def words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]{4,}", text.lower().replace("`", "")))


def check_refs(rows: list[Row], tests_dir: Path = TESTS, security_dir: Path = HERE) -> int:
    named = 0
    for row_id, _, _, tests, _ in rows:
        for ref in (t.strip() for t in tests.split("<br>") if t.strip() not in ("", "none")):
            prefix, _, rest = ref.partition("/")
            assert prefix in ("T", "S"), (row_id, ref)
            file, _, name = rest.partition("::")
            path = (tests_dir if prefix == "T" else security_dir) / file
            assert path.is_file(), (row_id, ref, "no such file")
            assert re.search(rf"^\s*(async )?def {re.escape(name)}\b", path.read_text(), re.M), (row_id, ref, "no such test")
            named += 1
    return named


def check_status(rows: list[Row]) -> None:
    for row_id, _, _, tests, status in rows:
        assert status.startswith(STATUS_WORDS), (row_id, status)
        if status.startswith(("deferred", "not-testable-at-S1")):
            assert ":" in status and len(status.split()) > 4, (row_id, "a reason is required")
        if tests.strip() in ("", "none"):
            assert status.startswith(("deferred", "not-testable-at-S1")), (row_id, "no test and no deferral")


def spec_items(spec_text: str) -> list[tuple[str, str]]:
    """The bullets of api 9 as (row id, text), in the spec's order, with the closing paragraph about the
    closed tool set where it stands."""
    section = spec_text.split("## 9. Security invariants", 1)[1].split("\n## 10.", 1)[0]
    items, number = [], 0
    for line in section.splitlines():
        if line.startswith("- "):
            number += 1
            items.append((f"B{number:02d}", line[2:]))
        elif line.startswith("The MCP tool list is a closed set"):
            items.append(("P1", line))
    return items


def check_order(rows: list[Row], items: list[tuple[str, str]]) -> None:
    assert [r[0] for r in rows] == [i for i, _ in items], "the table and api 9 differ in their rows"
    for (row_id, invariant, *_), (_, bullet) in zip(rows, items, strict=True):
        shared = words(invariant) & words(bullet)
        assert len(shared) >= min(3, len(words(bullet))), (row_id, invariant, bullet[:80], shared)


def table() -> list[Row]:
    rows = parse(README.read_text())
    assert rows, "no table rows found in the README"
    return rows


def test_every_test_the_table_names_exists():
    assert check_refs(table()) > 100


def test_every_row_has_a_status_and_a_reason_where_nothing_is_tested():
    check_status(table())


def test_every_api9_bullet_has_a_row_in_order():
    if not SPEC.is_file():
        pytest.skip("docs/ is outside the image build context; the CI checkout run covers it")
    items = spec_items(SPEC.read_text())
    assert len(items) == 46, "the spec changed: update the table, the README and this number"
    check_order(table(), items)


# -- meta: the checks refuse what they are for ----------------------------------------------------------


def test_a_table_that_lost_a_row_is_refused():
    rows = table()
    items = [(r[0], r[1]) for r in rows]
    check_order(rows, items)  # control: the table matches itself
    with pytest.raises(AssertionError):
        check_order([r for r in rows if r[0] != "B24"], items)


def test_a_row_about_something_else_is_refused():
    rows = table()
    items = [(r[0], r[1]) for r in rows]
    mutated = [(r[0], "completely unrelated words about gardening", *r[2:]) if r[0] == "B05" else r for r in rows]
    with pytest.raises(AssertionError):
        check_order(mutated, items)


def test_a_renamed_test_and_a_missing_file_are_refused():
    rows = table()
    first = next(r for r in rows if "S/test_wake_text_is_a_constant_stub.py::" in r[3])
    renamed = (first[0], first[1], first[2], first[3].replace("test_every_listen_outcome", "test_no_such_test"), first[4])
    with pytest.raises(AssertionError, match="no such test"):
        check_refs([renamed])
    gone = (first[0], first[1], first[2], "S/test_no_such_file.py::test_x", first[4])
    with pytest.raises(AssertionError, match="no such file"):
        check_refs([gone])


def test_an_unexplained_deferral_and_an_untested_covered_row_are_refused():
    with pytest.raises(AssertionError):
        check_status([("B99", "x", "y", "none", "deferred")])
    with pytest.raises(AssertionError):
        check_status([("B99", "x", "y", "none", "covered-existing")])
    with pytest.raises(AssertionError):
        check_status([("B99", "x", "y", "T/a.py::t", "maybe")])
    check_status([("B99", "x", "y", "none", "deferred: S2-LISTEN, not built yet")])
