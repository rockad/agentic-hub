"""The CI skip gate, `scripts/check-pytest-skips.sh`: it reads pytest's JUnit file and fails a run that
skipped what it should have run (Opus review of PR #94, 2026-11-23).

Each test calls the script with a tiny crafted JUnit file in `tmp_path`; the last one makes the file
with a real pytest run on a one-test project with one skip, so the gate is checked against what the
installed pytest really writes. No Docker. The script is outside `src/` and `tests/`, so the image
build, which runs the suite with only those two, skips these tests.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import PLUGIN_DIR

# Inside the server image PLUGIN_DIR is /app-like and has no second parent: the lookup must not raise at
# import, the autouse fixture below skips the module instead.
try:
    SCRIPT = PLUGIN_DIR.parents[1] / "scripts" / "check-pytest-skips.sh"
except IndexError:
    SCRIPT = Path("/nonexistent/check-pytest-skips.sh")
ALLOWED = "tests.test_a2a_tck tests.test_backup_script tests.test_compose"


@pytest.fixture(autouse=True)
def _need_script():
    if not SCRIPT.is_file():
        pytest.skip(f"{SCRIPT} is not present (the image build runs the suite with only src/ and tests/)")
    if shutil.which("bash") is None:
        pytest.skip("bash is not installed")


def suite(tests: int = 10, skipped: int = 0, failures: int = 0, errors: int = 0, body: str = "", extra: str = "") -> str:
    attrs = f'name="pytest" errors="{errors}" failures="{failures}" skipped="{skipped}" tests="{tests}" time="0.1"{extra}'
    return f"<testsuite {attrs}>{body}</testsuite>"


def skip_case(module: str, name: str = "test_x") -> str:
    return (
        f'<testcase classname="{module}" name="{name}" time="0.000">'
        f'<skipped type="pytest.skip" message="why">{module}.py:1: why</skipped></testcase>'
    )


def junit(tmp_path: Path, content: str, *, wrap: bool = True) -> Path:
    path = tmp_path / "junit.xml"
    text = f'<testsuites name="pytest tests">{content}</testsuites>' if wrap else content
    path.write_text(f'<?xml version="1.0" encoding="utf-8"?>{text}')
    return path


def gate(xml: Path, expected: int, minimum: int, allowed: str | None = None) -> subprocess.CompletedProcess[str]:
    argv = ["bash", str(SCRIPT), str(xml), str(expected), str(minimum)]
    if allowed is not None:
        argv.append(allowed)
    return subprocess.run(argv, capture_output=True, text=True, check=False, timeout=30)


def test_passes_with_exact_expectations(tmp_path):
    xml = junit(tmp_path, suite(tests=12, skipped=0))
    proc = gate(xml, 0, 12)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.splitlines()[-1] == "OK"
    assert "tests=12 skipped=0 failures=0 errors=0" in proc.stdout


def test_passes_with_skips_when_the_count_matches(tmp_path):
    body = skip_case("tests.test_compose") + skip_case("tests.test_a2a_tck")
    xml = junit(tmp_path, suite(tests=12, skipped=2, body=body))
    assert gate(xml, 2, 10).returncode == 0


def test_fails_when_an_attribute_is_missing(tmp_path):
    for missing in ("tests", "skipped", "failures", "errors"):
        content = suite(tests=5).replace(f' {missing}=', f' x{missing}=')
        proc = gate(junit(tmp_path, content), 0, 1)
        assert proc.returncode == 1, missing
        assert f"no {missing} attribute" in proc.stderr
        assert "OK" not in proc.stdout


def test_fails_without_a_testsuite_element(tmp_path):
    proc = gate(junit(tmp_path, "<nothing/>"), 0, 0)
    assert proc.returncode == 1 and "no <testsuite> element" in proc.stderr


def test_fails_on_a_missing_or_empty_file(tmp_path):
    assert gate(tmp_path / "absent.xml", 0, 0).returncode == 1
    empty = tmp_path / "empty.xml"
    empty.write_text("")
    assert gate(empty, 0, 0).returncode == 1


def test_fails_on_an_unexpected_skip_count(tmp_path):
    xml = junit(tmp_path, suite(tests=10, skipped=1, body=skip_case("tests.test_x")))
    proc = gate(xml, 0, 1)
    assert proc.returncode == 1
    assert "1 tests skipped, expected exactly 0" in proc.stderr
    assert "message=\"why\"" in proc.stderr  # the reasons are listed
    assert gate(junit(tmp_path, suite(tests=10, skipped=0)), 1, 1).returncode == 1  # fewer than expected too


def test_fails_on_an_unexpected_skipped_module(tmp_path):
    body = skip_case("tests.test_compose") + skip_case("tests.test_hooks_listen", "test_listener")
    xml = junit(tmp_path, suite(tests=10, skipped=2, body=body))
    proc = gate(xml, 2, 1, ALLOWED)
    assert proc.returncode == 1
    offenders = proc.stderr.splitlines()[1:]  # after the header line: one counted line per offender
    assert [line.split() for line in offenders] == [["1", "tests.test_hooks_listen"]]
    assert "OK" not in proc.stdout


def test_a_module_that_only_shares_a_prefix_is_not_allowed(tmp_path):
    xml = junit(tmp_path, suite(tests=10, skipped=1, body=skip_case("tests.test_compose_extra")))
    assert gate(xml, 1, 1, "tests.test_compose").returncode == 1


def test_passes_with_the_allowlist(tmp_path):
    body = skip_case("tests.test_a2a_tck") + skip_case("tests.test_backup_script") + skip_case("tests.test_compose")
    xml = junit(tmp_path, suite(tests=20, skipped=3, body=body))
    proc = gate(xml, 3, 20, ALLOWED)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.splitlines()[-1] == "OK"


def test_the_count_rule_still_applies_with_the_allowlist(tmp_path):
    body = skip_case("tests.test_a2a_tck") + skip_case("tests.test_compose")
    xml = junit(tmp_path, suite(tests=20, skipped=2, body=body))
    assert gate(xml, 3, 1, ALLOWED).returncode == 1


def test_an_unreadable_skip_cannot_be_attributed_and_fails(tmp_path):
    # skipped="1" in the suite but no skipped testcase in the file: the module cannot be checked.
    xml = junit(tmp_path, suite(tests=10, skipped=1))
    proc = gate(xml, 1, 1, ALLOWED)
    assert proc.returncode == 1 and "cannot be checked" in proc.stderr


def test_a_testcase_written_over_several_lines_is_read(tmp_path):
    body = '<testcase\n  classname="tests.test_compose"\n  name="test_x">\n<skipped\n type="pytest.skip" message="why">x</skipped>\n</testcase>'
    xml = junit(tmp_path, suite(tests=10, skipped=1, body=body))
    assert gate(xml, 1, 1, ALLOWED).returncode == 0
    assert gate(xml, 1, 1, "tests.test_other").returncode == 1


@pytest.mark.parametrize("kind", ["failures", "errors"])
def test_fails_on_failures_and_errors(tmp_path, kind):
    xml = junit(tmp_path, suite(tests=10, **{kind: 1}))
    proc = gate(xml, 0, 1)
    assert proc.returncode == 1 and "failures or errors" in proc.stderr


def test_fails_when_fewer_tests_than_the_minimum_ran(tmp_path):
    proc = gate(junit(tmp_path, suite(tests=9)), 0, 10)
    assert proc.returncode == 1 and "only 9 tests ran, expected at least 10" in proc.stderr


def test_several_testsuite_elements_are_summed(tmp_path):
    content = suite(tests=6, skipped=1, body=skip_case("tests.test_compose")) + suite(tests=7, skipped=1, body=skip_case("tests.test_a2a_tck"))
    xml = junit(tmp_path, content)
    proc = gate(xml, 2, 13, ALLOWED)
    assert proc.returncode == 0, proc.stderr
    assert "tests=13 skipped=2" in proc.stdout
    assert gate(xml, 2, 14, ALLOWED).returncode == 1  # the minimum counts the sum, not the first suite
    # A failure in the second suite is not hidden by a clean first one.
    bad = junit(tmp_path, suite(tests=6) + suite(tests=7, failures=1))
    assert gate(bad, 0, 1).returncode == 1
    # An attribute missing from the second suite fails too.
    partial = junit(tmp_path, suite(tests=6) + suite(tests=7).replace(" skipped=", " xskipped="))
    assert gate(partial, 0, 1).returncode == 1


def test_a_testsuite_without_the_wrapping_element_is_read(tmp_path):
    assert gate(junit(tmp_path, suite(tests=3), wrap=False), 0, 3).returncode == 0


def test_the_real_junit_file_of_a_one_test_project_with_one_skip(tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    (project / "test_one.py").write_text(
        "import pytest\n\n\ndef test_ok():\n    pass\n\n\n@pytest.mark.skip(reason='on purpose')\ndef test_skipped():\n    pass\n"
    )
    xml = tmp_path / "real.xml"
    env = {k: v for k, v in os.environ.items() if not k.startswith(("PYTEST_", "A2A_"))}
    run = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", f"--junitxml={xml}", "test_one.py"],
        cwd=project, capture_output=True, text=True, env=env, check=False, timeout=120,
    )
    assert run.returncode == 0, run.stdout + run.stderr
    assert xml.is_file()

    ok = gate(xml, 1, 2)
    assert ok.returncode == 0, ok.stderr
    assert "tests=2 skipped=1 failures=0 errors=0" in ok.stdout
    assert gate(xml, 1, 2, "test_one").returncode == 0  # the classname is the module path pytest wrote
    other = gate(xml, 1, 2, "tests.test_other")
    assert other.returncode == 1 and "test_one" in other.stderr
    assert gate(xml, 0, 2).returncode == 1
    assert gate(xml, 1, 3).returncode == 1


def test_a_module_level_skip_is_attributed_to_its_module_not_dropped(tmp_path):
    """pytest.skip(allow_module_level=True) writes an empty classname and the module path in name. The
    first version printed an empty line for it, counted it, and then let it pass the allowlist."""
    case = (
        '<testcase classname="" name="tests.test_modskip" time="0.000">'
        '<skipped type="pytest.skip" message="why">tests/test_modskip.py:1: why</skipped></testcase>'
    )
    body = skip_case("tests.test_compose") + skip_case("tests.test_a2a_tck") + case
    xml = junit(tmp_path, suite(tests=10, skipped=3, body=body))
    bad = gate(xml, 3, 1, ALLOWED)
    assert bad.returncode == 1 and "tests.test_modskip" in bad.stderr
    ok_body = skip_case("tests.test_compose") + skip_case("tests.test_a2a_tck") + case.replace("test_modskip", "test_backup_script")
    ok = junit(tmp_path, suite(tests=10, skipped=3, body=ok_body))
    assert gate(ok, 3, 1, ALLOWED).returncode == 0


def test_a_skip_in_a_test_class_of_an_allowed_module_is_allowed(tmp_path):
    xml = junit(tmp_path, suite(tests=5, skipped=1, body=skip_case("tests.test_compose.TestStack")))
    assert gate(xml, 1, 1, ALLOWED).returncode == 0
    other = junit(tmp_path, suite(tests=5, skipped=1, body=skip_case("tests.test_other.TestStack")))
    assert gate(other, 1, 1, ALLOWED).returncode == 1


def test_a_real_module_level_skip_is_caught(tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    (project / "test_modskip.py").write_text("import pytest\n\npytest.skip('on purpose', allow_module_level=True)\n")
    (project / "test_allowed.py").write_text(
        "import pytest\n\n\n@pytest.mark.skip(reason='a')\ndef test_a():\n    pass\n\n\n@pytest.mark.skip(reason='b')\ndef test_b():\n    pass\n"
    )
    xml = tmp_path / "real.xml"
    env = {k: v for k, v in os.environ.items() if not k.startswith(("PYTEST_", "A2A_"))}
    subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", f"--junitxml={xml}", "."],
        cwd=project, capture_output=True, text=True, env=env, check=False, timeout=120,
    )
    assert xml.is_file()
    bad = gate(xml, 3, 0, "test_allowed")
    assert bad.returncode == 1, bad.stdout + bad.stderr
    assert "test_modskip" in bad.stderr
