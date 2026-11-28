#!/usr/bin/env bash
# test-clarify-stop-hook.sh - regression tests for plugins/clarify/hooks/clarify-stop-check.sh
# and the matching Antigravity mode of scripts/check-clarify-transcript.sh.
#
# Requires: bash, jq, grep. Exits non-zero when any case fails.

# shellcheck disable=SC2016  # jq programs and literal backticks are single-quoted on purpose
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
hook="$root/plugins/clarify/hooks/clarify-stop-check.sh"
checker="$root/scripts/check-clarify-transcript.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }

user() { jq -nc --arg c "$1" '{type: "USER_INPUT", content: $c}'; }
reply() { jq -nc --arg c "$1" '{type: "PLANNER_RESPONSE", content: $c}'; }
# reply_ask <content> [tag]: a reply that calls ask_question with a [Question N of M] tag.
reply_ask() {
  local tag="${2:-Question 1 of 3}"
  jq -nc --arg c "$1" --arg t "[$tag] Which store?" '{type: "PLANNER_RESPONSE", content: $c, tool_calls: [{name: "ask_question", args: {questions: [{question: $t, options: ["Option A: sqlite", "Option B: postgres"]}]}}]}'
}

record() { # record <ok|x> <message>; counters live in files because cases run on the consumer side of a pipe
  echo "$1" >> "$tmp/$([ "$1" = ok ] && echo pass || echo fail)"
  echo "$2"
}

# run_hook <name> <expect: continue|silent> [extra payload jq filter] < transcript
run_hook() {
  local name="$1" expect="$2" extra="${3:-.}" file="$tmp/$1.jsonl" out got=silent rc
  cat > "$file"
  # CLARIFY_HOOK_STRICT makes a broken jq program exit 3 instead of failing open, so a
  # "silent" expectation cannot pass just because the hook crashed.
  out="$(jq -nc --arg p "$file" '{terminationReason: "NO_TOOL_CALL", transcriptPath: $p}' \
    | jq -c "$extra" | CLARIFY_HOOK_STRICT=1 bash "$hook" 2>/dev/null)"
  rc=$?
  if [ "$(printf '%s' "$out" | jq -r '.decision // ""')" = "continue" ]; then got="continue"; fi
  if [ "$rc" -eq 0 ] && [ "$got" = "$expect" ]; then record ok "PASS $name"
  else record x "FAIL $name: expected $expect, got $got (exit $rc, $out)"; fi
}

# run_checker <name> <expected failed count> [expected warned count] < transcript
run_checker() {
  local name="checker-$1" want="failed=$2${3:+ warned=$3}" file="$tmp/checker-$1.jsonl" out got
  cat > "$file"
  out="$(bash "$checker" --format antigravity "$file" 2>&1)"
  got="$(printf '%s\n' "$out" | grep -o "failed=[0-9]*${3:+ warned=[0-9]*}" | tail -1)"
  if [ "$got" = "$want" ]; then record ok "PASS $name"
  else record x "FAIL $name: expected $want, got ${got:-none}"; printf '%s\n' "$out" | tail -5; fi
}

Q1=$'Target resolved: the storage design.\n\n## Question 1 (of 3) — Storage\n\nWhich store?'
Q2=$'## Question 2 (of 3) — Indexing\n\nWhich index?'
Q1BARE=$'## Question 1 (of 3) — Storage\n\nWhich store?'
FAQ=$'Here is the FAQ.\n\n## Question 1 (of 5) — What is a derivative?\n\nA rate of change.'
SEP=$'## Question 1 — Derivatives\n\nA rate of change.'
FENCED=$'The format looks like this:\n\n```md\n## Question 2 (of 4) — Naming\n```\n\nThat is all.'
TABLE=$'### 1. Decision Table\n\n| # | Topic | Choice |\n|---|---|---|\n| 1 | Storage | A |'
RECAP=$'## Decision Table (so far)\n\n| # | Topic | Choice |\n|---|---|---|\n| 1 | Storage | A |'
BT='```'
NESTED=$'````md\n```md\n## Question 2 (of 4) — Naming\n```\n````'

