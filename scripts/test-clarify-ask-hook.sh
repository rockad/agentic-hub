#!/usr/bin/env bash
# test-clarify-ask-hook.sh - regression tests for plugins/clarify/hooks/clarify-ask-check.sh
# (the Claude Code PreToolUse hook, issue #97).
#
# Requires: bash, jq. Exits non-zero when any case fails.

# shellcheck disable=SC2016  # jq programs are single-quoted on purpose
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
hook="$root/plugins/clarify/hooks/clarify-ask-check.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }

# Counters live in files: run() sits on the consumer side of a pipe, so variables would be lost.
: > "$tmp/pass"; : > "$tmp/fail"
ok() { echo "PASS $1"; echo x >> "$tmp/pass"; }
bad() { echo "FAIL $1"; echo x >> "$tmp/fail"; }

# A real prompt carries a uuid; the same text means the same prompt (a retry), other text a new one.
user() { jq -nc --arg c "${1:-go}" '{type: "user", uuid: ("u-" + $c), message: {role: "user", content: $c}}'; }
result() { jq -nc '{type: "user", message: {role: "user", content: [{type: "tool_result", tool_use_id: "t1", content: "ok"}]}}'; }
text() { jq -nc --arg c "$1" '{type: "assistant", message: {role: "assistant", content: [{type: "text", text: $c}]}}'; }
ask() { jq -nc --arg q "$1" '{type: "assistant", message: {role: "assistant", content: [{type: "tool_use", name: "AskUserQuestion", input: {questions: [{question: $q, header: "Fork 3/8"}]}}]}}'; }

# run <name> <expect: deny|allow> <question text> [session id] < transcript
run() {
  local name="$1" expect="$2" q="$3" sid="${4:-s-$1}" file="$tmp/$1.jsonl" out got=allow
  cat > "$file"
  if ! out="$(jq -nc --arg p "$file" --arg q "$q" --arg s "$sid" \
      '{session_id: $s, transcript_path: $p, tool_name: "AskUserQuestion", tool_input: {questions: [{question: $q}]}}' \
      | CLARIFY_HOOK_STRICT=1 TMPDIR="$tmp" bash "$hook" 2>/dev/null)"; then
    bad "$name: hook exited non-zero"; return
  fi
  [ "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null)" = deny ] && got=deny
  if [ "$got" = "$expect" ]; then ok "$name"; else bad "$name: expected $expect, got $got"; fi
}

# silent <name> <payload>: the hook prints nothing and exits 0.
silent() {
  if out="$(printf '%s' "$2" | CLARIFY_HOOK_STRICT=1 bash "$hook" 2>/dev/null)" && [ -z "$out" ]; then ok "$1"; else bad "$1"; fi
}

Q3='[Question 3 of 8] Which store?'

