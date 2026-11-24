#!/usr/bin/env bash
# check-clarify-skill.sh - guard for the clarify skill.
#
# 1. SKILL.md stays under a line cap and a word cap, so the core skill cannot quietly grow back.
# 2. The strings that the Stop hook, the transcript checker and the references
#    depend on are still present in SKILL.md or its references.
#
# Requires: bash, grep, wc. Exits 1 on any miss.

# shellcheck disable=SC2016  # anchors hold literal backticks on purpose
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/plugins/clarify/skills/clarify"
core="$dir/SKILL.md"
cap="${CLARIFY_LINE_CAP:-170}"
word_cap="${CLARIFY_WORD_CAP:-2300}"
fail=0
body="$(mktemp)"
trap 'rm -f "$body"' EXIT
# The body is SKILL.md without its frontmatter, so routing rules cannot be satisfied by it.
awk '/^---$/ { c++; next } c >= 2' "$core" > "$body"

lines="$(wc -l < "$core")"
if [ "$lines" -gt "$cap" ]; then
  echo "FAIL: plugins/clarify/skills/clarify/SKILL.md has $lines lines, cap is $cap (add a rule once, or move text to references/)" >&2
  fail=1
fi

# anchor|scope (core = SKILL.md, body = SKILL.md without frontmatter, any = SKILL.md or a reference)
anchors=(
  'Target resolved:|core'
  'Identified N orthogonal|core'
  'Fork map revised: N → M|core'
  '## Question N (of Total)|core'
  '[Question N of Total]|core'
  'Fork N/Total|core'
  'Option A: |core'
  '(Recommended)|core'
  '→ next:|core'
  'Same-Reply Invariant|core'
  'Per-fork invariant|core'
  'Option naming rule|core'
  'Counter prefix rule|core'
  'full step is the required content|core'
  "Concise's own rule|core"
  'Turn-1 single-reply invariant|core'
  'not a reason to skip the next step|core'
  'even when the answer arrived as a tool result|core'
  '"multiSelect": false|core'
  'never under 120|core'
  '→ next: full Question N+1 write-up, then ask|core'
  'Option X:|core'
  'plain english|body'
  '/clarify eli5|body'
  'cplain|body'
  'eli5|body'
  'MUST appear in the same assistant reply|core'
  'Never end a turn after|core'
  'Never batch|core'
  'never add a manual "Other"|core'
  'and the question tool call all complete in this same Turn 1 reply|core'
  'clarify-stop-check.sh|any'
  'ask_question|core'
  'AskUserQuestion|core'
  '`question`|core'
  'Decision Table|any'
  'Gated Execution|any'
)

# A line cap alone can be gamed by longer lines, so words are capped too.
words="$(wc -w < "$core")"
if [ "$words" -gt "$word_cap" ]; then
  echo "FAIL: plugins/clarify/skills/clarify/SKILL.md has $words words, cap is $word_cap" >&2
  fail=1
fi

for entry in "${anchors[@]}"; do
  anchor="${entry%|*}"
  scope="${entry##*|}"
  case "$scope" in
    core) files=("$core") ;;
    body) files=("$body") ;;
    *) files=("$core" "$dir"/references/*.md) ;;
  esac
  if ! grep -qF -- "$anchor" "${files[@]}"; then
    echo "FAIL: anchor missing ($scope): $anchor" >&2
    fail=1
  fi
done

# References name core rules; each named rule must still exist in the core.
for rule in 'Per-fork invariant' 'Same-Reply Invariant' 'option naming rule' 'counter prefix rule'; do
  if grep -qiF -- "$rule" "$dir"/references/*.md && ! grep -qiF -- "$rule" "$core"; then
    echo "FAIL: a reference cites '$rule' but SKILL.md no longer defines it" >&2
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then echo "OK: clarify core $lines lines (cap $cap), $words words (cap $word_cap), anchors present"; fi
exit "$fail"