# A finished series: the last question was 3 of 3, answered, then the table.
Q3=$'Target resolved: the storage design.\n\n## Question 3 (of 3) — Rollout\n\nWhich rollout?'
finished() { user "/clarify storage"; reply_ask "$Q3" "Question 3 of 3"; user "C"; }

# 1. heading with no ask_question in a clarify session: must continue.
{ user "/clarify storage"; reply "$Q1"; } | run_hook 1-clarify-heading-no-tool continue
# 2. same reply with ask_question: silent.
{ user "/clarify storage"; reply_ask "$Q1"; } | run_hook 2-clarify-heading-with-tool silent
# 3. no clarify in the session, FAQ reply with the heading format: silent.
{ user "write me an interview FAQ"; reply "$FAQ"; } | run_hook 3-no-clarify-faq silent
# 4. series finished with its Decision Table, then an unrelated heading: silent.
{ finished; reply "$TABLE"; user "now an unrelated FAQ"; reply "$SEP"; } | run_hook 4-after-decision-table silent
# 5. heading shown inside a fenced block in a clarify session: silent.
{ user "/clarify storage"; reply "$FENCED"; } | run_hook 5-fenced-heading silent
# 6. continuationActive: silent.
{ user "/clarify storage"; reply "$Q1"; } | run_hook 6-continuation-active silent '. + {continuationActive: true}'
# 7. a new /clarify after a finished one re-arms the hook.
{ finished; reply "$TABLE"; user "/clarify b"; reply "$Q1"; } | run_hook 7-rearmed-by-new-clarify continue
# 8. the separator heading form needs clarify context.
{ user "explain derivatives"; reply "$SEP"; } | run_hook 8-sep-form-no-clarify silent
# 9. a heading after a closed fence in the same reply still counts.
{ user "/clarify storage"; reply "$(printf '%s\n\n%s' "$FENCED" "$Q1")"; } | run_hook 9-heading-after-fence continue
# 10. a session started only by the Target resolved line (no command in the transcript).
{ user "walk me through the options"; reply "$Q1"; } | run_hook 10-target-resolved-only continue
# 11. a second question after a free-text answer.
{ user "/clarify storage"; reply_ask "$Q1"; user "A"; reply "$Q2"; } | run_hook 11-second-question-after-answer continue
# 12. a Decision Table recap mid-series must not end the session.
{ user "/clarify storage"; reply_ask "$Q1"; user "show the table so far"; reply "$RECAP"; user "ok, continue"; reply "$Q2"; } \
  | run_hook 12-mid-series-decision-table continue
# 13. command match is case-insensitive.
{ user "/Clarify storage"; reply "$Q1BARE"; } | run_hook 13-command-case-insensitive continue
# 14. a tagged ask_question arms the session even with no command and no target line.
{ user "interview me about storage"; reply_ask "$Q1BARE"; user "A"; reply "$Q2"; } | run_hook 14-tagged-ask-arms-session continue
# 15. the fork-map line arms the session.
{ user "interview me about storage"; reply $'Identified 3 orthogonal forks across storage.\n\n## Question 1 (of 3) — Storage'; } \
  | run_hook 15-fork-map-arms-session continue
# 16. closing-heading wordings all end the series.
n=0
for h in '## Decision table' '**Decision Table**' '## Final Decision Table' '## 1) Decision Table' '#### 1. Decision Table (Mode B, Plain English / ELI5)'; do
  n=$((n + 1))
  { finished; reply "$h"; user "unrelated"; reply "$SEP"; } | run_hook "16.$n-closing-wording" silent
done
# 17. a 4-backtick fence around a 3-backtick example hides the heading.
{ user "/clarify storage"; reply "$NESTED"; } \
  | run_hook 17-nested-fence silent
