#!/usr/bin/env bash
# clarify-ask-check.sh - Claude Code PreToolUse hook (matcher AskUserQuestion) for `clarify`.
#
# Blocks a clarify question that has no "## Question N" write-up before it in the same
# reply window (issue #97). Rules alone stop holding in long sessions, where the skill text
# is far back in context and a terse output style repeats its brevity reminder after every
# answer.
#
# Acts only on a clarify question: its text starts with "[Question N of M]" or
# "[Fork N of M]". Any other AskUserQuestion passes untouched.
#
# The transcript is written asynchronously and can lag, so a missing heading may be a false
# alarm. The hook therefore denies each question number once per session and lets the retry
# through: a lagging transcript costs one extra round trip and can never loop.
#
# Requires: bash, jq. Fails open (prints nothing, exits 0) on any error.
# CLARIFY_HOOK_STRICT=1 (tests only) makes a broken jq program exit 3 instead.

set -uo pipefail

payload="$(cat 2>/dev/null)" || exit 0
[ -n "$payload" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

fail() { [ "${CLARIFY_HOOK_STRICT:-}" = 1 ] && exit 3; exit 0; }

# "<session_id>\t<transcript_path>\t<N>" for a clarify question, nothing otherwise.
meta="$(printf '%s' "$payload" | jq -r '
  (.tool_input.questions // [])[0].question // "" | tostring
  | capture("^\\s*\\[\\s*(?:Question|Fork)\\s+(?<n>[0-9]+)\\s+of\\s+[0-9]+\\s*\\]"; "i") | .n
  ' 2>/dev/null)" || fail
[ -n "$meta" ] || exit 0
n="$meta"

read -r session transcript < <(printf '%s' "$payload" | jq -r '[.session_id // "", .transcript_path // ""] | @tsv' 2>/dev/null) || fail
[ -n "$transcript" ] && [ -r "$transcript" ] || exit 0

# Assistant text since the last user entry (a user entry is a prompt or a tool result).
# Only the tail of the transcript is read: that region sits at the very end. If the window
# holds no user entry, the answer is unknown and the call passes.
verdict="$(tail -n 300 "$transcript" | jq -rRs --argjson n "$n" '
  [ split("\n")[] | fromjson? | select(type == "object") ] as $es
  | ([ $es | to_entries[] | select(.value.type == "user") | .key ] | last) as $u
  | if $u == null then "unknown"
    else
      ( [ $es[($u + 1):][] | select(.type == "assistant")
          | (.message.content // []) | if type == "array" then .[] else empty end
          | select(.type == "text") | (.text // "") ] | join("\n")
      ) as $text
      | if ($text | test("(^|\n)\\s*##\\s*Question\\s+\($n)(\\D|$)")) then "ok" else "missing" end
    end' 2>/dev/null)" || fail
[ "$verdict" = "missing" ] || exit 0

# Deny each question number once per session.
dir="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}}"
mark="$dir/clarify-ask-check-${session:-nosession}.denied"
if [ -r "$mark" ] && grep -qx "$n" "$mark" 2>/dev/null; then exit 0; fi
{ mkdir -p "$dir" && printf '%s\n' "$n" >> "$mark"; } 2>/dev/null || exit 0

reason="clarify: Question $n has no write-up before it. Print the full step for Question $n now: the '## Question $n (of Total)' heading, context, argued options with pros and cons, your reading and the recommendation. Then call AskUserQuestion again with the same question. The dialog must not be the only explanation (clarify SKILL.md, Per-fork invariant)."
jq -nc --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
exit 0
