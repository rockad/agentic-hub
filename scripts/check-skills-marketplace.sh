#!/usr/bin/env bash
# Drift guard: every skills/<name>/SKILL.md must be listed in
# .claude-plugin/marketplace.json as a plugin entry with source "./skills/<name>",
# and every such entry must point at a skill directory that exists.
# Requires: jq.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/.claude-plugin/marketplace.json"

command -v jq >/dev/null 2>&1 || { echo "error: jq is required (install it and retry)" >&2; exit 2; }
[ -f "$MANIFEST" ] || { echo "error: $MANIFEST not found" >&2; exit 2; }

errors=0

for skill_file in "$ROOT"/skills/*/SKILL.md; do
  [ -e "$skill_file" ] || continue
  name="$(basename "$(dirname "$skill_file")")"
  if ! jq -e --arg src "./skills/$name" '.plugins | any(.source == $src)' "$MANIFEST" >/dev/null; then
    echo "ERROR: skills/$name has a SKILL.md but no entry with source \"./skills/$name\" in .claude-plugin/marketplace.json" >&2
    errors=$((errors + 1))
  fi
done

while IFS= read -r src; do
  if [ ! -f "$ROOT/$src/SKILL.md" ]; then
    echo "ERROR: marketplace entry source \"$src\" has no SKILL.md" >&2
    errors=$((errors + 1))
  fi
done < <(jq -r '.plugins[] | .source | strings | select(startswith("./skills/"))' "$MANIFEST")

if [ "$errors" -gt 0 ]; then
  echo "Skills marketplace drift check failed with $errors error(s)." >&2
  exit 1
fi

count="$(jq '[.plugins[] | select((.source | type) == "string" and (.source | startswith("./skills/")))] | length' "$MANIFEST")"
echo "OK: $count standalone skill entries match skills/*/SKILL.md"