# 18. an inline span at line start is not a fence, so a real heading after it counts.
{ user "/clarify storage"; reply "$(printf '%sjs const x = 1 %s\n\n%s' "$BT" "$BT" "$Q1")"; } | run_hook 18-inline-span-not-fence continue
# 19. a line indented 4+ spaces is not a fence.
{ user "/clarify storage"; reply "$(printf '    %s\n\n%s' "$BT" "$Q1")"; } | run_hook 19-indented-not-fence continue
# 20. ~~~ does not close a backtick fence.
{ user "/clarify storage"; reply "$(printf '%s\n~~~\n## Question 2 (of 4) — Naming\n%s' "$BT" "$BT")"; } | run_hook 20-tilde-does-not-close-backtick silent

# 21. a series that ends before the last fork still closes: retired fork, then early stop.
Q4OF5=$'## Question 4 (of 5) — Rollout\n\nWhich rollout?'
REV=$'Fork map revised: 5 → 4 (retired the rollout fork).\n\n### 1. Decision Table\n\n| # | Topic |\n|---|---|\n| 1 | Storage |'
{ user "/clarify x"; reply_ask "$Q4OF5" "Question 4 of 5"; user "B, retire fork 5"; reply "$REV"; user "unrelated FAQ"; reply "$FAQ"; } \
  | run_hook 21a-retired-fork-closes silent
EARLY=$'### 1. Decision Table\n\n| # | Topic |\n|---|---|\n| 1 | Storage |\n\n### 2. Final Architecture Artifact\n\nThe design.\n\n### 4. Gated Execution Transition\n\nGo?'
{ user "/clarify x"; reply_ask "$Q1BARE" "Question 2 of 5"; user "enough, give me the table"; reply "$EARLY"; user "unrelated FAQ"; reply "$FAQ"; } \
  | run_hook 21b-early-stop-closes silent
# 22. CRLF replies: a heading after a closed fence still counts.
{ user "/clarify x"; reply "$(printf 'Example:\r\n\r\n%smd\r\n## Question 9 (of 9) — x\r\n%s\r\n\r\n## Question 1 (of 3) — Storage\r\n' "$BT" "$BT")"; } \
  | run_hook 22-crlf-heading-after-fence continue
# 23. more command and closing wordings.
{ user "run (/clarify) on storage"; reply "$Q1BARE"; } | run_hook 23a-paren-command continue
{ user 'run `/clarify` on storage'; reply "$Q1BARE"; } | run_hook 23b-backtick-command continue
for h in '## 📋 Decision Table' '## 1 · Decision Table' '> ### 1. Decision Table' '## Decisions Table'; do
  n=$((n + 1))
  { finished; reply "$h"; user "unrelated"; reply "$SEP"; } | run_hook "23.$n-closing-wording" silent
done
# 24. tag and heading disagree on M: the larger M wins, so a recap does not close early.
{ user "/clarify x"; reply_ask $'## Question 3 (of 4) — Naming\n\nWhich name?' "Question 3 of 3"; user "A"; reply "$RECAP"; user "go on"; reply $'## Question 4 (of 4) — Rollout'; } \
  | run_hook 24-tag-heading-m-disagree continue
# 25. positive controls for the "silent" cases: the same transcripts minus the guard must continue.
{ user "write me an interview FAQ"; reply "$FAQ"; user "/clarify x"; reply "$FAQ"; } | run_hook 25a-control-faq-in-clarify continue
{ user "/clarify storage"; reply "$(printf 'The format looks like this:\n\n## Question 2 (of 4) — Naming\n')"; } | run_hook 25b-control-unfenced-heading continue
# 25c. a mid-series recap that shows the table and the artifact (but not the gate) must not close.
RECAPFULL=$'### 1. Decision Table\n\n| # | Topic |\n|---|---|\n| 1 | Storage |\n\n### 2. Final Architecture Artifact\n\nThe design so far.'
{ user "/clarify x"; reply_ask $'## Question 2 (of 5) — Indexing' "Question 2 of 5"; user "show table and artifact so far"; reply "$RECAPFULL"; user "go"; reply $'## Question 3 (of 5) — Rollout'; } \
  | run_hook 25c-recap-with-artifact-not-closing continue
