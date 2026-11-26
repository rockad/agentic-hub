#!/usr/bin/env bash
# test-clarify-next-reminder.sh - tests for plugins/clarify/hooks/clarify-next-reminder.sh
# (the Claude Code PostToolUse hook that reminds the model, after an answer, to print the next
# question's full step) and for the DENIED handling of the offline checker.
#
# Requires: bash, jq. Exits non-zero when any case fails.

# shellcheck disable=SC2016  # jq programs are single-quoted on purpose
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
hook="$root/plugins/clarify/hooks/clarify-next-reminder.sh"
checker="$root/scripts/check-clarify-transcript.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }

: > "$tmp/pass"; : > "$tmp/fail"
ok() { echo "PASS $1"; echo x >> "$tmp/pass"; }
bad() { echo "FAIL $1"; echo x >> "$tmp/fail"; }

# run <name> <question text|-> <expected regex on additionalContext | none>
run() {
  local name="$1" q="$2" want="$3" out ctx
  if [ "$q" = "-" ]; then out="$(printf '' | CLARIFY_HOOK_STRICT=1 bash "$hook" 2>/dev/null)" || { bad "$name: exit"; return; }
  else
    out="$(jq -nc --arg q "$q" '{tool_name: "AskUserQuestion", tool_input: {questions: [{question: $q}]}, tool_response: {}}' \
      | CLARIFY_HOOK_STRICT=1 bash "$hook" 2>/dev/null)" || { bad "$name: exit"; return; }
  fi
  ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
  if [ "$want" = none ]; then
    if [ -z "$out" ]; then ok "$name"; else bad "$name: expected no output, got $out"; fi
  elif printf '%s' "$ctx" | grep -Eq -- "$want"; then ok "$name"; else bad "$name: expected /$want/, got '$ctx'"; fi
}

run mid-series '[Question 3 of 8] Which store?' 'Question 3 of 8 is answered.*Question 4 \(of 8\)'
run fork-prefix '[Fork 2 of 5] Which store?' 'Question 3 \(of 5\)'
run first-question '[Question 1 of 4] x' 'Question 2 \(of 4\)'
run zero-padded-number '[Question 08 of 10] x' 'Question 9 \(of 10\)'
run last-question '[Question 8 of 8] x' 'last question \(8 of 8\).*decision table'
run leading-space-and-case '  [question 3 of 8] x' 'Question 4 \(of 8\)'
run not-a-clarify-question 'Which store should we use?' none
run closing-gate-untagged 'Ready to proceed with execution?' none
run empty-payload - none
# Never blocks: the output has no decision field.
out="$(jq -nc '{tool_input: {questions: [{question: "[Question 3 of 8] x"}]}}' | bash "$hook")"
if printf '%s' "$out" | jq -e '(.hookSpecificOutput | has("permissionDecision") or has("decision")) | not' >/dev/null 2>&1 \
   && printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "PostToolUse"' >/dev/null 2>&1; then ok never-blocks; else bad never-blocks; fi
# Malformed input fails open.
if printf 'not json' | bash "$hook" >/dev/null 2>&1; then ok malformed-fails-open; else bad malformed-fails-open; fi

# The checker (Claude mode) still reports a call denied by a hook as DENIED, so transcripts from
# sessions that ran the earlier checkpoint hook keep scoring correctly.
user() { jq -nc --arg c "${1:-go}" '{type: "user", uuid: ("u-" + $c), message: {role: "user", content: $c}}'; }
text() { jq -nc --arg c "$1" '{type: "assistant", message: {role: "assistant", content: [{type: "text", text: $c}]}}'; }
D="Pros and cons of this option in two sentences, long enough to pass the description length floor of the checker, which is 120 characters."
qcall() { jq -nc --arg id "$1" --arg d "$D" '{type: "assistant", message: {role: "assistant", content: [{type: "tool_use", id: $id, name: "AskUserQuestion", input: {questions: [{question: "[Question 3 of 8] Which store?", header: "Fork 3/8", multiSelect: false, options: [{label: "Option A: sqlite", description: $d, preview: "x\n→ next: full Question 4 write-up, then ask"}]}]}}]}}'; }
result() { jq -nc --arg id "$1" --arg c "$2" '{type: "user", message: {role: "user", content: [{type: "tool_result", tool_use_id: $id, content: $c}]}}'; }
want() { local got; got="$(bash "$checker" --format claude "$tmp/$1.jsonl" 2>&1 | tail -1)"; if [ "$got" = "$2" ]; then ok "$1"; else bad "$1: expected '$2', got '$got'"; fi; }
{ user; text '## Question 3 (of 8) — x'; qcall a; result a 'PreToolUse:AskUserQuestion hook error: clarify checkpoint (routine, not an error) for Question 3.'; qcall b; result b answered; } > "$tmp/checker-denied.jsonl"
want checker-denied 'checked=1 failed=0 warned=0 denied=1'
{ user; qcall a; result a answered; } > "$tmp/checker-no-prose.jsonl"
want checker-no-prose 'checked=1 failed=1 warned=0 denied=0'
{ user; text '## Question 3 (of 8) — x'; qcall a; result a answered; } > "$tmp/checker-plain-pass.jsonl"
want checker-plain-pass 'checked=1 failed=0 warned=0 denied=0'

pass=$(wc -l < "$tmp/pass"); fail=$(wc -l < "$tmp/fail")
echo "passed=$((pass)) failed=$((fail))"
[ "$((fail))" -eq 0 ]
