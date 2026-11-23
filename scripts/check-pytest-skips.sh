#!/usr/bin/env bash
# Fail a CI job when a pytest run skipped more tests than it is allowed to, or ran too few.
#
# Why: the coordination tests skip (not fail) when a repository file, Docker or a tool is missing, and
# the image build runs them with only src/ and tests/, so 102 hook tests skipped there and CI stayed
# green while nothing tested the hook scripts (Opus review of PR #94, 2026-11-23). A green run that
# skipped what it was meant to check proves nothing, so the job reads pytest's JUnit file.
#
# Usage: check-pytest-skips.sh <junit.xml> <expected-skips> <min-tests>
#   expected-skips  the exact number of skips the run must have (0 for the hook tests)
#   min-tests       the run must have collected at least this many tests
set -euo pipefail

xml=${1:?junit xml}
expected=${2:?expected skips}
min=${3:?min tests}

[ -s "$xml" ] || { echo "FAIL: $xml is missing or empty" >&2; exit 1; }
suite=$(grep -o '<testsuite [^>]*>' "$xml" | head -n 1)
attr() { printf '%s' "$suite" | grep -oE " $1=\"[0-9]+\"" | head -n 1 | grep -oE '[0-9]+' || echo 0; }
tests=$(attr tests)
skipped=$(attr skipped)
failures=$(attr failures)
errors=$(attr errors)
echo "tests=$tests skipped=$skipped failures=$failures errors=$errors (expected skips $expected, at least $min tests)"

[ "$failures" = 0 ] && [ "$errors" = 0 ] || { echo "FAIL: the run has failures or errors" >&2; exit 1; }
[ "$tests" -ge "$min" ] || { echo "FAIL: only $tests tests ran, expected at least $min" >&2; exit 1; }
if [ "$skipped" != "$expected" ]; then
  echo "FAIL: $skipped tests skipped, expected exactly $expected. Skip reasons:" >&2
  grep -oE '<skipped [^>]*message="[^"]*"' "$xml" | sort | uniq -c | head -n 20 >&2 || true
  exit 1
fi
echo "OK"
