#!/usr/bin/env bash
# Handoff drift reminder (SessionStart hook) — macOS / Linux
# SELF-LOCATING: derives the project from the session's cwd (read from the
# SessionStart JSON payload on stdin), finds HANDOFF.md by walking up from cwd,
# and checks whether any project file is newer than it.
#   * No hardcoded paths — register this hook ONCE, globally. It handles every
#     project automatically; a second /handoff in another project does NOT touch it.
#   * Silent when the current project has no HANDOFF.md, or when HANDOFF.md is newest.
#   * Self-clearing: once HANDOFF.md is saved, its mtime is newest -> silent again.
#
# SETUP: copy to ~/.claude/hooks/, chmod +x, and register ONE entry in
# ~/.claude/settings.json under hooks.SessionStart (append to the array; do not
# overwrite other hooks). Nothing inside needs editing — there are no placeholders.
set -euo pipefail

# SessionStart delivers a JSON payload on stdin that includes "cwd".
payload="$(cat 2>/dev/null || true)"
cwd="$(printf '%s' "$payload" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("cwd",""))
except Exception: print("")' 2>/dev/null || true)"
[ -n "${cwd:-}" ] || cwd="$PWD"   # fallback if payload lacks cwd

# Walk up from cwd to the nearest HANDOFF.md; that dir is the project root.
dir="$cwd"; HANDOFF=""; PROJECT_DIR=""
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if [ -f "$dir/HANDOFF.md" ]; then HANDOFF="$dir/HANDOFF.md"; PROJECT_DIR="$dir"; break; fi
  dir="$(dirname "$dir")"
done
[ -n "$HANDOFF" ] || exit 0       # no handoff in this project -> silent

# Newest project file, excluding noise dirs and the handoff itself.
# TO NARROW (fewer false positives): replace the find with an explicit file list.
# Portable: -print + sed basename works on both BSD find (macOS) and GNU find (Linux).
newest=$(find "$PROJECT_DIR" -type f \
  -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/dist/*' \
  -not -path '*/build/*' -not -path '*/.next/*' -not -path '*/target/*' \
  -not -path '*/__pycache__/*' -not -path '*/.venv/*' \
  -not -name 'HANDOFF.md' -newer "$HANDOFF" -print 2>/dev/null | sed 's#.*/##' | head -6 | paste -sd ', ' -)

[ -z "$newest" ] && exit 0        # no drift -> silent

msg="REMINDER (handoff drift): HANDOFF.md is older than project files: ${newest}. If this session did substantive work, refresh HANDOFF.md before ending the block while context is fresh -- append a new step to the chronology (do not rewrite prior ones), and update sections 1/3/5/6/9. After saving, its mtime becomes newest and this reminder goes silent. This is a backstop -- the semantic update is on you; the hook only detects drift."

# Emit SessionStart additionalContext as compact JSON (python3 for safe escaping).
python3 -c 'import json,sys; print(json.dumps({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":sys.argv[1]}}))' "$msg"
exit 0
