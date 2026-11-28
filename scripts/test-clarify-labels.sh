#!/usr/bin/env bash
# test-clarify-labels.sh - tests for plugins/clarify/hooks/clarify-labels.{sh,mjs} (issue #123):
# the printed `### Option X.` headings and the dialog labels of a clarify question must agree.
# Covers the Claude Code PreToolUse hook, the Antigravity PreToolUse hook and the offline
# checker in both formats.
#
# Requires: bash, jq, node. Exits non-zero when any case fails.

# shellcheck disable=SC2016  # jq programs are single-quoted on purpose
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
wrapper="$root/plugins/clarify/hooks/clarify-labels.sh"
mjs="$root/plugins/clarify/hooks/clarify-labels.mjs"
checker="$root/scripts/check-clarify-transcript.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 2; }

: > "$tmp/pass"; : > "$tmp/fail"
ok() { echo "PASS $1"; echo x >> "$tmp/pass"; }
bad() { echo "FAIL $1"; echo x >> "$tmp/fail"; }

# ---- fixtures -------------------------------------------------------------------------------
HAPPY_PROSE=$'## Question 3 (of 6) — The channel\n\n### Option A. Go (Recommended)\nx\n### Option B. Prepare, merge on your word\ny\n### Option C. Defer\nz\n\n> **Recommendation:** **Option A: Go** — because.'
# The prose was drafted with B as the recommended one; the dialog was relabelled to fit the rule.
RELABEL_PROSE=$'## Question 3 (of 6) — The channel\n\n### Option A. Go\nx\n### Option B. Prepare, merge on your word (Recommended)\ny\n### Option C. Defer\nz\n\n> **Recommendation:** **Option B: Prepare** — because.'
SWAP_PROSE=$'## Question 3 (of 7) — Listener\n\n### Option A. Shared core in a2a-lib.sh, plus a thin bin/a2a-agy-listen\nx\n### Option B. Standalone bin/a2a-agy-listen, forked from a2a-listen\ny\n### Option C. Reuse a2a-listen itself, behind an A2A_HARNESS=agy switch\nz\n\n> **Recommendation:** **Option A: Shared core** — because.'

claude_opts() { jq -nc --argjson l "$1" '[$l[] | {label: ., description: "d", preview: "p"}]'; }
Q='[Question 3 of 6] What do we do?'

