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
  test("(?:^|(?<=[\\s>\\[(\($sq)\"]))/(clarify|grill-me|cplain|celi5)(?:$|(?=[\\s.,;:!?<\\]\($sq)\"]))"; "i");

def heading_match:
  rtrimstr("\r")
  | capture("^##[ \\t]*Question[ \\t]+(?<n>[0-9]+)(?:[ \\t]*\\(of[ \\t]*(?<m>[0-9]+)\\)|[ \\t]*(?<sep>[—–\\-(]))")?
  | select(.m != null or .sep != null)
  | {n: (.n | tonumber), m: (if .m != null then (.m | tonumber) else null end)};

# Lines of a reply that sit outside fenced code blocks. A fence opens with 3+ backticks
# or tildes (at most 3 spaces of indent; a backtick fence has no backtick in its info
# string) and closes on a line of the same character, at least as long, with nothing
# after it. Linear time: one foreach pass.
def outside_fences:
  [ foreach (split("\n")[]) as $l ({open: null, emit: false};
      if .open == null then
        ([$l | capture("^ {0,3}(?<f>`{3,}|~{3,})(?<info>.*)$")][0]) as $o
        | if $o != null and (($o.f[0:1] == "~") or ($o.info | contains("`") | not))
          then {open: {c: $o.f[0:1], n: ($o.f | length)}, emit: false}
          else {open: null, emit: true, line: $l} end
      else
        ([$l | capture("^ {0,3}(?<f>`{3,}|~{3,})[ \\t]*$")][0]) as $c
        | if $c != null and $c.f[0:1] == .open.c and ($c.f | length) >= .open.n
          then {open: null, emit: false}
          else {open: .open, emit: false} end
      end;
      if .emit then .line else empty end) ];

# A clarify session starts at a command, the Turn-1 target line, the fork-map line,
# or a tagged ask_question; it ends at the closing Decision Table.
def has_trigger($lines):
  any($lines[]; (contains("Target resolved:") or contains("orthogonal"))
    and test("Target resolved:|(Decomposing into|Identified) [0-9]+ orthogonal"));

def all_headings($lines): [ $lines[] | select(startswith("##")) | heading_match ];

# Question headings count only inside a clarify session.
def extract_headings($lines; $clarify_seen):
  if $clarify_seen then all_headings($lines) else [] end;

def decision_table($lines):
  any($lines[]; (startswith("#") or startswith("*"))
    and test("^(#{1,4}[ \\t]*|\\*\\*)([0-9]+[.)][ \\t]*)?(final[ \\t]+)?decision[ \\t]+table"; "i"));

# [Question N of M] / [Fork N of M] tags on ask_question calls of this reply.
def ask_tags($e):
  [ ($e.tool_calls // []) | if type == "array" then .[] else empty end
    | select(type == "object" and .name == "ask_question")
    | (.args // {}) | tostring
    | [capture("\\[\\s*(?:Question|Fork)\\s+(?<n>[0-9]+)\\s+of\\s+(?<m>[0-9]+)\\s*\\]"; "i")][0]
    | select(. != null)
    | {n: (.n | tonumber), m: (.m | tonumber)} ];

# The Decision Table closes the series only when it is the whole reply (no Question
# heading) and the last question asked was the last one (n >= m, or nothing tracked).
def closes_series($lines; $last):
  decision_table($lines)
  and (all_headings($lines) | length) == 0
  and ($last == null or $last.n >= $last.m);

reduce (inputs | fromjson? | select(type == "object")) as $e
  ({clarify_seen: false, last: null, pending: []};
   if $e.type == "USER_INPUT" then
     ($e.content | str) as $ucontent
     | .pending = []
     | (if ($ucontent | clarify_cmd) then .clarify_seen = true | .last = null else . end)
   elif $e.type == "PLANNER_RESPONSE" then
     ($e.content | str | outside_fences) as $lines
     | ask_tags($e) as $tags
     | (.clarify_seen or has_trigger($lines) or ($tags | length) > 0) as $cseen
     | closes_series($lines; .last) as $closes
     | .pending += extract_headings($lines; $cseen)
     | .last = (if $cseen and ($closes | not)
                then (($tags | last) // (all_headings($lines) | map(select(.m != null)) | last) // .last)
                else null end)
     | .clarify_seen = ($cseen and ($closes | not))
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