# 25d. a reply that calls ask_question never closes the session, even with a table in it.
{ user "/clarify x"; reply_ask "$(printf '%s\n\n%s' "$TABLE" "$Q3")" "Question 3 of 3"; user "A"; reply "$Q3"; } \
  | run_hook 25d-table-with-ask-not-closing continue
# 26. big replies stay fast in every shape (the hook has a 5 s timeout); armed session, worst case.
big() { # big <name> <jq expression producing one line per $i> <lines>
  { user "/clarify storage"; jq -nc --argjson n "$3" "{type: \"PLANNER_RESPONSE\", content: ([range(\$n) | . as \$i | $2] | join(\"\\n\"))}"; } > "$tmp/$1.jsonl"
  local start=$SECONDS rc
  jq -nc --arg p "$tmp/$1.jsonl" '{terminationReason: "NO_TOOL_CALL", transcriptPath: $p}' | CLARIFY_HOOK_STRICT=1 bash "$hook" >/dev/null
  rc=$?
  local took=$((SECONDS - start))
  if [ "$rc" -eq 0 ] && [ "$took" -lt 4 ]; then record ok "PASS 26-fast-$1 (${took}s)"
  else record x "FAIL 26-fast-$1: ${took}s, exit $rc"; fi
}
big plain '"line \($i)"' 40000
big hashes '"# line \($i)"' 40000
big bold '"**bold \($i)**"' 40000
big quotes '"> quote \($i)"' 40000
big fences '"```"' 40000
big decision '"# decision \($i) table"' 40000
big headings '"## Question \($i) (of 9) — x"' 20000

# 27. abandoned series (issue #82). An ask_question answer arrives as a GENERIC event
# ("A1: ..."), also a write-in; the hook's own earlier interventions arrive as SYSTEM_MESSAGE.
answer() { jq -nc --arg c "$1" '{type: "GENERIC", content: ("Created At: 2026-01-01T00:00:00Z\nCompleted At: 2026-01-01T00:00:01Z\nA1: " + $c)}'; }
block() { jq -nc '{type: "SYSTEM_MESSAGE", content: "<SYSTEM_MESSAGE>\nStop hook blocked termination: You emitted ## Question 1 prose without calling ask_question in this reply. Call ask_question now for Question 1 (with [Question 1 of 3] and matching Option A/B/C labels) before ending the turn.\n</SYSTEM_MESSAGE>"}'; }
reply_tool() { jq -nc --arg c "$1" '{type: "PLANNER_RESPONSE", content: $c, tool_calls: [{name: "read_file", args: {}}]}'; }
CANCEL="forget that. write me an interview FAQ with headings like ## Question 1 (of 5)"
Q2T="$Q2"
# E8 shape: clarify, one answered question, a cancel (as the write-in answer), then an FAQ.
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option A"; reply_ask "$Q2" "Question 2 of 3"; answer "$CANCEL"; reply "$FAQ"; } \
  | run_hook 27a-cancel-writein-then-faq silent
# The same cancel typed at the prompt (a USER_INPUT), wrapped the way Antigravity wraps it.
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option A"; reply_ask "$Q2" "Question 2 of 3"
  user $'<USER_REQUEST>\nNever mind, write me an FAQ.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe /clarify skill is loaded.\n</ADDITIONAL_METADATA>'; reply "$FAQ"; } \
  | run_hook 27b-cancel-user-input-then-faq silent
# Positive control: the same shape with an ordinary answer is a real stall and must continue.
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option A"; reply_ask "$Q2" "Question 2 of 3"; answer "Option B"; reply "$FAQ"; } \
  | run_hook 27c-control-no-cancel-faq continue
# A different slash command leaves the series.
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option A"; user "/jev status"; reply "$FAQ"; } \
  | run_hook 27d-other-slash-command-disarms silent