# ---- Claude Code PreToolUse hook --------------------------------------------------------------
# run_claude <name> <expect deny|allow> <labels json array> [session]
run_claude() {
  local name="$1" expect="$2" labels="$3" sid="${4:-s-$1}" out got=allow
  if ! out="$(jq -nc --arg q "$Q" --arg s "$sid" --argjson o "$(claude_opts "$labels")" \
      '{session_id: $s, tool_name: "AskUserQuestion", tool_input: {questions: [{question: $q, options: $o}]}}' \
    | PLUGIN_DATA="$tmp" CLAUDE_PLUGIN_DATA="$tmp" bash "$wrapper" 2>/dev/null)"; then bad "$name: exit"; return; fi
  [ "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null)" = deny ] && got=deny
  if [ "$got" = "$expect" ]; then ok "$name"; else bad "$name: expected $expect, got $got ($out)"; fi
}
run_claude claude-happy allow '["Option A: Go (Recommended)","Option B: Prepare","Option C: Defer"]'
run_claude claude-recommended-on-b deny '["Option A: Go","Option B: Prepare (Recommended)","Option C: Defer"]'
run_claude claude-b-first-label deny '["Option B-first: Prepare (Recommended)","Option B: Go","Option C: Defer"]'
run_claude claude-no-prefix deny '["Prepare (Recommended)","Go"]'
run_claude claude-letters-out-of-order deny '["Option A: Go (Recommended)","Option C: Defer","Option B: Prepare"]'
run_claude claude-two-recommended deny '["Option A: Go (Recommended)","Option B: Prepare (Recommended)"]'
run_claude claude-no-recommended-marker allow '["Option A: Go","Option B: Prepare"]'
# Budget: two denials per question number and session, then the call passes (cannot loop).
run_claude claude-budget-1 deny '["Option A: Go","Option B: Prepare (Recommended)"]' s-budget
run_claude claude-budget-2 deny '["Option A: Go","Option B: Prepare (Recommended)"]' s-budget
run_claude claude-budget-3 allow '["Option A: Go","Option B: Prepare (Recommended)"]' s-budget
# Questions that are not clarify questions, and bad input, pass untouched.
out="$(jq -nc '{session_id: "s-x", tool_input: {questions: [{question: "Which store?", options: [{label: "sqlite"}, {label: "postgres"}]}]}}' | PLUGIN_DATA="$tmp" bash "$wrapper" 2>/dev/null)"
if [ -z "$out" ]; then ok claude-not-a-clarify-question; else bad "claude-not-a-clarify-question: $out"; fi
if out="$(printf 'not json' | PLUGIN_DATA="$tmp" bash "$wrapper" 2>/dev/null)" && [ -z "$out" ]; then ok claude-malformed-fails-open; else bad claude-malformed-fails-open; fi
if out="$(printf '' | PLUGIN_DATA="$tmp" bash "$wrapper" 2>/dev/null)" && [ -z "$out" ]; then ok claude-empty-fails-open; else bad claude-empty-fails-open; fi
# The message tells the model what to do: fix, match the headings, reprint, not only the dialog.
out="$(jq -nc --arg q "$Q" --argjson o "$(claude_opts '["Option A: Go","Option B: Prepare (Recommended)"]')" '{session_id: "s-msg", tool_input: {questions: [{question: $q, options: $o}]}}' | PLUGIN_DATA="$tmp" bash "$wrapper")"
if printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecisionReason | (test("Question 3") and test("recommended one") and test("letter for letter") and test("reprint") and test("never relabel only in the dialog"))' >/dev/null 2>&1 \
   && ! printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason' | rg -q 'identical'; then
  ok claude-message-content; else bad claude-message-content; fi

