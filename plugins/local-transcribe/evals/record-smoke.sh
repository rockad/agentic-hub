#!/usr/bin/env bash
# Smoke test for the recorder CLI: detection, negotiation, and every refusal.
#
# It drives no real recorder — that needs OBS running or macOS Screen Recording
# permission, neither of which a test can arrange. What it checks is that the
# tool tells the truth about this machine and refuses clearly when it cannot do
# what was asked. `evals/recorder_test.py` covers the stop and archive logic.
#
#   ./evals/record-smoke.sh
#
# Exit 0 means every check passed.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECORD="$HERE/../scripts/record.py"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/local-transcribe-record-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

export LOCAL_TRANSCRIBE_STATE_DIR="$WORK/state"
export LOCAL_TRANSCRIBE_RECORD_DIR="$WORK/recordings"
unset LOCAL_TRANSCRIBE_RECORDER LOCAL_TRANSCRIBE_ARCHIVE_DIR 2>/dev/null || true

PASS=0
FAIL=0
ok()    { printf '  \033[32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()   { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

run()  { uv run --script "$RECORD" "$@" 2>&1; }
code() { uv run --script "$RECORD" "$@" >/dev/null 2>&1; echo $?; }

head_ "Detection"

# Warm the environment: a cold uv cache prints "Installed N packages" first.
run detect >/dev/null 2>&1

out="$(run detect)"
[[ "$(code detect)" == 0 ]] && ok "detect exits 0 even with no recorder available" \
                            || bad "detect exited non-zero"
for backend in obs screencapture; do
    [[ "$out" == *"$backend"* ]] && ok "detect reports the $backend backend" \
                                 || bad "detect did not mention $backend"
done
[[ "$out" == *"Can record a call:"* ]] && ok "detect states whether a call is recordable" \
                                       || bad "detect omitted the call verdict"

if [[ "$(uname)" == "Darwin" ]]; then
    [[ "$out" == *"NO system audio"* || "$out" == *"system audio"* ]] \
        && ok "detect states the system-audio position on macOS" \
        || bad "detect said nothing about system audio"
fi

head_ "Detection in JSON"
json="$(run detect --json)"
if command -v jq >/dev/null 2>&1; then
    names="$(printf '%s' "$json" | jq -r '.[].name' 2>/dev/null | sort | tr '\n' ' ')"
    [[ "$names" == "obs screencapture "* ]] && ok "--json lists both backends" \
                                            || bad "--json names: $names"
    printf '%s' "$json" | jq -e 'all(.[]; has("can_record_a_call"))' >/dev/null 2>&1 \
        && ok "--json carries can_record_a_call per backend" \
        || bad "--json is missing can_record_a_call"
else
    printf '  \033[33mskip\033[0m  jq not installed; JSON shape unchecked\n'
fi

head_ "Refusals"

got="$(code start)"
out="$(run start)"
if [[ "$out" == *"Refusing to record"* || "$out" == *"No recorder on this machine can capture a call"* ]]; then
    [[ "$got" == 3 ]] && ok "start refuses a call it cannot capture (exit 3)" \
                      || bad "start refused but exited $got"
    [[ "$out" == *"--mic-only"* ]] && ok "the refusal names --mic-only as the way forward" \
                                   || bad "the refusal did not mention --mic-only"
elif [[ "$got" == 0 ]]; then
    printf '  \033[33mskip\033[0m  a backend on this machine can record a call; refusal path unchecked\n'
    run stop >/dev/null 2>&1
else
    bad "start exited $got with unexpected output: $out"
fi

out="$(run start --backend nosuchthing)"
[[ "$out" == *"Unknown recorder backend"* ]] && ok "an unknown backend is named as such" \
                                             || bad "unknown backend said: $out"

out="$(run status)"
[[ "$out" == *"Nothing is recording"* ]] && ok "status is honest when idle" \
                                         || bad "status said: $out"

got="$(code stop)"
out="$(run stop)"
[[ "$got" == 3 && "$out" == *"nothing to stop"* ]] \
    && ok "stop with nothing running exits 3 and says why" \
    || bad "stop gave exit $got: $out"

head_ "OBS, when it is not running"
out="$(run start --backend obs)"
if [[ "$out" == *"not usable on this machine"* ]]; then
    ok "an absent OBS is refused with a reason"
    [[ "$out" == *"not installed"* || "$out" == *"WebSocket"* ]] \
        && ok "the reason names installation or the WebSocket server" \
        || bad "the reason was unhelpful: $out"
else
    printf '  \033[33mskip\033[0m  OBS appears to be running; absence path unchecked\n'
fi

head_ "A pinned backend is honoured"
out="$(LOCAL_TRANSCRIBE_RECORDER=obs run detect)"
[[ "$out" == *"pins: obs"* ]] && ok "detect reports the pinned backend" \
                             || bad "pinning was not reported"

head_ "The consent reminder is on the recorder, not the transcriber"
out="$(run start --mic-only)"
[[ "$out" == *"get agreement before you start"* ]] \
    && ok "start prints the consent reminder" \
    || bad "start printed no consent reminder"
run stop >/dev/null 2>&1
out="$(uv run --script "$HERE/../scripts/transcribe.py" --help 2>&1)"
[[ "$out" != *"get agreement"* ]] && ok "the transcriber never mentions consent" \
                                 || bad "the transcriber prompted about consent"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL == 0 ]] || exit 1
