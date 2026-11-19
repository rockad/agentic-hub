#!/usr/bin/env bash
# clarify-stop-check.sh - Antigravity Stop hook for the `clarify` skill.
#
# Prevents premature end-of-turn when a reply emits clarify "## Question N"
# prose without calling `ask_question` in the same reply window.
#
# Requires: bash, jq. No Python. Always fails open ({} + exit 0).

set -uo pipefail

fail_open() {
  printf '{}\n'
  exit 0
}

command -v jq >/dev/null 2>&1 || fail_open

payload="$(cat 2>/dev/null)" || fail_open
[ -n "$payload" ] || fail_open

meta="$(printf '%s' "$payload" | jq -r '
  if type != "object" then "SKIP"
  elif (.terminationReason // "") != "NO_TOOL_CALL" or (.continuationActive == true) then "SKIP"
  elif ((.transcriptPath // "") | type) != "string" or (.transcriptPath // "") == "" then "SKIP"
  else "OK:" + .transcriptPath end
' 2>/dev/null)" || fail_open

case "$meta" in
  OK:*) transcript_path="${meta#OK:}" ;;
  *) fail_open ;;
esac

[ -n "$transcript_path" ] && [ -r "$transcript_path" ] || fail_open

# shellcheck disable=SC2016  # the jq program is single-quoted on purpose
JQ_PROG='
def str: if type == "string" then . else "" end;
def clarify_cmd:
  test("(?:^|(?<=[\\s>\\[(\($sq)\"]))/(clarify|grill-me|cplain|celi5)(?:$|(?=[\\s.,;:!?<\\]\($sq)\"]))");

def heading_match($clarify_seen):
  rtrimstr("\r")
  | capture("^##[ \\t]*Question[ \\t]+(?<n>[0-9]+)(?:[ \\t]*\\(of[ \\t]*(?<m>[0-9]+)\\)|[ \\t]*(?<sep>[—–\\-(]))")?
  | select(.m != null or ($clarify_seen and .sep != null))
  | {n: (.n | tonumber), m: (if .m != null then (.m | tonumber) else null end)};

def extract_headings($content; $clarify_seen):
  [ ($content | split("\n")[] | heading_match($clarify_seen)) ];

reduce (inputs | fromjson? | select(type == "object")) as $e
  ({clarify_seen: false, pending: []};
   if $e.type == "USER_INPUT" then
     ($e.content | str) as $ucontent
     | .pending = []
     | (if ($ucontent | clarify_cmd) then .clarify_seen = true else . end)
   elif $e.type == "PLANNER_RESPONSE" then
     ($e.content | str) as $content
     | (if ($content | test("Target resolved:")) then true else .clarify_seen end) as $cseen
     | .clarify_seen = $cseen
     | (if $content != "" then
          .pending += extract_headings($content; $cseen)
        else . end)
     | if any(($e.tool_calls // []) | if type == "array" then .[] else empty end;
              type == "object" and .name == "ask_question")
       then .pending = []
       else . end
   else . end)
| if (.pending | length) > 0 then
    .pending[-1] as $h
    | (if $h.m != null then ($h.m | tostring) else "Total" end) as $mstr
    | {
        decision: "continue",
        reason: "You emitted ## Question \($h.n) prose without calling ask_question in this reply. Call ask_question now for Question \($h.n) (with [Question \($h.n) of \($mstr)] and matching Option A/B/C labels) before ending the turn."
      }
  else
    {}
  end
'

output="$(jq -nrRc --arg sq "'" "$JQ_PROG" < "$transcript_path" 2>/dev/null)" || fail_open
[ -n "$output" ] || fail_open
printf '%s\n' "$output"
exit 0