# Answers that merely contain a cancel word are still answers: an answered series that continues.
for a in "never mind the cost, go with A" "stop using Redis, use sqlite" "Option A, cancel the migration later" "/home/user/notes is the path"; do
  n=$((n + 1))
  { user "/clarify storage"; reply_ask "$Q1"; answer "$a"; reply "$Q2T"; } | run_hook "27e.$n-answer-not-cancel" continue
done
# A series that continues normally is unaffected, and a later stall in it is still caught.
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option A"; reply_ask "$Q2" "Question 2 of 3"; answer "Option B"; reply "$Q3"; } \
  | run_hook 27f-answered-series-continues-then-stalls continue
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option A"; reply_ask "$Q2" "Question 2 of 3"; answer "Option B"; reply_ask "$Q3" "Question 3 of 3"; } \
  | run_hook 27g-answered-series-continues-silent silent
# A tool result that happens to contain "A1: forget that" is not an answer to a question.
{ user "/clarify storage"; reply_tool "reading"; answer "$CANCEL"; reply "$Q1"; } | run_hook 27h-tool-result-not-an-answer continue
# A cancel disarms only the series before it: a new /clarify re-arms.
{ user "/clarify storage"; reply_ask "$Q1"; answer "$CANCEL"; reply "$FAQ"; user "/clarify again"; reply "$Q1"; } \
  | run_hook 27i-new-clarify-after-cancel continue
# Review fixes from #84 (issue #89).
# A step that calls ask_question together with another tool writes the other tool's result
# first. That result carries no answer line, so it must not consume the wait for the answer.
tool_result() { jq -nc '{type: "GENERIC", content: "Created At: 2026-01-01T00:00:00Z\nCompleted At: 2026-01-01T00:00:01Z\nfile contents"}'; }
# A multi-tool step followed by an ordinary answer is still a stall to catch. Without the
# answer gate the tool result eats the wait, the real answer is missed and the hook stays silent.
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option A"; reply_ask "$Q2" "Question 2 of 3"; tool_result; answer "Option B"; reply "$FAQ"; } \
  | run_hook 28b-multi-tool-step-control continue
# Esc on the picker returns an empty answer line: the series is abandoned.
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option A"; reply_ask "$Q2" "Question 2 of 3"; answer ""; reply "$FAQ"; } \
  | run_hook 28c-empty-answer-disarms silent
# A long user turn is middle-truncated in transcript.jsonl: the closing tag can be lost.
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option A"; reply_ask "$Q2" "Question 2 of 3"
  user $'<USER_REQUEST>\nNever mind, write me an FAQ.\n<truncated 5000 bytes>\nmore text'; reply "$FAQ"; } \
  | run_hook 28d-truncated-user-request-cancel silent
# The offline checker agrees (same shared region): the FAQ reply after a skipped picker is not flagged.
{ user "/clarify storage"; reply_ask "$Q1"; answer ""; reply "$FAQ"; } | run_checker 28e-empty-answer-disarms 0
# Safety net: at most 2 consecutive interventions without an ask_question call.
{ user "/clarify storage"; reply "$Q1"; block; reply "$Q1"; } | run_hook 27j-second-consecutive-intervention continue
{ user "/clarify storage"; reply "$Q1"; block; reply "$Q1"; block; reply "$Q1"; } | run_hook 27k-cap-stands-down silent
# The same cap against the E8 loop when the cancel is not recognised (an ordinary-looking answer).
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option B"; reply "$FAQ"; block; reply "$FAQ"; block; reply "$FAQ"; block; reply "$FAQ"; } \
  | run_hook 27l-faq-loop-stands-down silent
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option B"; reply "$FAQ"; block; reply "$FAQ"; } | run_hook 27m-faq-loop-second-intervention continue
# The count resets on an ask_question call and on a user turn.
{ user "/clarify storage"; reply "$Q1"; block; reply "$Q1"; block; reply_ask "$Q1"; answer "A"; reply "$Q2T"; } \
  | run_hook 27n-cap-resets-on-ask continue
{ user "/clarify storage"; reply "$Q1"; block; reply "$Q1"; block; user "A"; reply "$Q2T"; } \
  | run_hook 27o-cap-resets-on-user-input continue
