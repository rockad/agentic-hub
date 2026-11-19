#!/usr/bin/env bash
# check-clarify-skill.sh - guard for the clarify skill.
#
# 1. SKILL.md stays under a line cap, so the core skill cannot quietly grow back.
# 2. The strings that the Stop hook, the transcript checker and the references
#    depend on are still present in SKILL.md or its references.
#
# Requires: bash, grep, wc. Exits 1 on any miss.

# shellcheck disable=SC2016  # anchors hold literal backticks on purpose
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/skills/clarify"
core="$dir/SKILL.md"
cap="${CLARIFY_LINE_CAP:-170}"
fail=0

lines="$(wc -l < "$core")"
if [ "$lines" -gt "$cap" ]; then
  echo "FAIL: skills/clarify/SKILL.md has $lines lines, cap is $cap (add a rule once, or move text to references/)" >&2
  fail=1
fi

# anchor|file (core = SKILL.md, any = SKILL.md or a reference)
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
  'ask_question|core'
  'AskUserQuestion|core'
  '`question`|core'
  'Decision Table|any'
  'Gated Execution|any'
)

for entry in "${anchors[@]}"; do
  anchor="${entry%|*}"
  scope="${entry##*|}"
  if [ "$scope" = core ]; then files=("$core"); else files=("$core" "$dir"/references/*.md); fi
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

if [ "$fail" -eq 0 ]; then echo "OK: clarify core $lines lines (cap $cap), anchors present"; fi
exit "$fail"
