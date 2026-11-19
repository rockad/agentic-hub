#!/usr/bin/env bash
# test-clarify-stop-hook.sh - regression tests for skills/clarify/hooks/clarify-stop-check.sh
# and the matching Antigravity mode of scripts/check-clarify-transcript.sh.
#
# Requires: bash, jq, grep. Exits non-zero when any case fails.

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
  local name="$1" expect="$2" extra="${3:-.}" file="$tmp/$1.jsonl" out got=silent
  cat > "$file"
  out="$(jq -nc --arg p "$file" '{terminationReason: "NO_TOOL_CALL", transcriptPath: $p}' \
    | jq -c "$extra" | bash "$hook")"
  if [ "$(printf '%s' "$out" | jq -r '.decision // ""')" = "continue" ]; then got="continue"; fi
  if [ "$got" = "$expect" ]; then record ok "PASS $name"
  else record x "FAIL $name: expected $expect, got $got ($out)"; fi
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

# 21. one very large reply must stay fast (the hook has a 5 s timeout).
{ user "/clarify storage"; jq -nc '{type: "PLANNER_RESPONSE", content: ([range(40000) | "line \(.)"] | join("\n"))}'; } > "$tmp/big.jsonl"
start=$SECONDS
out="$(jq -nc --arg p "$tmp/big.jsonl" '{terminationReason: "NO_TOOL_CALL", transcriptPath: $p}' | bash "$hook")"
took=$((SECONDS - start))
if [ "$took" -lt 3 ] && [ "$out" = "{}" ]; then record ok "PASS 21-large-reply-fast (${took}s)"
else record x "FAIL 21-large-reply-fast: ${took}s, output $out"; fi

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
