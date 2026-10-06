#!/usr/bin/env bash
# Smoke test for md-to-pdf skill
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MD_TO_PDF="$HERE/../scripts/md_to_pdf.py"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/md-to-pdf-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if ! command -v uv >/dev/null 2>&1; then
  echo "ERR: uv not installed"
  exit 127
fi

head_ "Building test documents in $WORK"

# 1. Plain markdown doc
cat > "$WORK/test_basic.md" << 'EOF'
# Sample Document

This is a test paragraph with **bold** text and [a link](https://example.com).

## Key Highlights
- Feature A: High performance
- Feature B: Robust layout
- Feature C: Automated page numbers

| Name | Role | Status |
|---|---|---|
| Alice | Staff Engineer | Active |
| Bob | Engineering Manager | Active |
EOF

# 2. Markdown with frontmatter and custom template
cat > "$WORK/test_custom.md" << 'EOF'
---
title: "Tailored Resume"
author: "Test Candidate"
target_role: "Principal Architect"
---

## Summary
Experienced technology leader building resilient cloud platforms.

## Core Competencies
* Cloud Architecture
* Systems Design
* Engineering Leadership
EOF

cat > "$WORK/custom_template.html" << 'EOF'
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>{{ title }}</title>
<style>
@page { size: A4; margin: 15mm; }
body { font-family: sans-serif; font-size: 11pt; color: #333; }
.header { border-bottom: 2px solid #2563eb; padding-bottom: 8px; margin-bottom: 12px; }
.role-badge { color: #2563eb; font-weight: bold; }
</style>
</head>
<body>
<div class="header">
  <h1>{{ meta.author }}</h1>
  <div class="role-badge">{{ meta.target_role }} | {{ custom_note }}</div>
</div>
{{ content | safe }}
</body>
</html>
EOF

head_ "Test 1: Basic markdown to PDF with default template"
uv run "$MD_TO_PDF" "$WORK/test_basic.md" -o "$WORK/test_basic.pdf" >/dev/null 2>&1
if [ -s "$WORK/test_basic.pdf" ]; then
    ok "generated basic.pdf with non-zero size"
else
    bad "failed to generate basic.pdf"
fi

head_ "Test 2: Markdown with frontmatter and custom template"
uv run "$MD_TO_PDF" "$WORK/test_custom.md" \
    -t "$WORK/custom_template.html" \
    -o "$WORK/test_custom.pdf" \
    --var custom_note="Confidential" >/dev/null 2>&1

if [ -s "$WORK/test_custom.pdf" ]; then
    ok "generated custom.pdf using custom HTML template"
else
    bad "failed to generate custom.pdf"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
