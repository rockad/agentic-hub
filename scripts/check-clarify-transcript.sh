#!/usr/bin/env bash
# check-clarify-transcript.sh - check a Claude Code session transcript (JSONL)
# for whether the `clarify` skill asked its questions properly.
#
# Requires: bash, jq. No Python.
#
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
# Exit codes: 0 all checked questions pass, 1 at least one failure,
#             2 no clarify questions found, 3 usage or input error.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: check-clarify-transcript.sh [--min-desc N] <transcript.jsonl>

Check a Claude Code session transcript for clarify-skill question quality.

Options:
  --min-desc N   minimum option description length in characters (default 120)
  -h, --help     show this help

Rules per Fork/Q question: (1) "## Question N" prose before the call, (2) every
option description >= --min-desc chars, (3) every option has a preview, (4) M
constant within a series unless "Fork map revised". Rule 5 is a warning only:
the last non-empty line of each preview should start with "→ next:".

Output: one line per checked question ("PASS Fork N/M" or "FAIL Fork N/M: reasons"),
each followed by any "WARN Fork N/M: preview without '→ next:' line (<label>)"
lines, then a summary line "checked=X failed=Y warned=Z". Warnings never change
the exit code.

Exit codes: 0 all pass, 1 any failure, 2 no clarify questions found, 3 usage error.
EOF
}

min_desc=120
file=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
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
case "$min_desc" in
  ''|*[!0-9]*) echo "error: --min-desc must be a non-negative integer" >&2; exit 3 ;;
esac
command -v jq >/dev/null 2>&1 || { echo "error: jq is not installed (install it, then re-run)" >&2; exit 3; }

# shellcheck disable=SC2016  # the jq program is single-quoted on purpose
JQ_PROG='
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

result="$(jq -nrR --argjson min "$min_desc" --arg sq "'" "$JQ_PROG" < "$file")" || {
  echo "error: jq failed while parsing $file" >&2
  exit 3
}

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