# ---- Antigravity PreToolUse hook --------------------------------------------------------------
user_in() { jq -nc --arg c "$1" '{type: "USER_INPUT", content: $c}'; }
planner() { jq -nc --arg c "$1" '{type: "PLANNER_RESPONSE", content: $c}'; }
answer_ev() { jq -nc --arg c "$1" '{type: "GENERIC", content: ("Created At: x\nA1: " + $c)}'; }
ag_opts() { jq -nc --argjson l "$1" '$l'; }
# run_agy <name> <expect deny|allow> <labels json array> <prose> [conversation]
run_agy() {
  local name="$1" expect="$2" labels="$3" prose="$4" cid="${5:-c-$1}" out got=allow
  { user_in "/clarify storage"; planner "$prose"; } > "$tmp/$name.jsonl"
  if ! out="$(jq -nc --arg q "$Q" --arg c "$cid" --arg p "$tmp/$name.jsonl" --argjson o "$(ag_opts "$labels")" \
      '{conversationId: $c, transcriptPath: $p, toolCall: {name: "ask_question", id: "tc1", args: {questions: [{question: $q, options: $o}]}}}' \
    | PLUGIN_DATA="$tmp" node "$mjs" agy-pre 2>/dev/null)"; then bad "$name: exit"; return; fi
  [ "$(printf '%s' "$out" | jq -r '.decision // ""' 2>/dev/null)" = deny ] && got=deny
  # Antigravity treats `{}` from a PreToolUse hook as a denial: the pass-through must be empty stdout.
  if [ "$expect" = allow ] && [ -n "$out" ]; then bad "$name: pass-through must be empty stdout, got $out"; return; fi
  if [ "$got" = "$expect" ]; then ok "$name"; else bad "$name: expected $expect, got $got ($out)"; fi
}
run_agy agy-happy allow '["(Recommended) Option A: Go","Option B: Prepare, merge on your word","Option C: Defer"]' "$HAPPY_PROSE"
# The reported relabel: prose A=Go, B=Prepare (Recommended); dialog patched to A=Prepare (Recommended), B=Go.
run_agy agy-relabel deny '["(Recommended) Option A: Prepare, merge on your word","Option B: Go","Option C: Defer"]' "$RELABEL_PROSE"
# The first report: prose A=shared core, B=standalone; dialog A=standalone (Recommended), B=shared core.
run_agy agy-swapped-meaning deny '["(Recommended) Option A: Standalone bin/a2a-agy-listen forked from a2a-listen","Option B: Shared loop in a2a-lib.sh plus thin wrappers","Option C: Reuse a2a-listen behind an A2A_HARNESS=agy switch"]' "$SWAP_PROSE"
# The prose recommends B and the dialog follows it: consistent, but the recommended option is not A.
run_agy agy-prose-recommends-b deny '["Option A: Go","(Recommended) Option B: Prepare, merge on your word","Option C: Defer"]' "$RELABEL_PROSE"
# A reprinted step supersedes the first one: the last heading for a letter wins.
REPRINT=$'## Question 3 (of 6) — The channel\n### Option A. Go\n### Option B. Prepare, merge on your word (Recommended)\n\nCorrection: reprinting the step.\n\n## Question 3 (of 6) — The channel\n### Option A. Prepare, merge on your word (Recommended)\n### Option B. Go\n### Option C. Defer\n> **Recommendation:** **Option A: Prepare** — because.'
run_agy agy-reprint-fixes-it allow '["(Recommended) Option A: Prepare, merge on your word","Option B: Go","Option C: Defer"]' "$REPRINT"
# An earlier question's headings in the same window do not leak into this one.
EARLIER=$'## Question 2 (of 6) — Other\n### Option A. Alpha\n### Option B. Beta (Recommended)\n\n'"$HAPPY_PROSE"
run_agy agy-earlier-question-ignored allow '["(Recommended) Option A: Go","Option B: Prepare, merge on your word","Option C: Defer"]' "$EARLIER"
# No printed headings (nothing to compare) and the dialog rules hold: pass.
run_agy agy-no-prose-headings allow '["(Recommended) Option A: Go","Option B: Prepare"]' "just some text"
run_agy agy-dialog-recommended-on-b deny '["Option A: Go","(Recommended) Option B: Prepare"]' "just some text"
# Budget and fail-open.
run_agy agy-budget-1 deny '["(Recommended) Option A: Prepare, merge on your word","Option B: Go","Option C: Defer"]' "$RELABEL_PROSE" c-budget
run_agy agy-budget-2 deny '["(Recommended) Option A: Prepare, merge on your word","Option B: Go","Option C: Defer"]' "$RELABEL_PROSE" c-budget
run_agy agy-budget-3 allow '["(Recommended) Option A: Prepare, merge on your word","Option B: Go","Option C: Defer"]' "$RELABEL_PROSE" c-budget
if out="$(jq -nc '{conversationId: "c", transcriptPath: "/nonexistent", toolCall: {args: {questions: [{question: "[Question 3 of 6] x", options: ["(Recommended) Option A: a", "Option B: b"]}]}}}' | PLUGIN_DATA="$tmp" node "$mjs" agy-pre 2>/dev/null)" && [ -z "$out" ]; then ok agy-missing-transcript-fails-open; else bad "agy-missing-transcript-fails-open: $out"; fi
if out="$(printf 'not json' | PLUGIN_DATA="$tmp" node "$mjs" agy-pre 2>/dev/null)" && [ -z "$out" ]; then ok agy-malformed-fails-open; else bad agy-malformed-fails-open; fi

