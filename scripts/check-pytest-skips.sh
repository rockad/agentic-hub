#!/usr/bin/env bash
# Fail a CI job when a pytest run skipped more tests than it is allowed to, or ran too few.
#
# Why: the coordination tests skip (not fail) when a repository file, Docker or a tool is missing, and
# the image build runs them with only src/ and tests/, so 102 hook tests skipped there and CI stayed
# green while nothing tested the hook scripts (Opus review of PR #94, 2026-11-23). A green run that
# skipped what it was meant to check proves nothing, so the job reads pytest's JUnit file.
#
# Usage: check-pytest-skips.sh <junit.xml> <expected-skips> <min-tests> [allowed-skip-modules]
#   expected-skips        the exact number of skips the run must have (0 for the hook tests)
#   min-tests             the run must have collected at least this many tests
#   allowed-skip-modules  optional, space-separated: the classname (the test module, for example
#                         tests.test_a2a_tck) of every skipped testcase must be in this list, so a
#                         skip in another module fails even when the count still matches
#
# The attributes tests, skipped, failures and errors must be present on every <testsuite> element
# (a missing one fails the check, it does not count as 0). pytest wraps the suite in <testsuites>;
# with more than one <testsuite> the attributes are summed.
set -euo pipefail

xml=${1:?junit xml}
expected=${2:?expected skips}
min=${3:?min tests}
allowed=${4-}

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -s "$xml" ] || fail "$xml is missing or empty"
# One line, so a tag that a writer wrapped over several lines still matches.
flat=$(tr '\n\r\t' '   ' <"$xml")
suites=$(printf '%s' "$flat" | grep -oE '<testsuite [^>]*>' || true)
[ -n "$suites" ] || fail "$xml has no <testsuite> element"

# attr NAME: the sum of NAME over all <testsuite> elements; fails when one of them lacks it.
attr() {
  local name=$1 total=0 tag v
  while IFS= read -r tag; do
    v=$(printf '%s' "$tag" | grep -oE " $name=\"[0-9]+\"" | head -n 1 | grep -oE '[0-9]+' || true)
    [ -n "$v" ] || fail "a <testsuite> element in $xml has no $name attribute"
    total=$((total + 10#$v))
  done <<<"$suites"
  echo "$total"
}
tests=$(attr tests)
skipped=$(attr skipped)
failures=$(attr failures)
errors=$(attr errors)
echo "tests=$tests skipped=$skipped failures=$failures errors=$errors (expected skips $expected, at least $min tests)"

[ "$failures" = 0 ] && [ "$errors" = 0 ] || fail "the run has failures or errors"
[ "$tests" -ge "$min" ] || fail "only $tests tests ran, expected at least $min"
if [ "$skipped" != "$expected" ]; then
  echo "FAIL: $skipped tests skipped, expected exactly $expected. Skip reasons:" >&2
  printf '%s' "$flat" | grep -oE '<skipped [^>]*message="[^"]*"' | sort | uniq -c | head -n 20 >&2 || true
  exit 1
fi

if [ -n "$allowed" ]; then
  # The classname of each skipped testcase: a <skipped> element sits inside the nearest preceding
  # <testcase ...> tag. A module-level skip (pytest.skip(allow_module_level=True)) has an empty
  # classname and the module path in name: that name is used. Anything unreadable is "?", never allowed.
  skips=$(printf '%s' "$flat" | grep -oE '<testcase [^>]*>|<skipped[ />]' | awk '
    /^<testcase / {
      cls = ""
      if (match($0, / classname="[^"]*"/)) { cls = substr($0, RSTART + 12, RLENGTH - 13) }
      if (cls == "" && match($0, / name="[^"]*"/)) { cls = substr($0, RSTART + 7, RLENGTH - 8) }
      if (cls == "") { cls = "?" }
      next }
    /^<skipped/ { print cls }') || true
  found=0
  [ -z "$skips" ] || found=$(printf '%s\n' "$skips" | wc -l | tr -d ' ')
  [ "$found" = "$skipped" ] || fail "$skipped tests skipped but $found skipped testcases could be read, so their modules cannot be checked"
  offenders=
  while IFS= read -r cls; do
    [ -n "$cls" ] || continue
    # a skip inside a test class has the classname module.Class: the module decides
    case " $allowed " in
      *" $cls "*|*" ${cls%.*} "*) ;;
      *) offenders="$offenders$cls"$'\n' ;;
    esac
  done <<<"$skips"
  if [ -n "$offenders" ]; then
    echo "FAIL: skipped tests in modules that are not allowed to skip (allowed: $allowed):" >&2
    printf '%s' "$offenders" | sort | uniq -c >&2
    exit 1
  fi
fi
echo "OK"