# The stand-down is logged on stderr and still prints {}.
{ user "/clarify storage"; reply "$Q1"; block; reply "$Q1"; block; reply "$Q1"; } > "$tmp/27p.jsonl"
err="$(jq -nc --arg p "$tmp/27p.jsonl" '{terminationReason: "NO_TOOL_CALL", transcriptPath: $p}' | CLARIFY_HOOK_STRICT=1 bash "$hook" 2>&1 >/dev/null)"
case "$err" in *"standing down after 2 consecutive interventions"*) record ok "PASS 27p-stand-down-logged";; *) record x "FAIL 27p-stand-down-logged: stderr was '$err'";; esac

# The offline checker must agree on the same cases.
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option A"; reply_ask "$Q2" "Question 2 of 3"; answer "$CANCEL"; reply "$FAQ"; } \
  | run_checker 27a-cancel-then-faq 0
{ user "/clarify storage"; reply_ask "$Q1"; answer "Option A"; reply_ask "$Q2" "Question 2 of 3"; answer "Option B"; reply "$FAQ"; } \
  | run_checker 27c-control-no-cancel-faq 1
{ user "write me an interview FAQ"; reply "$FAQ"; } | run_checker 3-no-clarify-faq 0
{ finished; reply "$TABLE"; user "unrelated"; reply "$SEP"; } | run_checker 4-after-decision-table 0
{ user "/clarify storage"; reply "$FENCED"; } | run_checker 5-fenced-heading 0
{ user "/clarify storage"; reply "$Q1"; } | run_checker 1-clarify-heading-no-tool 1
{ user "/clarify storage"; reply_ask "$Q1"; user "show the table so far"; reply "$RECAP"; user "ok"; reply "$Q2"; } \
  | run_checker 12-mid-series-decision-table 1
{ user "/clarify storage"; reply "$NESTED"; } \
  | run_checker 17-nested-fence 0

# 29. prose option headings against the picker labels of the same reply (issue #123).
# reply_opts <content> <tag> <option>...: a reply whose ask_question call carries these option labels.
reply_opts() {
  local content="$1" tag="$2"
  shift 2
  jq -nc --arg c "$content" --arg t "[$tag] Which shape?" '{type: "PLANNER_RESPONSE", content: $c, tool_calls: [{name: "ask_question", args: {questions: [{question: $t, options: $ARGS.positional}]}}]}' --args "$@"
}
# step <heading> <option heading>...: the prose of one question step.
step() {
  local out="$1" h
  shift
  for h in "$@"; do out+=$'\n\n'"### $h"$'\n\nPros and cons.'; done
  printf '%s' "$out"
}
QL='## Question 3 (of 7) — Listener shape'
PA='Option A. Shared core in a2a-lib.sh, plus a thin bin/a2a-agy-listen (Recommended)'
PB='Option B. Standalone bin/a2a-agy-listen, forked from a2a-listen'
PC='Option C. Reuse a2a-listen itself, behind an A2A_HARNESS=agy switch'
LISTEN="$(step "$QL" "$PA" "$PB" "$PC")"
# The recorded case: the recommendation flipped while drafting and only the picker was reordered,
# so picker Option A is the prose Option B. The reworded Option B and C labels are warnings.
{ user "/clarify listener"; reply_opts "$LISTEN" "Question 3 of 7" \
    "(Recommended) Option A: Standalone bin/a2a-agy-listen forked from a2a-listen" \
    "Option B: Shared loop in a2a-lib.sh plus thin per-harness wrappers" \
    "Option C: Reuse a2a-listen behind an A2A_HARNESS=agy switch"; } \
  | run_checker 29a-picker-reordered-prose-not 1 2
