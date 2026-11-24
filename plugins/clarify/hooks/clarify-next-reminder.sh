#!/usr/bin/env bash
# clarify-next-reminder.sh - Claude Code PostToolUse hook (matcher AskUserQuestion) for `clarify`.
#
# After the user answers a clarify question, remind the model, in context only (nothing is
# shown to the user and nothing is blocked), to print the full step for the next question
# before it calls the question tool again (issue #97, follow-up to #98).
#
# Why here. The failure behind #97 is a terse output style repeating its brevity reminder
# right after each answer, so the next question goes out with only the dialog and no write-up.
# A PostToolUse hook runs at exactly that point. The earlier design, a PreToolUse checkpoint
# that denied each question once, showed a red "hook error" line on every question and cost an
# extra round trip, and a PreToolUse hook cannot see the reply it guards anyway (Claude Code
# writes the current turn to the transcript after PreToolUse hooks finish).
#
# Acts only on a clarify question: its text starts with "[Question N of M]" or
# "[Fork N of M]". Other questions pass untouched. It never blocks and fails open.
# Requires: bash, jq. CLARIFY_HOOK_STRICT=1 (tests only) makes a broken jq exit 3.

set -uo pipefail

payload="$(cat 2>/dev/null)" || exit 0
[ -n "$payload" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

nm="$(printf '%s' "$payload" | jq -r '
  (.tool_input.questions // [])[0].question // "" | tostring
  | capture("^\\s*\\[\\s*(?:Question|Fork)\\s+(?<n>[0-9]+)\\s+of\\s+(?<m>[0-9]+)\\s*\\]"; "i") | "\(.n) \(.m)"
  ' 2>/dev/null)" || { [ "${CLARIFY_HOOK_STRICT:-}" = 1 ] && exit 3; exit 0; }
[ -n "$nm" ] || exit 0
n="${nm% *}"; m="${nm#* }"

if [ "$n" -lt "$m" ]; then
  next=$((n + 1))
  msg="clarify: Question $n of $m is answered. Per-fork invariant: before you call the question tool again, print the full step for Question $next in this reply (the '## Question $next (of $m)' heading, context, argued options with pros and cons, your reading and the recommendation). The dialog must not be the only explanation, whatever the output style says."
else
  msg="clarify: the last question ($n of $m) is answered. Print the decision table, the final architecture artifact and the workstream breakdown, then ask for the go (do not tag that gate as a Question)."
fi

jq -nc --arg c "$msg" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $c}}'
exit 0
