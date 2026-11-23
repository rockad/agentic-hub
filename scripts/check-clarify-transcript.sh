#!/usr/bin/env bash
# check-clarify-transcript.sh - check a Claude Code or Antigravity session
# transcript (JSONL) for whether the `clarify` skill asked its questions properly.
#
# Requires: bash, jq. No Python.
#
# Formats:
#   auto         (default) detect Antigravity if any JSONL object has
#                .type == "PLANNER_RESPONSE" or "USER_INPUT", else Claude Code
#   claude       Claude Code session transcript (AskUserQuestion / Fork N/M)
#   antigravity  Antigravity session transcript (PLANNER_RESPONSE / ask_question)
#
# Claude Code mode (--format claude):
# For every AskUserQuestion call whose first question has a header matching
# "Fork N/M" (or "Q N/M"; spaces around the slash are tolerated), it checks:
#   1. The assistant text since the last user/tool_result line contains
#      "## Question N" (N from the header).
#   2. Every option description is at least --min-desc characters (default 120).
#   3. Every option has a non-empty preview.
#   4. Within a series (consecutive Fork questions; a new series starts when
#      N == 1) M stays constant, unless the assistant text since the previous
#      Fork question contains "Fork map revised".
#   5. WARNING only (not a failure, no effect on the exit code): the last
#      non-empty line of every non-empty option preview should start with
#      "→ next:".
# AskUserQuestion calls without a Fork/Q header are ignored.
#
# Antigravity mode (--format antigravity):
# Tracks reply windows across consecutive PLANNER_RESPONSE records until the
# next USER_INPUT or ask_question boundary, and checks:
#   1. Every clarify "## Question N" heading in a reply segment is followed by an
#      ask_question call in the same reply segment.
#   2. ask_question questions[0].question starts with [Question N of M] or
#      [Fork N of M] and matches any preceding "## Question N (of M)" heading.
#   3. Every option in questions[0].options starts with "(Recommended) Option X:"
#      or "Option X:".
#   4. Within a series (N != 1), M stays constant unless "Fork map revised"
#      appeared since the previous clarify question.
#   5. WARNING only: ask_question with [Question/Fork N of M] without
#      "## Question N" prose in the same reply segment.
# The session ends, as in the Stop hook, when the user abandons the series: an explicit
# cancel or a different slash command after the last question (issue #82).
#
# Exit codes: 0 all checked questions pass, 1 at least one failure,
#             2 no clarify questions found, 3 usage or input error.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: check-clarify-transcript.sh [--format auto|claude|antigravity] [--min-desc N] <transcript.jsonl>

Check a Claude Code or Antigravity session transcript for clarify-skill question quality.

Options:
  --format FMT   transcript format: auto, claude, or antigravity (default auto)
  --min-desc N   minimum option description length in characters for Claude Code (default 120)
  -h, --help     show this help

Claude Code rules per Fork/Q question: (1) "## Question N" prose before the
call, (2) every option description >= --min-desc chars, (3) every option has a
preview, (4) M constant within a series unless "Fork map revised". Rule 5 is a
warning only: the last non-empty line of each preview should start with "→ next:".

Antigravity rules per clarify reply: (1) every clarify "## Question N" heading
is paired with an ask_question call in the same reply, (2) questions[0].question
starts with [Question N of M] or [Fork N of M] matching the heading, (3) every
option starts with "(Recommended) Option X:" or "Option X:", (4) M constant
within a series unless "Fork map revised". Rule 5 is a warning only:
ask_question without "## Question N" prose in the same reply.

Output: one line per checked question ("PASS ..." or "FAIL ...: reasons"),
each followed by any "WARN ..." lines, then a summary line
"checked=X failed=Y warned=Z". Warnings never change the exit code.

Exit codes: 0 all pass, 1 any failure, 2 no clarify questions found, 3 usage/input/jq error.
EOF
}

format="auto"
min_desc=120
file=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --format)
      [ $# -ge 2 ] || { echo "error: --format needs a value" >&2; usage >&2; exit 3; }
      format="$2"; shift 2 ;;
    --format=*) format="${1#*=}"; shift ;;
    --min-desc)
      [ $# -ge 2 ] || { echo "error: --min-desc needs a value" >&2; usage >&2; exit 3; }
      min_desc="$2"; shift 2 ;;
    --min-desc=*) min_desc="${1#*=}"; shift ;;
    -*) echo "error: unknown option: $1" >&2; usage >&2; exit 3 ;;
    *)
      [ -z "$file" ] || { echo "error: only one transcript path is accepted" >&2; usage >&2; exit 3; }
      file="$1"; shift ;;
  esac