{ user; text '## Question 3 (of 8) — The store
Context.'; ask "$Q3"; } | run heading-present allow "$Q3"
{ user; ask "$Q3"; } | run no-prose-after-prompt deny "$Q3"
{ user; text 'Noted: Option A.'; ask "$Q3"; } | run noted-line-only deny "$Q3"
{ user; text '## Question 3 (of 8) — x'; result; ask "$Q3"; } | run heading-before-tool-result deny "$Q3"
{ user; result; text '## Question 3 (of 8) — x'; text 'more'; ask "$Q3"; } | run heading-in-earlier-block allow "$Q3"
{ user; text '## Question 31 (of 40) — other fork'; ask "$Q3"; } | run question-31-is-not-3 deny "$Q3"
{ user; text '## Question 3 — dash form'; ask "$Q3"; } | run dash-form-heading allow "$Q3"
{ user; ask 'Which store should we use?'; } | run not-a-clarify-question allow 'Which store should we use?'
{ user; ask '[Fork 3 of 8] Which store?'; } | run fork-prefix-checked deny '[Fork 3 of 8] Which store?'
{ ask "$Q3"; } | run no-user-entry-in-window allow "$Q3"
printf '' | run empty-transcript allow "$Q3"
printf 'not json\n' | run garbage-transcript allow "$Q3"

# Once per question number and session: the retry passes, so a lagging transcript cannot loop.
{ user; ask "$Q3"; } | run retry-first deny "$Q3" s-retry
{ user; ask "$Q3"; } | run retry-second allow "$Q3" s-retry
{ user; ask '[Question 4 of 8] Next?'; } | run retry-other-number deny '[Question 4 of 8] Next?' s-retry
{ user; ask "$Q3"; } | run other-session-denied-again deny "$Q3" s-other

# A session runs many series (review finding on #98): the same question number missing its
# write-up in a later prompt is denied again, while a retry inside that prompt still passes.
{ user "series one"; ask "$Q3"; } | run two-series-first deny "$Q3" s-long
{ user "series one"; ask "$Q3"; } | run two-series-first-retry allow "$Q3" s-long
{ user "series two"; ask "$Q3"; } | run two-series-second deny "$Q3" s-long
{ user "series two"; ask "$Q3"; } | run two-series-second-retry allow "$Q3" s-long
# A tool result is not a new prompt: an answer then a missing write-up keeps the same chain.
{ user "series three"; result; ask "$Q3"; } | run chain-first deny "$Q3" s-chain
{ user "series three"; result; result; ask "$Q3"; } | run chain-retry-after-tool allow "$Q3" s-chain
# A meta entry (hook or skill injection) is not a prompt either.
{ user "series four"; jq -nc '{type: "user", isMeta: true, uuid: "meta-1", message: {role: "user", content: "injected"}}'; ask "$Q3"; } \
  | run meta-entry-first deny "$Q3" s-meta
{ user "series four"; jq -nc '{type: "user", isMeta: true, uuid: "meta-2", message: {role: "user", content: "injected again"}}'; ask "$Q3"; } \
  | run meta-entry-retry allow "$Q3" s-meta

# Other heading levels count: ### Question N is a write-up too.
{ user "h3"; text '### Question 3 (of 8) — The store'; ask "$Q3"; } | run h3-heading allow "$Q3"

# Transcript lag (found in a live run: every fork that did have its write-up was denied once,
# because the text printed in the same turn was not in the transcript yet). With the payload's
# tool_use_id the hook judges only once the transcript holds this call's tool_use entry.
tu_ask() { jq -nc --arg q "$2" --arg id "$1" '{type: "assistant", message: {role: "assistant", content: [{type: "tool_use", id: $id, name: "AskUserQuestion", input: {questions: [{question: $q}]}}]}}'; }
# run_id <name> <expect> <tool_use_id> <polls> <nap> [late-append-file] < transcript
run_id() {
  local name="$1" expect="$2" id="$3" file="$tmp/$1.jsonl" out got=allow
  cat > "$file"
  [ -n "${6:-}" ] && { (sleep 0.4; cat "$6" >> "$file") & }
  out="$(jq -nc --arg p "$file" --arg q "$Q3" --arg i "$id" --arg s "s-$name" \
      '{session_id: $s, transcript_path: $p, tool_use_id: $i, tool_input: {questions: [{question: $q}]}}' \
    | CLARIFY_HOOK_STRICT=1 CLARIFY_ASK_POLLS="$4" CLARIFY_ASK_NAP="$5" TMPDIR="$tmp" bash "$hook" 2>/dev/null)" || { bad "$name: hook exited non-zero"; return; }
  wait
  [ "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null)" = deny ] && got=deny
  if [ "$got" = "$expect" ]; then ok "$name"; else bad "$name: expected $expect, got $got"; fi
}
# Caught up (the call's tool_use is in the transcript) and no write-up: a real miss.
{ user "lag a"; tu_ask tu-1 "$Q3"; } | run_id lag-caught-up-miss deny tu-1 3 0.05
# Caught up with the write-up: fine.
{ user "lag b"; text '## Question 3 (of 8) — x'; tu_ask tu-2 "$Q3"; } | run_id lag-caught-up-present allow tu-2 3 0.05
# Not caught up (the text and the tool_use are not written yet): unknown, so fail open.
{ user "lag c"; } | run_id lag-not-caught-up allow tu-3 3 0.05
# The tool_use lands 0.4s late and the write-up is missing: the hook waits, then denies.
{ user "lag d"; } > "$tmp/late-d.add"; tu_ask tu-4 "$Q3" > "$tmp/late-d.add"
{ user "lag d"; } | run_id lag-late-flush-miss deny tu-4 8 0.1 "$tmp/late-d.add"
# The tool_use lands late and the write-up is there: allowed.
{ text '## Question 3 (of 8) — x'; tu_ask tu-5 "$Q3"; } > "$tmp/late-e.add"
{ user "lag e"; } | run_id lag-late-flush-present allow tu-5 8 0.1 "$tmp/late-e.add"

# Missing transcript path and an empty payload fail open.
silent no-transcript-path '{"tool_input":{"questions":[{"question":"[Question 3 of 8] x"}]}}'
silent empty-payload ''

# The deny reply is valid hook JSON and names the question.
{ user; ask "$Q3"; } > "$tmp/shape.jsonl"
out="$(jq -nc --arg p "$tmp/shape.jsonl" --arg q "$Q3" '{session_id: "s-shape", transcript_path: $p, tool_input: {questions: [{question: $q}]}}' | TMPDIR="$tmp" bash "$hook")"
if printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "PreToolUse" and (.hookSpecificOutput.permissionDecisionReason | test("Question 3"))' >/dev/null 2>&1; then
  ok deny-shape; else bad deny-shape; fi

# The offline checker (Claude mode) reports a hook-denied call as DENIED, not as a result, and
# the retry after it counts the write-up printed before the denied attempt.
checker="$root/scripts/check-clarify-transcript.sh"
D="Pros and cons of this option in two sentences, long enough to pass the description length floor of the checker, which is 120 characters."
qcall() { jq -nc --arg id "$1" --arg d "$D" '{type: "assistant", message: {role: "assistant", content: [{type: "tool_use", id: $id, name: "AskUserQuestion", input: {questions: [{question: "[Question 3 of 8] Which store?", header: "Fork 3/8", multiSelect: false, options: [{label: "Option A: sqlite", description: $d, preview: "x\n→ next: full Question 4 write-up, then ask"}]}]}}]}}'; }
denial() { jq -nc --arg id "$1" '{type: "user", message: {role: "user", content: [{type: "tool_result", tool_use_id: $id, content: "PreToolUse:AskUserQuestion hook error: clarify: Question 3 has no write-up before it."}]}}'; }
answered() { jq -nc --arg id "$1" '{type: "user", message: {role: "user", content: [{type: "tool_result", tool_use_id: $id, content: "Your questions have been answered"}]}}'; }
summary() { bash "$checker" --format claude "$1" 2>&1 | tail -1; }
want() { if [ "$(summary "$tmp/$1.jsonl")" = "$2" ]; then ok "$1"; else bad "$1: expected '$2', got '$(summary "$tmp/$1.jsonl")'"; fi; }
{ user; text '## Question 3 (of 8) — x'; qcall a; denial a; qcall b; answered b; } > "$tmp/checker-denied-lag.jsonl"
want checker-denied-lag 'checked=1 failed=0 warned=0 denied=1'
{ user; qcall a; denial a; text '## Question 3 (of 8) — x'; qcall b; answered b; } > "$tmp/checker-denied-real.jsonl"
want checker-denied-real 'checked=1 failed=0 warned=0 denied=1'
{ user; qcall a; answered a; } > "$tmp/checker-no-prose.jsonl"
want checker-no-prose 'checked=1 failed=1 warned=0 denied=0'
{ user; text '## Question 3 (of 8) — x'; qcall a; answered a; } > "$tmp/checker-plain-pass.jsonl"
want checker-plain-pass 'checked=1 failed=0 warned=0 denied=0'

pass=$(wc -l < "$tmp/pass" 2>/dev/null || echo 0)
fail=$(wc -l < "$tmp/fail" 2>/dev/null || echo 0)
echo "passed=$((pass)) failed=$((fail))"
[ "$((fail))" -eq 0 ]
