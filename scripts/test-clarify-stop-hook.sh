#!/usr/bin/env bash
# test-clarify-stop-hook.sh - regression tests for skills/clarify/hooks/clarify-stop-check.sh
# and the matching Antigravity mode of scripts/check-clarify-transcript.sh.
#
# Requires: bash, jq. Exits non-zero on the first failing group.

set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
hook="$root/skills/clarify/hooks/clarify-stop-check.sh"
checker="$root/scripts/check-clarify-transcript.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }


user() { jq -nc --arg c "$1" '{type: "USER_INPUT", content: $c}'; }
reply() { jq -nc --arg c "$1" '{type: "PLANNER_RESPONSE", content: $c}'; }
reply_ask() {
  jq -nc --arg c "$1" '{type: "PLANNER_RESPONSE", content: $c, tool_calls: [{name: "ask_question", args: {questions: [{question: "[Question 1 of 3] Which store?", options: ["Option A: sqlite", "Option B: postgres"]}]}}]}'
}

# run_hook <name> <expect: continue|silent> [extra payload jq filter] < transcript
run_hook() {
  local name="$1" expect="$2" extra="${3:-.}" file="$tmp/$1.jsonl" out
  cat > "$file"
  out="$(jq -nc --arg p "$file" '{terminationReason: "NO_TOOL_CALL", transcriptPath: $p}' \
    | jq -c "$extra" | bash "$hook")"
  local got=silent
  [ "$(printf '%s' "$out" | jq -r '.decision // ""')" = "continue" ] && got=continue
  if [ "$got" = "$expect" ]; then
    echo ok >> "$tmp/pass"; echo "PASS $name"
  else
    echo x >> "$tmp/fail"; echo "FAIL $name: expected $expect, got $got ($out)"
  fi
}

# run_checker <name> <expected failed count> < transcript
run_checker() {
  local name="checker-$1" want="$2" file="$tmp/checker-$1.jsonl" out got
  cat > "$file"
  out="$(bash "$checker" --format antigravity "$file" 2>&1)"
  got="$(printf '%s\n' "$out" | rg -o 'failed=[0-9]+' | tail -1)"
  if [ "$got" = "failed=$want" ]; then
    echo ok >> "$tmp/pass"; echo "PASS $name"
  else
    echo x >> "$tmp/fail"; echo "FAIL $name: expected failed=$want, got ${got:-none}"; printf '%s\n' "$out" | tail -5
  fi
}

Q1=$'Target resolved: the storage design.\n\n## Question 1 (of 3) — Storage\n\nWhich store?'
FAQ=$'Here is the FAQ.\n\n## Question 1 (of 5) — What is a derivative?\n\nA rate of change.'
SEP=$'## Question 1 — Derivatives\n\nA rate of change.'
FENCED=$'The format looks like this:\n\n```md\n## Question 2 (of 4) — Naming\n```\n\nThat is all.'
TABLE=$'### 1. Decision Table\n\n| # | Topic | Choice |\n|---|---|---|\n| 1 | Storage | A |'

# 1. clarify reply with a heading and no ask_question: must continue.
{ user "/clarify storage"; reply "$Q1"; } | run_hook 1-clarify-heading-no-tool continue
# 2. same reply with ask_question: silent.
{ user "/clarify storage"; reply_ask "$Q1"; } | run_hook 2-clarify-heading-with-tool silent
# 3. no clarify in the session, FAQ reply with the heading format: silent.
{ user "write me an interview FAQ"; reply "$FAQ"; } | run_hook 3-no-clarify-faq silent
# 4. clarify closed with the Decision Table, then an unrelated reply with a heading: silent.
{ user "/clarify storage"; reply_ask "$Q1"; user "A"; reply "$TABLE"; user "now an unrelated FAQ"; reply "$SEP"; } \
  | run_hook 4-after-decision-table silent
# 5. heading shown inside a fenced block in a clarify session: silent.
{ user "/clarify storage"; reply "$FENCED"; } | run_hook 5-fenced-heading silent
# 6. continuationActive: silent.
{ user "/clarify storage"; reply "$Q1"; } | run_hook 6-continuation-active silent '. + {continuationActive: true}'
# 7. a new /clarify after a closed one re-arms the hook.
{ user "/clarify a"; reply "$TABLE"; user "/clarify b"; reply "$Q1"; } | run_hook 7-rearmed-by-new-clarify continue
# 8. the separator heading form needs clarify context.
{ user "explain derivatives"; reply "$SEP"; } | run_hook 8-sep-form-no-clarify silent
# 9. a heading after a closed fence in the same reply still counts.
{ user "/clarify storage"; reply "$(printf '%s\n\n%s' "$FENCED" "$Q1")"; } | run_hook 9-heading-after-fence continue

# The offline checker must agree on the same cases.
{ user "write me an interview FAQ"; reply "$FAQ"; } | run_checker 3-no-clarify-faq 0
{ user "/clarify storage"; reply_ask "$Q1"; user "A"; reply "$TABLE"; user "unrelated"; reply "$SEP"; } \
  | run_checker 4-after-decision-table 0
{ user "/clarify storage"; reply "$FENCED"; } | run_checker 5-fenced-heading 0
{ user "/clarify storage"; reply "$Q1"; } | run_checker 1-clarify-heading-no-tool 1

# Counters live in files because each case runs in the consumer side of a pipe.
pass="$(cat "$tmp/pass" 2>/dev/null | wc -l)"
fail="$(cat "$tmp/fail" 2>/dev/null | wc -l)"
echo "passed=$((pass + 0)) failed=$((fail + 0))"
[ "$((fail + 0))" -eq 0 ]
