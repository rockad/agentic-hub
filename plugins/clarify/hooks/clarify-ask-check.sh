#!/usr/bin/env bash
# clarify-ask-check.sh - Claude Code PreToolUse hook (matcher AskUserQuestion) for `clarify`.
#
# A checkpoint before every clarify question (issue #97): make the model confirm that the
# full "## Question N" write-up is printed in this reply, and print it if not. Rules alone
# stop holding in long sessions, where the skill text is far back in context and a terse
# output style repeats its brevity reminder after every answer.
#
# Acts only on a clarify question: its text starts with "[Question N of M]" or
# "[Fork N of M]". Any other AskUserQuestion passes untouched.
#
# Why a checkpoint and not a check. Live measurements (Claude Code 2.1.33x) showed that the
# hook cannot see the text of the reply it is guarding: Claude Code writes the current turn
# to the transcript only after the PreToolUse hooks have finished. The payload carries no
# assistant text, and waiting does not help (the call's tool_use never appeared, even after
# 6 seconds). A hook that judged the transcript therefore either denied every fork, even
# those with a write-up, or, once it waited for the transcript, silently allowed everything.
# So the hook does not pretend to know. It denies each question number once per user prompt
# with a message that is true either way, and lets the retry through:
#   - write-up printed: the model calls again at once (one small extra round trip);
#   - write-up missing: the model prints it, then calls again.
# The retry can never loop. If the heading for N is already visible in the transcript (an
# earlier flush), the call passes at once.
#
# Requires: bash, jq. Fails open (prints nothing, exits 0) on any error.
# CLARIFY_HOOK_STRICT=1 (tests only) makes a broken jq program exit 3 instead.

set -uo pipefail

payload="$(cat 2>/dev/null)" || exit 0
[ -n "$payload" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

fail() { [ "${CLARIFY_HOOK_STRICT:-}" = 1 ] && exit 3; exit 0; }

# The question number and the total of a clarify question, nothing otherwise.
nm="$(printf '%s' "$payload" | jq -r '
  (.tool_input.questions // [])[0].question // "" | tostring
  | capture("^\\s*\\[\\s*(?:Question|Fork)\\s+(?<n>[0-9]+)\\s+of\\s+(?<m>[0-9]+)\\s*\\]"; "i") | "\(.n) \(.m)"
  ' 2>/dev/null)" || fail
[ -n "$nm" ] || exit 0
n="${nm% *}"; m="${nm#* }"

# Unit-separator joined: an empty field must not shift the others (tab would collapse).
IFS=$'\x1f' read -r session transcript < <(printf '%s' "$payload" \
  | jq -r '[.session_id // "", .transcript_path // ""] | join("\u001f")' 2>/dev/null) || fail

# Verdict on what the transcript holds so far: the heading for N in the assistant text since
# the last user entry (a prompt or a tool result), and the uuid of the last real prompt (not a
# tool result, not isMeta). Only the last 6 MB are read, with no line cap: most lines of a real
# transcript are not messages, and a line cap loses the prompt in a long series, which would
# make the gate key fall back to the session and skip numbers already used.
[ -n "$transcript" ] && [ -r "$transcript" ] || exit 0
out="$(tail -c 6000000 "$transcript" | jq -rRs --argjson n "$n" '
  [ split("\n")[] | fromjson? | select(type == "object") ] as $es
  | ([ $es | to_entries[] | select(.value.type == "user") | .key ] | last) as $u
  | ([ $es[] | select(.type == "user" and (.isMeta != true)
         and (((.message.content | type) == "string")
              or ((.message.content | type) == "array"
                  and ((.message.content | any(.type == "tool_result")) | not))))
       | .uuid // "" ] | last // "") as $p
  | if $u == null then "unknown\t"
    else
      ( [ $es[($u + 1):][] | select(.type == "assistant")
          | (.message.content // []) | if type == "array" then .[] else empty end
          | select(.type == "text") | (.text // "") ] | join("\n")
      ) as $text
      | (if ($text | test("(^|\n)\\s*#{2,}\\s*Question\\s+\($n)(\\D|$)")) then "ok" else "missing" end)
        + "\t" + $p
    end' 2>/dev/null)" || fail
IFS=$'\t' read -r verdict prompt <<< "$out"
[ "$verdict" = "missing" ] || exit 0          # heading already visible, or nothing to go on

# Gate each question number once per user prompt, not once per session: a session runs many
# series and a typed complaint starts a new chain. Retries inside one reply chain share the
# prompt, so the hook cannot loop. Without a prompt uuid, fall back to the session.
dir="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}}"
mark="$dir/clarify-ask-check-${session:-nosession}.denied"
key="$n:${prompt:-$session}"
if [ -r "$mark" ] && grep -qxF "$key" "$mark" 2>/dev/null; then exit 0; fi
{ mkdir -p "$dir" && printf '%s\n' "$key" >> "$mark"; } 2>/dev/null || exit 0

reason="clarify checkpoint (routine, not an error) for Question $n. If the full '## Question $n (of $m)' step is already printed above in this reply, call AskUserQuestion again now with the identical question and print nothing else. If it is not, print it now (heading, context, argued options with pros and cons, your reading and the recommendation), then call AskUserQuestion again with the identical question. The dialog must not be the only explanation (clarify SKILL.md, Per-fork invariant)."
jq -nc --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
exit 0
