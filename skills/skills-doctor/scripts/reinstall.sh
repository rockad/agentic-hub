#!/usr/bin/env bash
# Reinstall every skill recorded in the skills-lock files -- the project's
# skills-lock.json (cwd if it has one, else $DIGITAL_ASSISTANT_HOME) and the
# global ~/.agents/.skill-lock.json -- for one agent only, in symlink mode:
# canonical files under .agents/skills/, symlinks under .claude/skills/.
# A bare `npx skills` restore targets every universal agent, which is why
# this exists.
#
# Two `npx skills` (v1.5.x) quirks this script works around:
#  - The CLI forces copy mode when the install targets a single skills dir,
#    so the agent is paired with one universal agent (amp) whose dir IS the
#    canonical .agents/skills/ -- two distinct dirs flip it to symlink mode
#    without writing anything extra anywhere.
#  - The CLI reads stdin, so every call inside a read loop gets < /dev/null
#    or it swallows the rest of the source list.
#
# Usage: reinstall.sh [-n|--dry-run] [-a agent]
set -euo pipefail

AGENT="claude-code"
UNIVERSAL="amp"
DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--dry-run) DRY=1 ;;
    -a|--agent) AGENT="${2:?-a requires an agent name}"; shift ;;
    *) echo "usage: reinstall.sh [-n|--dry-run] [-a agent]" >&2; exit 2 ;;
  esac
  shift
done

JQ_EXPR='.skills | to_entries | group_by(.value.sourceUrl // .value.source) | .[]
    | (.[0].value.sourceUrl // .[0].value.source) + " " + (map("-s \(.key)") | join(" "))'

PROJECT_DIR="$PWD"
[[ -f "$PROJECT_DIR/skills-lock.json" ]] || PROJECT_DIR="${DIGITAL_ASSISTANT_HOME:-}"
GLOBAL_LOCK="$HOME/.agents/.skill-lock.json"

# Snapshot both locks BEFORE any removal -- remove rewrites them.
PROJ_LIST="$(mktemp)"
GLOB_LIST="$(mktemp)"
trap 'rm -f "$PROJ_LIST" "$GLOB_LIST"' EXIT

if [[ -n "$PROJECT_DIR" && -f "$PROJECT_DIR/skills-lock.json" ]]; then
  jq -r "$JQ_EXPR" "$PROJECT_DIR/skills-lock.json" > "$PROJ_LIST"
fi
if [[ -f "$GLOBAL_LOCK" ]]; then
  jq -r "$JQ_EXPR" "$GLOBAL_LOCK" > "$GLOB_LIST"
fi

if [[ ! -s "$PROJ_LIST" && ! -s "$GLOB_LIST" ]]; then
  echo "skills-doctor: no skills in ${PROJECT_DIR:-<no project>}/skills-lock.json or $GLOBAL_LOCK" >&2
  exit 1
fi

if (( DRY )); then
  [[ -s "$PROJ_LIST" ]] && echo "# project ($PROJECT_DIR): npx skills remove --all"
  while read -r src flags; do
    echo "npx skills add $src $flags -a $AGENT $UNIVERSAL -y"
  done < "$PROJ_LIST"
  [[ -s "$GLOB_LIST" ]] && echo "# global: npx skills remove --all -g"
  while read -r src flags; do
    echo "npx skills add $src $flags -g -a $AGENT $UNIVERSAL -y"
  done < "$GLOB_LIST"
  exit 0
fi

if [[ -s "$PROJ_LIST" ]]; then
  (
    cd "$PROJECT_DIR"
    npx skills remove --all < /dev/null
    while read -r src flags; do
      # shellcheck disable=SC2086  # flags must word-split into -s args
      npx skills add "$src" $flags -a "$AGENT" "$UNIVERSAL" -y < /dev/null
    done < "$PROJ_LIST"
  )
fi

if [[ -s "$GLOB_LIST" ]]; then
  npx skills remove --all -g < /dev/null
  while read -r src flags; do
    # shellcheck disable=SC2086
    npx skills add "$src" $flags -g -a "$AGENT" "$UNIVERSAL" -y < /dev/null
  done < "$GLOB_LIST"
fi
