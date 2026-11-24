#!/usr/bin/env bash
# test-check-public-leaks.sh - self-test of the A2A API key rule in scripts/check-public-leaks.sh.
#
# Each case copies the guard into a throwaway tree (the guard scans the tree it lives in), plants a
# file and runs it. The planted keys are assembled at run time from parts, so this file never holds a
# string of the real key shape (the guard would flag this very file, and so would gitleaks).
#
# Checks:
#   - a real-shape key fails the guard, with file:line and the redacted form
#   - the planted secret and key id are never echoed (stdout or stderr), in any case
#   - an uppercase-hex id, a 42-character secret and the short placeholders do not match
#   - a secret that starts with FAKE- passes
#   - an allowlist entry does not excuse a key
#   - a tree without any key is OK
#
# Requires: bash, rg. Exits non-zero when any case fails.
# shellcheck disable=SC2015  # `test && ok || bad`: ok never fails
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
guard="$root/scripts/check-public-leaks.sh"
command -v rg >/dev/null 2>&1 || { echo "rg is required" >&2; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }

# Parts of keys, joined only at run time.
P="a2ak"
SECRET43="Zq9XvT3mNpL0aBcDeFgHiJkLmNoPqRsTuV-w_xY4zAb"   # 43 chars, not a real key
SECRET42="${SECRET43%?}"
ID="3f9c01ab"
key() { printf '%s_%s_%s_%s' "$P" "$1" "$2" "$3"; } # env id secret
keyln() { key "$@"; echo; }

# tree <name>: a fresh copy of the guard in $tmp/<name> (stdout: the path)
tree() {
  local d="$tmp/$1"
  mkdir -p "$d/scripts"
  cp "$guard" "$d/scripts/check-public-leaks.sh"
  printf '%s\n' "# empty" > "$d/scripts/public-leaks-allow.txt"
  echo "$d"
}

# run <dir>: run the guard in that tree with no local private patterns; sets OUT (stdout+stderr) and RC
run() {
  OUT="$(HOME="$tmp/nohome" PUBLIC_LEAKS_PRIVATE_PATTERNS=/nonexistent bash "$1/scripts/check-public-leaks.sh" 2>&1)"
  RC=$?
}

# never_echoes <secret...>: OUT contains none of the given strings
never_echoes() {
  local s
  for s in "$@"; do
    case "$OUT" in *"$s"*) return 1 ;; esac
  done
  return 0
}

# 1. A real-shape key fails, with file:line and the redacted form, and is never echoed.
d="$(tree plant)"
mkdir -p "$d/docs"
printf 'line one\nAuthorization: Bearer %s\n' "$(key dev "$ID" "$SECRET43")" > "$d/docs/notes.md"
run "$d"
[ "$RC" = 1 ] && ok "plant fails the guard" || bad "plant: expected exit 1, got $RC"
case "$OUT" in *"docs/notes.md:2:"*) ok "plant reports file and line" ;; *) bad "plant: no docs/notes.md:2 in output" ;; esac
case "$OUT" in *"a2ak_dev_xxxx_<redacted>"*) ok "plant is shown redacted" ;; *) bad "plant: no redacted form in output" ;; esac
never_echoes "$SECRET43" "${SECRET43:0:12}" "$ID" "$(key dev "$ID" "")" \
  && ok "plant: secret and key id never echoed" || bad "plant: the secret or the key id was echoed"

# 1b. A live env key in another file type, and a secret with - and _ in it.
d="$(tree plant-live)"
printf '{"k": "%s"}\n' "$(key live "$ID" "$SECRET43")" > "$d/config.json"
run "$d"
[ "$RC" = 1 ] && ok "live key fails the guard" || bad "live key: expected exit 1, got $RC"
case "$OUT" in *"a2ak_live_xxxx_<redacted>"*) ok "live key redacted with its env" ;; *) bad "live key: no redacted form" ;; esac
never_echoes "$SECRET43" "$ID" && ok "live key never echoed" || bad "live key: echoed"

# 2. Placeholders and near misses pass.
d="$(tree placeholders)"
{
  echo 'Authorization: Bearer a2ak_REPLACE_WITH_YOUR_KEY'
  echo 'shown as a2ak_<hidden>'
  echo 'a2ak_<env>_<keyid>_<secret>'
  echo 'a2ak_dev_k1_SECRETSECRETSECRET'
  keyln test deadbeef SECRET
  keyln dev 3F9C01AB "$SECRET43"       # uppercase id: not the real shape
  keyln dev "$ID" "$SECRET42"          # 42 characters: not the real shape
  keyln Dev "$ID" "$SECRET43"          # uppercase env: not the real shape
  keyln dev "$ID" "FAKE-${SECRET43:5}" # FAKE- marker
} > "$d/README.md"
run "$d"
[ "$RC" = 0 ] && ok "placeholders pass" || { bad "placeholders: expected exit 0, got $RC"; printf '    %s\n' "$OUT"; }

# 3. An allowlist entry does not excuse a key.
d="$(tree allow)"
planted="$(key dev "$ID" "$SECRET43")"
printf '%s\n' "$planted" > "$d/example.txt"
printf '%s\n' "example.txt:$planted" > "$d/scripts/public-leaks-allow.txt"
run "$d"
[ "$RC" = 1 ] && ok "allowlist entry does not excuse a key" || bad "allowlist: expected exit 1, got $RC"
never_echoes "$SECRET43" && ok "allowlisted plant never echoed" || bad "allowlisted plant echoed"

# 4. A clean tree is OK and the guard still catches the old rules.
d="$(tree clean)"
echo 'nothing here' > "$d/a.txt"
run "$d"
[ "$RC" = 0 ] && ok "clean tree passes" || bad "clean tree: expected exit 0, got $RC"
d="$(tree oldrule)"
printf '%s\n' "/home/$(printf 'rea%s' 'lperson')/x" > "$d/a.txt"
run "$d"
[ "$RC" = 1 ] && ok "existing home-path rule still fails" || bad "home-path rule: expected exit 1, got $RC"

[ "$fails" = 0 ] && { echo "all cases passed"; exit 0; }
echo "$fails case(s) failed" >&2
exit 1
