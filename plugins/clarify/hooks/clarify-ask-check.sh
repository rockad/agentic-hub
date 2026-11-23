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
# The transcript is written asynchronously, so when this hook fires the text the model just
# printed may not be in it yet. A live run showed exactly that: every fork that did have its
# write-up was denied once. So the hook judges only when the transcript has caught up, that
# is when it already holds the tool_use entry of this very call (payload tool_use_id): the
# text before that entry is then complete. It polls briefly for that entry, and if it never
# appears the answer is unknown and the call passes (fail open).
#
# As a second guard it denies each question number once per user prompt and lets the retry
# through, so even a wrong verdict can never loop. A new prompt (a new series, or a typed
# complaint) gets a fresh deny per question number.
#
# Requires: bash, jq. Fails open (prints nothing, exits 0) on any error.
# Tests only: CLARIFY_HOOK_STRICT=1 makes a broken jq program exit 3; CLARIFY_ASK_POLLS and
# CLARIFY_ASK_NAP (seconds) shorten the wait for the transcript.

set -uo pipefail

payload="$(cat 2>/dev/null)" || exit 0
[ -n "$payload" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

fail() { [ "${CLARIFY_HOOK_STRICT:-}" = 1 ] && exit 3; exit 0; }

# The question number of a clarify question, nothing otherwise.
n="$(printf '%s' "$payload" | jq -r '
  (.tool_input.questions // [])[0].question // "" | tostring
  | capture("^\\s*\\[\\s*(?:Question|Fork)\\s+(?<n>[0-9]+)\\s+of\\s+[0-9]+\\s*\\]"; "i") | .n
  ' 2>/dev/null)" || fail
[ -n "$n" ] || exit 0

# Unit-separator joined: an empty field must not shift the others (tab would collapse).
IFS=$'\x1f' read -r session transcript tuid < <(printf '%s' "$payload" \
  | jq -r '[.session_id // "", .transcript_path // "", .tool_use_id // ""] | join("\u001f")' 2>/dev/null) || fail
[ -n "$transcript" ] && [ -r "$transcript" ] || exit 0

# Verdict on the assistant text since the last user entry (a prompt or a tool result), the
# last real prompt's uuid (not a tool result, not isMeta), and whether this call's tool_use
# is already in the transcript. Only the tail is read: that region sits at the very end.
judge() {
  tail -n 300 "$transcript" | jq -rRs --argjson n "$n" --arg id "$tuid" '
    [ split("\n")[] | fromjson? | select(type == "object") ] as $es
    | ([ $es | to_entries[] | select(.value.type == "user") | .key ] | last) as $u
    | ([ $es[] | select(.type == "user" and (.isMeta != true)
           and (((.message.content | type) == "string")
                or ((.message.content | type) == "array"
                    and ((.message.content | any(.type == "tool_result")) | not))))
         | .uuid // "" ] | last // "") as $p
    | ( $id == "" or ([ $es[] | select(.type == "assistant")
                        | (.message.content // []) | if type == "array" then .[] else empty end
                        | select(.type == "tool_use" and .id == $id) ] | length) > 0 ) as $seen
    | if $u == null then "unknown\tno\t"
      else
        ( [ $es[($u + 1):][] | select(.type == "assistant")
            | (.message.content // []) | if type == "array" then .[] else empty end
            | select(.type == "text") | (.text // "") ] | join("\n")
        ) as $text
        | (if ($text | test("(^|\n)\\s*#{2,}\\s*Question\\s+\($n)(\\D|$)")) then "ok" else "missing" end)
          + "\t" + (if $seen then "yes" else "no" end) + "\t" + $p
      end' 2>/dev/null
}

polls="${CLARIFY_ASK_POLLS:-8}"
nap="${CLARIFY_ASK_NAP:-0.25}"
i=0
while :; do
  out="$(judge)" || fail
  IFS=$'\t' read -r verdict seen prompt <<< "$out"
  [ "$verdict" = "missing" ] || exit 0          # heading present, or no user entry in the window
  [ "$seen" = "yes" ] && break                  # the transcript has caught up: trust the verdict
  i=$((i + 1))
  [ "$i" -ge "$polls" ] && exit 0               # never caught up: unknown, so fail open
  sleep "$nap"
done

# Deny each question number once per user prompt, not once per session: a session runs many
# series and a typed complaint starts a new chain. Retries inside one reply chain share the
# prompt, so the hook cannot loop. Without a prompt uuid in the window, fall back to the
# session.
dir="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}}"
mark="$dir/clarify-ask-check-${session:-nosession}.denied"
key="$n:${prompt:-$session}"
if [ -r "$mark" ] && grep -qxF "$key" "$mark" 2>/dev/null; then exit 0; fi
{ mkdir -p "$dir" && printf '%s\n' "$key" >> "$mark"; } 2>/dev/null || exit 0

reason="clarify: Question $n has no write-up before it. Print the full step for Question $n now: the '## Question $n (of Total)' heading, context, argued options with pros and cons, your reading and the recommendation. Then call AskUserQuestion again with the same question. The dialog must not be the only explanation (clarify SKILL.md, Per-fork invariant)."
jq -nc --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
exit 0
