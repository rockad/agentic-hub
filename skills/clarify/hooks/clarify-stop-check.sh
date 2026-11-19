#!/usr/bin/env bash
# clarify-stop-check.sh - Antigravity Stop hook for the `clarify` skill.
#
# Prevents premature end-of-turn when a reply emits clarify "## Question N"
# prose without calling `ask_question` in the same reply window.
#
# Requires: bash, jq. No Python. Always fails open ({} + exit 0); the only exception
# is the test-only CLARIFY_HOOK_STRICT switch near the end of this file.

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
  test("(?:^|(?<=[\\s>\\[(\($sq)`\"]))/(clarify|grill-me|cplain|celi5)(?:$|(?=[\\s.,;:!?<)\\]\($sq)`\"]))"; "i");

def heading_match:
  rtrimstr("\r")
  | capture("^##[ \\t]*Question[ \\t]+(?<n>[0-9]+)(?:[ \\t]*\\(of[ \\t]*(?<m>[0-9]+)\\)|[ \\t]*(?<sep>[—–\\-(]))")?
  | select(.m != null or .sep != null)
  | {n: (.n | tonumber), m: (if .m != null then (.m | tonumber) else null end)};

# Lines of a reply that sit outside fenced code blocks. A fence opens with 3+ backticks
# or tildes (at most 3 spaces of indent; a backtick fence has no backtick in its info
# string) and closes on a line of the same character, at least as long, with nothing
# after it. CRLF is normalised first. Linear time: one foreach pass.
def outside_fences:
  [ foreach (split("\n")[] | rtrimstr("\r")) as $l ({open: null, emit: false};
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

# Cheap substring prefilters keep the regexes off lines that cannot match.
def all_headings($lines):
  [ $lines[] | select(startswith("##") and contains("Question")) | heading_match ];

# A Decision Table heading (any case; optional number, emoji, "Final", quote or bold).
# At most 100 prefiltered candidates are tested, so a pathological reply cannot run
# the regex on every line.
def decision_table($lines):
  [ limit(100; $lines[] | select((startswith("#") or startswith("*") or startswith(">"))
      and (ascii_downcase | contains("decision") and contains("table")))) ]
  | any(.[]; test("^(>[ \\t]*)?(#{1,4}|\\*\\*)[^A-Za-z]*(final[ \\t]+)?decisions?[ \\t]+table"; "i"));

# The gate heading (closing.md) appears only once the series is over; a mid-series recap
# may show the table and the artifact but never the gate.
def closing_sections($lines):
  any($lines[]; startswith("#") and contains("Gated Execution"));

# `Fork map revised: N → M` sets the new total M (SKILL.md, the fork-count-is-locked rule).
def revised_total($lines):
  [ $lines[] | select(contains("Fork map revised"))
    | [capture("Fork map revised:\\s*[0-9]+\\s*(?:→|->)\\s*(?<m>[0-9]+)")][0]
    | select(. != null) | (.m | tonumber) ] | last;

# [Question N of M] / [Fork N of M] tags on ask_question calls of this reply.
def ask_tags($e):
  [ ($e.tool_calls // []) | if type == "array" then .[] else empty end
    | select(type == "object" and .name == "ask_question")
    | (.args // {}) | tostring
    | [capture("\\[\\s*(?:Question|Fork)\\s+(?<n>[0-9]+)\\s+of\\s+(?<m>[0-9]+)\\s*\\]"; "i")][0]
    | select(. != null)
    | {n: (.n | tonumber), m: (.m | tonumber)} ];

# The last question asked in this reply: the tag wins for N, the larger M of tag and
# heading wins for M; null when the reply asked none.
def last_question($tags; $hs):
  ($tags | last) as $t
  | ($hs | map(select(.m != null)) | last) as $h
  | if $t != null then {n: $t.n, m: ([$t.m, ($h.m // 0)] | max)}
    elif $h != null then $h
    else null end;

# The Decision Table closes the series when it is the whole reply (no Question heading)
# and the last question asked was the last one (n >= m, or none tracked), or when the
# closing sections show the run ended early.
def closes_series($lines; $hs; $last):
  decision_table($lines)
  and ($hs | length) == 0
  and ($last == null or $last.n >= $last.m or closing_sections($lines));

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
     | (if $cseen then all_headings($lines) else [] end) as $hs
     | last_question($tags; $hs) as $asked
     | (if $cseen then revised_total($lines) else null end) as $rev
     | ((if $asked != null then $asked else .last end)
        | if . != null and $rev != null then .m = $rev else . end) as $last
     | (($e.tool_calls // []) | if type == "array" then any(.[]; type == "object" and .name == "ask_question") else false end) as $asks
     | (if $cseen and ($asks | not) then closes_series($lines; $hs; $last) else false end) as $closes
     | .pending += $hs
     | .last = (if $cseen and ($closes | not) then $last else null end)
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

# CLARIFY_HOOK_STRICT=1 (tests only) turns a jq failure into exit 3 instead of failing
# open, so a broken program cannot pass a "stays silent" test by accident.
strict_or_open() {
  [ -n "${CLARIFY_HOOK_STRICT:-}" ] && exit 3
  fail_open
}

output="$(jq -nrRc --arg sq "'" "$JQ_PROG" < "$transcript_path" 2>/dev/null)" || strict_or_open
[ -n "$output" ] || strict_or_open
printf '%s\n' "$output"
exit 0