# ---- offline checker (transcripts) --------------------------------------------------------------
D="Pros and cons of this option in two sentences, long enough to pass the description length floor of the checker, which is 120 characters."
cuser() { jq -nc '{type: "user", message: {role: "user", content: "go"}}'; }
ctext() { jq -nc --arg c "$1" '{type: "assistant", message: {role: "assistant", content: [{type: "text", text: $c}]}}'; }
cask() { jq -nc --arg d "$D" --argjson l "$1" --arg id "$2" '{type: "assistant", message: {role: "assistant", content: [{type: "tool_use", id: $id, name: "AskUserQuestion", input: {questions: [{question: "[Question 3 of 6] What do we do?", header: "Fork 3/6", multiSelect: false, options: [$l[] | {label: ., description: $d, preview: "x\n→ next: full Question 4 write-up, then ask"}]}]}}]}}'; }
cres() { jq -nc --arg id "$1" --arg c "$2" '{type: "user", message: {role: "user", content: [{type: "tool_result", tool_use_id: $id, content: $c}]}}'; }
LA='["Option A: Go (Recommended)","Option B: Prepare, merge on your word","Option C: Defer"]'
LB='["Option A: Prepare, merge on your word (Recommended)","Option B: Go","Option C: Defer"]'
summary_of() { bash "$checker" "$@" 2>&1 | tail -1; }
expect_summary() { # <name> <expected summary> <checker args...>
  local name="$1" want="$2" got; shift 2
  got="$(summary_of "$@")"
  if [ "$got" = "$want" ]; then ok "$name"; else bad "$name: expected '$want', got '$got'"; fi
}
{ cuser; ctext "$HAPPY_PROSE"; cask "$LA" a; cres a answered; } > "$tmp/c-happy.jsonl"
expect_summary checker-claude-happy 'checked=1 failed=0 warned=0 denied=0' "$tmp/c-happy.jsonl"
{ cuser; ctext "$RELABEL_PROSE"; cask "$LB" a; cres a answered; } > "$tmp/c-relabel.jsonl"
expect_summary checker-claude-relabel 'checked=1 failed=1 warned=0 denied=0' "$tmp/c-relabel.jsonl"
relabel_out="$(bash "$checker" "$tmp/c-relabel.jsonl" 2>&1)"
if printf '%s' "$relabel_out" | rg -q 'option labels:.*recommends Option B'; then ok checker-claude-relabel-message; else bad checker-claude-relabel-message; fi
# A call the label hook denied is not judged; the retry with a reprinted step is.
{ cuser; ctext "$RELABEL_PROSE"; cask "$LB" a; cres a 'PreToolUse:AskUserQuestion hook error: clarify: the option labels of Question 3 need fixing'; ctext "$REPRINT"; cask "$LB" b; cres b answered; } > "$tmp/c-denied.jsonl"
expect_summary checker-claude-denied-then-reprint 'checked=1 failed=0 warned=0 denied=1' "$tmp/c-denied.jsonl"
ag_ask() { jq -nc --argjson l "$1" --arg c "$2" '{type: "PLANNER_RESPONSE", content: $c, tool_calls: [{name: "ask_question", args: {questions: [{question: "[Question 3 of 6] What do we do?", options: $l}]}}]}'; }
{ user_in "/clarify storage"; ag_ask '["(Recommended) Option A: Go","Option B: Prepare, merge on your word","Option C: Defer"]' "$HAPPY_PROSE"; answer_ev "Go"; } > "$tmp/a-happy.jsonl"
expect_summary checker-agy-happy 'checked=1 failed=0 warned=0' --format antigravity "$tmp/a-happy.jsonl"
{ user_in "/clarify storage"; ag_ask '["(Recommended) Option A: Prepare, merge on your word","Option B: Go","Option C: Defer"]' "$RELABEL_PROSE"; answer_ev "Go"; } > "$tmp/a-relabel.jsonl"
expect_summary checker-agy-relabel 'checked=1 failed=1 warned=0' --format antigravity "$tmp/a-relabel.jsonl"

pass=$(wc -l < "$tmp/pass"); fail=$(wc -l < "$tmp/fail")
echo "passed=$((pass)) failed=$((fail))"
[ "$((fail))" -eq 0 ]
