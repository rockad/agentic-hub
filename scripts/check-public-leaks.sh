#!/usr/bin/env bash
# Public-repo leak guard: this repository is public, so machine- and owner-specific
# identifiers must not be committed. Fails on:
#   - absolute home paths of real users: /home/<name>/ or /Users/<name>/
#     (placeholders such as /home/user, /Users/user, /home/runner are fine)
#   - agent transcript paths that embed a real conversation id: brain/<uuid>
#     (synthetic ids that start with 00000000- are fine)
#   - the owner's subscription plan tier ("Google AI Pro" / "Google AI Ultra")
#   - the owner's personal email handle and surname
# Justified exceptions go in scripts/public-leaks-allow.txt, one "path:matched-text"
# entry per line (see that file). Requires: rg (ripgrep). Portable across macOS and Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOW="$ROOT/scripts/public-leaks-allow.txt"

command -v rg >/dev/null 2>&1 || { echo "error: rg (ripgrep) is required (install it and retry)" >&2; exit 2; }

# Home-directory names that are placeholders, container users or the Windows shared
# folder (/Users/Public), not real people.
PLACEHOLDER_HOMES="user runner appuser x youruser Public"

cd "$ROOT"

RG_COMMON=(--no-heading --line-number --with-filename --only-matching --hidden
  -g '!.git' -g '!**/node_modules/**'
  -g '!scripts/check-public-leaks.sh' -g '!scripts/public-leaks-allow.txt')

errors=0

is_allowed() { # file match
  [ -f "$ALLOW" ] || return 1
  grep -qxF -- "$1:$2" <(grep -v '^[[:space:]]*\(#\|$\)' "$ALLOW")
}

report() { # file line match reason
  if is_allowed "$1" "$3"; then return 0; fi
  echo "LEAK: $1:$2: '$3' ($4)" >&2
  errors=$((errors + 1))
}

# 1. Absolute home paths of real users.
while IFS=: read -r file line match; do
  name="${match#/*/}"
  case " $PLACEHOLDER_HOMES " in *" $name "*) continue ;; esac
  report "$file" "$line" "$match" "real home path; use ~/ or /home/user"
done < <(rg "${RG_COMMON[@]}" -e '(/home|/Users)/[A-Za-z0-9._-]+' . | sed 's#^\./##' || true)

# 2. Transcript paths that embed a real conversation id.
while IFS=: read -r file line match; do
  case "${match#brain/}" in 00000000-*) continue ;; esac
  report "$file" "$line" "$match" "real conversation id; use 00000000-0000-4000-8000-... style ids"
done < <(rg "${RG_COMMON[@]}" -e 'brain/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}' . | sed 's#^\./##' || true)

# 3. Owner's plan tier.
while IFS=: read -r file line match; do
  report "$file" "$line" "$match" "plan tier; say 'Google AI subscription' instead"
done < <(rg "${RG_COMMON[@]}" -i -e 'google ai (pro|ultra)' . | sed 's#^\./##' || true)

# 4. Owner's personal email handle and surname (the GitHub slug "rockad/..." is fine).
while IFS=: read -r file line match; do
  report "$file" "$line" "$match" "owner identity"
done < <(rg "${RG_COMMON[@]}" -i -e '[A-Za-z0-9._-]*rockad@[A-Za-z0-9.-]+' -e 'akorolev' . | sed 's#^\./##' || true)

if [ "$errors" -gt 0 ]; then
  echo "Public leak check failed with $errors finding(s). Fix them, or add a justified entry to scripts/public-leaks-allow.txt." >&2
  exit 1
fi

echo "OK: no private identifiers found"