# Positive control: the same prose with labels in the prose order passes without a warning.
{ user "/clarify listener"; reply_opts "$LISTEN" "Question 3 of 7" \
    "(Recommended) Option A: Shared core in a2a-lib.sh, plus a thin bin/a2a-agy-listen" \
    "Option B: Standalone bin/a2a-agy-listen, forked from a2a-listen" \
    "Option C: Reuse a2a-listen itself, behind an A2A_HARNESS=agy switch"; } \
  | run_checker 29b-labels-match 0 0
# The picker drops an option that the prose argued.
{ user "/clarify listener"; reply_opts "$LISTEN" "Question 3 of 7" \
    "(Recommended) Option A: Shared core in a2a-lib.sh, plus a thin bin/a2a-agy-listen" \
    "Option B: Standalone bin/a2a-agy-listen, forked from a2a-listen"; } \
  | run_checker 29c-picker-drops-an-option 1
# A label reworded in place, with no other option's name on it, is a warning and not a failure.
{ user "/clarify listener"; reply_opts "$LISTEN" "Question 3 of 7" \
    "(Recommended) Option A: Shared core plus thin wrapper" \
    "Option B: Standalone bin/a2a-agy-listen, forked from a2a-listen" \
    "Option C: Reuse a2a-listen itself, behind an A2A_HARNESS=agy switch"; } \
  | run_checker 29d-reworded-label-warns 0 1
# Mode B: the picker adds the formal anchor after the prose name; that is the documented format.
MODEB="$(step '## Question 1 (of 5) — Tags' 'Option A. The Digital Sticky Tag (Recommended)' 'Option B. The Direct Sharpie Label')"
{ user "/cplain tags"; reply_opts "$MODEB" "Question 1 of 5" \
    "(Recommended) Option A: The Digital Sticky Tag (M:N Join Table)" \
    "Option B: The Direct Sharpie Label (Denormalized JSONB)"; } \
  | run_checker 29e-mode-b-anchor-suffix 0 0
# Mode B with the two picker labels swapped is the same failure.
{ user "/cplain tags"; reply_opts "$MODEB" "Question 1 of 5" \
    "(Recommended) Option A: The Direct Sharpie Label (Denormalized JSONB)" \
    "Option B: The Digital Sticky Tag (M:N Join Table)"; } \
  | run_checker 29f-mode-b-swapped 1
# Option headings inside a fenced example are not the step's options.
FENCEDOPTS="$(printf '%s\n\nThe format:\n\n%smd\n### Option A. zzz\n### Option B. yyy\n### Option C. xxx\n%s\n' "$QL" "$BT" "$BT")"
{ user "/clarify listener"; reply_opts "$FENCEDOPTS" "Question 3 of 7" "(Recommended) Option A: sqlite" "Option B: postgres"; } \
  | run_checker 29g-fenced-option-headings 0 0
# Two steps in one reply: the skipped question is the one failure, and its options are not
# compared with the picker of the next question.
TWO="$(printf '%s\n\n%s' "$(step '## Question 2 (of 7) — Topology' 'Option A. Listener (Recommended)' 'Option B. Cron' 'Option C. Both' 'Option D. Neither')" "$LISTEN")"
{ user "/clarify listener"; reply_opts "$TWO" "Question 3 of 7" \
    "(Recommended) Option A: Shared core in a2a-lib.sh, plus a thin bin/a2a-agy-listen" \
    "Option B: Standalone bin/a2a-agy-listen, forked from a2a-listen" \
    "Option C: Reuse a2a-listen itself, behind an A2A_HARNESS=agy switch"; } \
  | run_checker 29h-options-of-the-last-step-only 1 0

pass="$(cat "$tmp/pass" 2>/dev/null | wc -l)"
fail="$(cat "$tmp/fail" 2>/dev/null | wc -l)"
echo "passed=$((pass + 0)) failed=$((fail + 0))"
[ "$((fail + 0))" -eq 0 ]
