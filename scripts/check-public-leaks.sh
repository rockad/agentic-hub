#!/usr/bin/env bash
# Public-repo leak guard: this repository is public, so machine- and owner-specific
# identifiers must not be committed. Fails on:
#   - absolute home paths of real users: /home/<name>/, /Users/<name>/ or C:\Users\<name>
#     (placeholders such as /home/user, /Users/user, /home/runner are fine)
#   - agent transcript paths that embed a real conversation id: brain/<uuid>
#   - full conversation ids passed to `--conversation` or written as conversation id / conversationId
#     (synthetic ids that start with 00000000- are fine)
#   - the owner's subscription plan tier ("Google AI Pro/Ultra", "Claude Pro/Max")
#   - the owner's personal email handle and surname
#   - an A2A API key of the real shape a2ak_<env>_<8 hex>_<43 base64url> (auth/keys.py). The finding is
#     printed redacted (a2ak_dev_xxxx_<redacted>), never the key. A secret that starts with FAKE- is a
#     placeholder by construction and passes; short placeholders (a2ak_<hidden>, a2ak_dev_k1_SECRET)
#     are not the real shape and never match. This rule is never satisfied by an allowlist entry (an
#     entry would have to contain the key): use the FAKE- marker. .gitleaks.toml mirrors the rule.
# Justified exceptions go in scripts/public-leaks-allow.txt, one "path:matched-text"
# entry per line (see that file). Requires: rg (ripgrep). Portable across macOS and Linux.
# An rg runtime or regex error fails the guard (it never passes silently).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOW="$ROOT/scripts/public-leaks-allow.txt"

command -v rg >/dev/null 2>&1 || { echo "error: rg (ripgrep) is required (install it and retry)" >&2; exit 2; }

# Home-directory names that are placeholders, container users or the Windows shared
# folder (/Users/Public), not real people.
PLACEHOLDER_HOMES="user runner appuser x youruser Public"

cd "$ROOT"

RG_COMMON=(--no-heading --line-number --with-filename --only-matching --hidden --null
  -g '!.git' -g '!**/node_modules/**'
  -g '!scripts/check-public-leaks.sh' -g '!scripts/public-leaks-allow.txt')

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

errors=0
allowlistable_errors=0
REDACT=0 # 1 while the key rule runs: report() then prints a redacted form, never the match

# a2ak_dev_3f9c01ab_<43 chars> -> a2ak_dev_xxxx_<redacted> (keeps the env, drops the id and the secret)
redact_key() {
  local env="${1#a2ak_}"
  echo "a2ak_${env%%_*}_xxxx_<redacted>"
}

is_allowed() { # file match
  [ -f "$ALLOW" ] || return 1
  grep -qxF -- "$1:$2" <(grep -v '^[[:space:]]*\(#\|$\)' "$ALLOW")
}

report() { # file line match reason
  local shown="$3"
  if [ "$REDACT" = 1 ]; then
    shown="$(redact_key "$3")" # the key rule is never excused by an allowlist entry
  elif is_allowed "$1" "$3"; then
    return 0
  else
    allowlistable_errors=$((allowlistable_errors + 1))
  fi
  echo "LEAK: $1:$2: '$shown' ($4)" >&2
  errors=$((errors + 1))
}

# scan <reason> <skip-fn> <rg args...>: run rg, fail hard on an rg error (exit 2), and
# report every match for which <skip-fn> (a function taking the matched text) is false.
# rg --null prints "<path>\0<line>:<match>\n", so file names containing ':' parse correctly.
scan() {
  local reason="$1" skip="$2" rc=0 file rest line match
  shift 2
  rg "${RG_COMMON[@]}" "$@" . > "$TMP" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "error: rg failed (exit $rc) while scanning for: $reason" >&2
    exit 2
  fi
  while IFS= read -r -d '' file && IFS= read -r rest; do
    file="${file#./}"
    line="${rest%%:*}"
    match="${rest#*:}"
    if [ -n "$skip" ] && "$skip" "$match"; then continue; fi
    report "$file" "$line" "$match" "$reason"
  done < "$TMP"
}

skip_placeholder_home() { # matched text of check 1
  local name="$1"
  case "$name" in
    /home/*|/Users/*) name="${name#/*/}" ;;
    *) name="${name##*[Uu]sers\\}" ;;
  esac
  case " $PLACEHOLDER_HOMES " in *" $name "*) return 0 ;; esac
  return 1
}

skip_synthetic_uuid() { # matched text of checks 2 and 3: skip ids starting 00000000-
  local m="$1"
  [[ "$m" =~ [0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] || return 1
  case "${BASH_REMATCH[0]}" in 00000000-*) return 0 ;; esac
  return 1
}

UUID='[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'

# 1. Absolute home paths of real users (POSIX and Windows forms).
scan "real home path; use ~/ or /home/user" skip_placeholder_home \
  -e '(/home|/Users)/[A-Za-z0-9._-]+' \
  -e '[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+'

# 2. Transcript paths that embed a real conversation id.
scan "real conversation id; use 00000000-0000-4000-8000-... style ids" skip_synthetic_uuid \
  -e "brain/$UUID"

# 3. Full conversation ids: `--conversation <uuid>`, `conversation_id: <uuid>`, `conversationId="<uuid>"`.
scan "real conversation id; use 00000000-0000-4000-8000-... style ids" skip_synthetic_uuid \
  -i -e "--conversation[ =]+$UUID" \
  -e "conversation[ _-]?id[\"'\`]?[ \t]*[:=]?[ \t]*[\"'\`]?$UUID"

# 4. Owner's plan tier.
scan "plan tier; say 'Google AI subscription' or 'Claude subscription' instead" "" \
  -i -e 'google ai (pro|ultra)' -e 'claude (pro|max)( plan| account| subscription)?\b'

# 4b. A2A API keys of the real shape (auth/keys.py: a2ak_<env a-z 1-8>_<key id 8 hex>_<secret 43 base64url>).
#     A secret that starts with FAKE- is a placeholder; no allowlist entry can excuse a key (see the header).
skip_fake_key() { # matched text: a2ak_<env>_<8 hex>_<secret>
  local secret="${1#a2ak_*_????????_}"
  case "$secret" in FAKE-*) return 0 ;; esac
  return 1
}
REDACT=1
scan "A2A API key (real shape); use a2ak_REPLACE_WITH_YOUR_KEY or a FAKE- secret in examples" skip_fake_key \
  -e 'a2ak_[a-z]{1,8}_[0-9a-f]{8}_[A-Za-z0-9_-]{43}'
REDACT=0

# 5. Personal identifiers that must not themselves be published in this script:
#    one regex per line in a local, untracked file (absent in CI, so this check is skipped there).
PRIVATE_PATTERNS="${PUBLIC_LEAKS_PRIVATE_PATTERNS:-$HOME/.config/public-leaks/patterns.txt}"
if [ -s "$PRIVATE_PATTERNS" ]; then
  scan "personal identifier (local pattern list)" "" -i -f "$PRIVATE_PATTERNS"
fi

if [ "$errors" -gt 0 ]; then
  if [ "$allowlistable_errors" -gt 0 ]; then
    echo "Public leak check failed with $errors finding(s). Fix them, or add a justified entry to scripts/public-leaks-allow.txt." >&2
  else
    echo "Public leak check failed with $errors finding(s). Fix them (A2A API keys cannot be allowlisted; use a FAKE- placeholder)." >&2
  fi
  exit 1
fi

echo "OK: no private identifiers found"