done

[ -n "$file" ] || { echo "error: missing transcript path" >&2; usage >&2; exit 3; }
[ -r "$file" ] || { echo "error: cannot read: $file" >&2; exit 3; }
case "$format" in
  auto|claude|antigravity) ;;
  *) echo "error: --format must be auto, claude, or antigravity" >&2; exit 3 ;;
esac
case "$min_desc" in
  ''|*[!0-9]*) echo "error: --min-desc must be a non-negative integer" >&2; exit 3 ;;
esac
command -v jq >/dev/null 2>&1 || { echo "error: jq is not installed (install it, then re-run)" >&2; exit 3; }

if [ "$format" = "auto" ]; then
  format="$(jq -nrR 'any(inputs | fromjson? | select(type == "object"); .type == "PLANNER_RESPONSE" or .type == "USER_INPUT") | if . then "antigravity" else "claude" end' < "$file")" || {
    echo "error: jq failed while detecting format for $file" >&2
    exit 3
  }
fi

# shellcheck disable=SC2016  # the jq program is single-quoted on purpose
JQ_PROG_CLAUDE='
def hdr: [ (. // "") | capture("^\\s*(?<k>Fork|Q)\\s*(?<n>[0-9]+)\\s*/\\s*(?<m>[0-9]+)"; "i") ][0];
def blank: ((. // "") | tostring | gsub("\\s"; "")) == "";
def items: (.message.content // []) | if type == "array" then . else [] end;

def check($line; $in; $st):
  ($in.questions // []) as $qs
  | ($qs[0].header | hdr) as $h
  | if $h == null then $st
    else
      ($h.n | tonumber) as $n
      | ($h.m | tonumber) as $m
      | "\($h.k) \($n)/\($m)" as $name
      | ( [ if ($st.text | test("##\\s*Question\\s+\($n)(\\D|$)")) then empty
            else "no step prose before \($name)" end ]
        + [ $qs[] | (.options // [])[]
            | ((.description // "") | length) as $len
            | select($len < $min)
            | "description too short (\(.label // "?"): \($len) < \($min))" ]
        + [ $qs[] | (.options // [])[]
            | select(.preview | blank)
            | "empty preview (\(.label // "?"))" ]
        + [ if $st.prev != null and $n != 1 and $st.prev != $m
                and ($st.rev | test("Fork map revised") | not)
            then "M changed from \($st.prev) to \($m) without \"Fork map revised\""
            else empty end ]
        ) as $why
      | [ $qs[] | (.options // [])[]
          | select((.preview | blank) | not)
          | select((.preview | split("\n") | map(select(test("\\S"))) | last // "")
                   | test("^\\s*→ next:") | not)
          | "WARN \($name): preview without \($sq)→ next:\($sq) line (\(.label // "?"))" ] as $warn
      | $st
      | .checked += 1
      | .failed += (if ($why | length) > 0 then 1 else 0 end)
      | .warned += ($warn | length)
      | .out += [ if ($why | length) > 0
                  then "FAIL \($name): \($why | join("; ")) (line \($line))"
                  else "PASS \($name) (line \($line))" end ] + $warn
      | .prev = $m
      | .rev = ""
    end;

reduce (inputs | fromjson? | select(type == "object")) as $e
  ({line: 0, text: "", rev: "", prev: null, checked: 0, failed: 0, warned: 0, out: []};
   .line += 1
   | if $e.type == "user" then .text = ""
     elif $e.type == "assistant" then
       reduce ($e | items[]) as $c (.;
         if $c.type == "text" then
           .text += (($c.text // "") + "\n") | .rev += (($c.text // "") + "\n")
         elif $c.type == "tool_use" and $c.name == "AskUserQuestion" then
           check(.line; ($c.input // {}); .)
         else . end)
     else . end)
| (.out[], "checked=\(.checked) failed=\(.failed) warned=\(.warned)")
'

# shellcheck disable=SC2016  # the jq program is single-quoted on purpose
JQ_PROG_ANTIGRAVITY='
def str: if type == "string" then . else "" end;
def optstr: if type == "string" then . else (.label // "" | tostring) end;
def qtag: [ (. // "") | capture("^\\s*\\[\\s*(?<k>Question|Fork)\\s+(?<n>[0-9]+)\\s+of\\s+(?<m>[0-9]+)\\s*\\]"; "i") ][0];
def parse_qs:
  ((.args? // {}) | .questions? | if type == "string" then (fromjson? // []) elif type == "array" then . else [] end)
  | if type == "array" then . else [] end;
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

# The text of a user turn: the <USER_REQUEST> block when the harness wraps one (the skill
# body and metadata around it are not what the user typed), else the whole content.
def user_text:
  str | (([capture("<USER_REQUEST>\\s*(?<t>[\\s\\S]*?)(?:\\s*</USER_REQUEST>|\\n<truncated )")][0].t) // .);

# The first answer line of an ask_question result ("A1: ...", also for a write-in).
def answer_text:
  str | ([ split("\n")[] | capture("^A[0-9]+:[ \\t]*(?<t>.*)$") | .t ][0] // "");

# Whether a tool result carries an ask_question answer line (an empty "A1: " counts: that
# is the picker skipped with Esc).
def has_answer:
  str | test("(^|\\n)A[0-9]+:[ \\t]*");

# A message that leaves the series: it opens with an explicit cancel phrase that ends the
# sentence (or leads into a new request), or it is a different slash command. Anchored at
# the start so "never mind the cost, go with A" and "stop using Redis" stay answers.
def abandons:
  (str | ascii_downcase | sub("^\\s+"; "") | sub("^a[0-9]+:\\s*"; "")) as $t
  | ($t | test("^(?:(?:ok|okay|no|hmm|actually|wait|sorry|please|hey)[,.!:]?\\s+)*(?:forget (?:that|it|this|about it|all that)|never ?mind|cancel(?: (?:that|it|this|clarify|the (?:clarify|interview|questions)))?|abort(?: (?:that|it|this|clarify|the (?:clarify|interview|questions)))?|stop(?: (?:asking|this|it|clarify|the (?:clarify|interview|questions)))?|let.?s stop(?: (?:here|this|now))?|i.?m done(?: (?:here|with this))?|that.?s enough|no more questions|(?:skip|exit|quit|leave|abandon) (?:clarify|the (?:clarify|interview|questions)|this))(?:\\s*$|\\s*[.!;]|\\s*,\\s*(?:and |then |please |let.?s |now |instead |just |write |give |show |tell |make |can you |could you |i want |i.?d )|\\s+(?:and|then|please|now|instead)\\b)"))
    or (($t | test("^/[a-z][a-z0-9:_-]*(?:\\s|$)")) and ($t | clarify_cmd | not));

# The Decision Table closes the series when it is the whole reply (no Question heading)
# and the last question asked was the last one (n >= m, or none tracked), or when the
# closing sections show the run ended early.
def closes_series($lines; $hs; $last):
  decision_table($lines)
  and ($hs | length) == 0
  and ($last == null or $last.n >= $last.m or closing_sections($lines));

def flush_headings:
  if (.headings | length) == 0 then .
  else
    reduce .headings[] as $h (.;
      ($h.n | tostring) as $ns
      | (if $h.m != null then "\($ns)/\($h.m)" else $ns end) as $lbl
      | .checked += 1
      | .failed += 1
      | .out += ["FAIL Question \($lbl): no ask_question call in same reply (step \($h.step))"]
    )
    | .headings = []
  end;

def flush_prior_headings:
  if (.headings | length) <= 1 then .
  else
    reduce .headings[0:-1][] as $h (.;
      ($h.n | tostring) as $ns
      | (if $h.m != null then "\($ns)/\($h.m)" else $ns end) as $lbl
      | .checked += 1
      | .failed += 1
      | .out += ["FAIL Question \($lbl): no ask_question call in same reply (step \($h.step))"]
    )
    | .headings = [.headings[-1]]
  end;

def check_ask($step; $tc; $st):
  ($tc | parse_qs) as $qs
  | (($qs[0].question? // "") | qtag) as $qt
  | if (($st.headings | length) == 0) and ($qt == null) then
      $st | .text = "" | .headings = []
    else
      ($st | flush_prior_headings) as $st1
      | (if ($st1.headings | length) > 0 then $st1.headings[0] else null end) as $hd
      | (if $qt != null then ($qt.n | tonumber) elif $hd != null then $hd.n else null end) as $n
      | (if $qt != null then ($qt.m | tonumber) elif $hd != null then $hd.m else null end) as $m
      | (if $n != null and $m != null then "Question \($n)/\($m)"
         elif $n != null then "Question \($n)"
         else "Question ?" end) as $name
      | ( [ if $qt == null then
              "question missing [Question N of M] / [Fork N of M] prefix"
            else empty end ]
        + [ if $qt != null and $hd != null then
              (if $hd.n != ($qt.n | tonumber) then
                "heading Question \($hd.n) does not match tag N=\($qt.n)"
               else empty end),
              (if $hd.m != null and $hd.m != ($qt.m | tonumber) then
                "heading (of \($hd.m)) does not match tag M=\($qt.m)"
               else empty end)
            else empty end ]
        + [ ($qs[0].options? // []) | if type == "array" then .[] else empty end
            | optstr as $opt
            | select($opt | test("^\\s*(\\(Recommended\\)\\s+)?Option\\s+[A-Z]\\s*:") | not)
            | "option missing Option X: prefix (\($opt[0:60]))" ]
        + [ if $st1.prev != null and $n != null and $m != null and $n != 1 and $st1.prev != $m
                and ($st1.rev | test("Fork map revised") | not)
            then "M changed from \($st1.prev) to \($m) without \"Fork map revised\""
            else empty end ]
        ) as $why
      | ( [ if $qt != null and ($st1.text | test("##\\s*Question\\s+\($n)(\\D|$)") | not) then
              "WARN \($name): ask_question without \"## Question \($n)\" prose in same reply (step \($step))"
            else empty end ]
        ) as $warn
      | $st1
      | .checked += 1
      | .failed += (if ($why | length) > 0 then 1 else 0 end)
      | .warned += ($warn | length)
      | .out += [ if ($why | length) > 0
                  then "FAIL \($name): \($why | join("; ")) (step \($step))"
                  else "PASS \($name) (step \($step))" end ] + $warn
      | .prev = (if $m != null then $m else .prev end)
      | .rev = ""
      | .text = ""
      | .headings = []
    end;

reduce (inputs | fromjson? | select(type == "object")) as $e
  ({line: 0, text: "", rev: "", prev: null, clarify_seen: false, last: null, awaiting: false, headings: [], checked: 0, failed: 0, warned: 0, out: []};
   .line += 1
   | (if $e.step_index != null then $e.step_index else .line end) as $step
   | if $e.type == "USER_INPUT" then
       ($e.content | str) as $ucontent
       | flush_headings
       | .text = ""
       | .awaiting = false
       | (if ($ucontent | user_text | abandons) then .clarify_seen = false | .last = null
          elif ($ucontent | clarify_cmd) then .clarify_seen = true | .last = null
          else . end)
     elif $e.type == "GENERIC" and .awaiting and ($e.content | has_answer) then
       .awaiting = false
       | (if ($e.content | answer_text | (. == "" or abandons)) then .clarify_seen = false | .last = null else . end)
     elif $e.type == "PLANNER_RESPONSE" then
       ($e.content | str) as $content
       | ($content | outside_fences) as $lines
       | ask_tags($e) as $tags
       | (.clarify_seen or has_trigger($lines) or ($tags | length) > 0) as $cseen
       | (if $cseen then all_headings($lines) else [] end) as $hs
       | last_question($tags; $hs) as $asked
       | (if $cseen then revised_total($lines) else null end) as $rev
       | ((if $asked != null then $asked else .last end)
          | if . != null and $rev != null then .m = $rev else . end) as $last
       | (($e.tool_calls // []) | if type == "array" then any(.[]; type == "object" and .name == "ask_question") else false end) as $asks
       | (if $cseen and ($asks | not) then closes_series($lines; $hs; $last) else false end) as $closes
       | (if $content != "" then
            .text += ($content + "\n")
            | .rev += ($content + "\n")
            | .headings += ($hs | map(. + {step: $step}))
          else . end)
       | .last = (if $cseen and ($closes | not) then $last else null end)
       | .clarify_seen = ($cseen and ($closes | not))
       | .awaiting = $asks
       | reduce (($e.tool_calls // []) | if type == "array" then .[] else empty end | select(type == "object" and .name == "ask_question")) as $tc (.;
           check_ask($step; $tc; .)
         )
     else . end)
| flush_headings
| (.out[], "checked=\(.checked) failed=\(.failed) warned=\(.warned)")
'

if [ "$format" = "antigravity" ]; then
  result="$(jq -nrR --arg sq "'" "$JQ_PROG_ANTIGRAVITY" < "$file")" || {
    echo "error: jq failed while parsing $file" >&2
    exit 3
  }
else
  result="$(jq -nrR --argjson min "$min_desc" --arg sq "'" "$JQ_PROG_CLAUDE" < "$file")" || {
    echo "error: jq failed while parsing $file" >&2
    exit 3
  }
fi

printf '%s\n' "$result"

summary="$(printf '%s\n' "$result" | tail -n 1)"
checked="${summary#checked=}"; checked="${checked%% *}"
failed="${summary##*failed=}"; failed="${failed%% *}"

if [ "$checked" -eq 0 ]; then
  exit 2
elif [ "$failed" -gt 0 ]; then
  exit 1
fi
exit 0
