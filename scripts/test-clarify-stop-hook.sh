#!/usr/bin/env bash
# test-clarify-stop-hook.sh - regression tests for skills/clarify/hooks/clarify-stop-check.sh
# and the matching Antigravity mode of scripts/check-clarify-transcript.sh.
#
# Requires: bash, jq, grep. Exits non-zero when any case fails.

# shellcheck disable=SC2016  # jq programs and literal backticks are single-quoted on purpose
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
hook="$root/skills/clarify/hooks/clarify-stop-check.sh"
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
    | jq -c "$extra" | CLARIFY_HOOK_STRICT=1 bash "$hook")"
  rc=$?
  if [ "$(printf '%s' "$out" | jq -r '.decision // ""')" = "continue" ]; then got="continue"; fi
  if [ "$rc" -eq 0 ] && [ "$got" = "$expect" ]; then record ok "PASS $name"
  else record x "FAIL $name: expected $expect, got $got (exit $rc, $out)"; fi
}

# run_checker <name> <expected failed count> < transcript
run_checker() {
  local name="checker-$1" want="$2" file="$tmp/checker-$1.jsonl" out got
  cat > "$file"
  out="$(bash "$checker" --format antigravity "$file" 2>&1)"
  got="$(printf '%s\n' "$out" | grep -o 'failed=[0-9]*' | tail -1)"
  if [ "$got" = "failed=$want" ]; then record ok "PASS $name"
  else record x "FAIL $name: expected failed=$want, got ${got:-none}"; printf '%s\n' "$out" | tail -5; fi
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

# The offline checker must agree on the same cases.
{ user "write me an interview FAQ"; reply "$FAQ"; } | run_checker 3-no-clarify-faq 0
{ finished; reply "$TABLE"; user "unrelated"; reply "$SEP"; } | run_checker 4-after-decision-table 0
{ user "/clarify storage"; reply "$FENCED"; } | run_checker 5-fenced-heading 0
{ user "/clarify storage"; reply "$Q1"; } | run_checker 1-clarify-heading-no-tool 1
{ user "/clarify storage"; reply_ask "$Q1"; user "show the table so far"; reply "$RECAP"; user "ok"; reply "$Q2"; } \
  | run_checker 12-mid-series-decision-table 1
{ user "/clarify storage"; reply "$NESTED"; } \
  | run_checker 17-nested-fence 0

pass="$(cat "$tmp/pass" 2>/dev/null | wc -l)"
fail="$(cat "$tmp/fail" 2>/dev/null | wc -l)"
echo "passed=$((pass + 0)) failed=$((fail + 0))"
[ "$((fail + 0))" -eq 0 ]
