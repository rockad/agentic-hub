#!/usr/bin/env bash
# Smoke test for convert.sh's PDF/OCR-fallback reachability.
#
# The bug this guards: the OCR fallback used to sit *after* the markitdown call
# had already succeeded, so a PDF markitdown fails outright on (non-zero exit)
# printed FAILED and returned before OCR ever got a chance -- exactly the class
# of file OCR exists for. Measured on 2026-09-08/09: two real PDFs reported
# FAILED that OCR recovered 23,000 and 22,956 bytes of text from by hand.
#
# It builds its own fixtures, so it needs nothing in git:
#   - text.pdf      a real extractable text layer (reportlab)      -> happy path,
#                    short-circuits before OCR is ever invoked
#   - scanned.pdf   an image with no text layer (Pillow + img2pdf) -> markitdown
#                    exits 0 but writes ~nothing; OCR fallback already worked for
#                    this case before the fix, kept here as a regression check
#   - forced-fail.pdf  same image, but markitdown is made to exit non-zero on it
#                    (see "the shim" below) -> this is the exact bug: OCR must
#                    still run and rescue the file
#   - corrupt.docx  random bytes, not a valid zip -> markitdown fails outright,
#                    and there is no OCR path for non-PDFs, so this must stay
#                    FAILED (checks requirement 2/3 of the fix: no regression)
#
# The shim: convert.sh finds `markitdown` via plain PATH lookup, so a wrapper
# placed earlier on PATH that fails only for forced-fail.pdf (and otherwise
# delegates to the real markitdown) is the deterministic way to exercise "markitdown
# fails outright" without depending on a specific markitdown version's parser
# choking on some hand-crafted malformed PDF.
#
#   ./evals/smoke.sh
#
# Exit 0 means every check passed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONVERT="$HERE/../scripts/convert.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/markdown-convert-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if ! command -v markitdown >/dev/null 2>&1; then
  echo "ERR: markitdown not installed -- see SKILL.md (uv tool install 'markitdown[all]')"
  exit 127
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "ERR: uv not installed"
  exit 127
fi
REAL_MARKITDOWN="$(command -v markitdown)"

# --- fixtures -----------------------------------------------------------------

head_ "Building fixtures in $WORK"

# A real, extractable text layer -- padded past the 200-byte OCR threshold so the
# happy path is unambiguous.
uv run --with reportlab python3 - "$WORK/text.pdf" <<'PY'
import sys
from reportlab.pdfgen import canvas
c = canvas.Canvas(sys.argv[1], pagesize=(500, 300))
lines = [
    "This PDF has a real extractable text layer, not a scan.",
    "markitdown should read this directly, no OCR needed.",
    "Padding this fixture past the 200 byte OCR threshold.",
    "A fourth line of filler text to be safe on byte count.",
]
y = 220
for line in lines:
    c.drawString(20, y, line)
    y -= 20
c.save()
PY
[ -s "$WORK/text.pdf" ] && ok "built text.pdf (real text layer)" \
                         || bad "could not build text.pdf"

# A single line of text rendered to an image, then wrapped in a PDF with no text
# layer at all -- one page, small, so OCR of it stays a couple of seconds.
uv run --with pillow --with img2pdf python3 - "$WORK/scan.png" "$WORK/scanned.pdf" <<'PY'
import sys
import img2pdf
from PIL import Image, ImageDraw, ImageFont
png_path, pdf_path = sys.argv[1], sys.argv[2]
img = Image.new("RGB", (800, 200), "white")
d = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 60)
except Exception:
    font = ImageFont.load_default()
d.text((20, 60), "HELLO OCR TEST", fill="black", font=font)
img.save(png_path)
with open(pdf_path, "wb") as f:
    f.write(img2pdf.convert(png_path))
PY
[ -s "$WORK/scanned.pdf" ] && ok "built scanned.pdf (image only, no text layer)" \
                           || bad "could not build scanned.pdf"

cp "$WORK/scanned.pdf" "$WORK/forced-fail.pdf" 2>/dev/null
[ -s "$WORK/forced-fail.pdf" ] && ok "built forced-fail.pdf (copy of scanned.pdf)" \
                               || bad "could not build forced-fail.pdf"

# Not a valid zip, so DocxConverter throws BadZipFile and markitdown exits non-zero
# -- verified by hand: `markitdown` on 50 random bytes named .docx exits 1.
head -c 50 /dev/urandom > "$WORK/corrupt.docx"
[ -s "$WORK/corrupt.docx" ] && ok "built corrupt.docx (not a valid zip)" \
                            || bad "could not build corrupt.docx"

# The shim: fails only for forced-fail.pdf, otherwise delegates to the real markitdown.
FAKE_BIN="$WORK/fakebin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/markitdown" <<SHIM
#!/usr/bin/env bash
case "\$1" in
  */forced-fail.pdf) echo "fake markitdown: simulated crash on \$1" >&2; exit 1 ;;
esac
exec "$REAL_MARKITDOWN" "\$@"
SHIM
chmod +x "$FAKE_BIN/markitdown"
export PATH="$FAKE_BIN:$PATH"
"$FAKE_BIN/markitdown" "$WORK/forced-fail.pdf" >/dev/null 2>&1
[ "$?" -eq 1 ] && ok "shim: fails on forced-fail.pdf" || bad "shim did not fail on forced-fail.pdf"
"$FAKE_BIN/markitdown" "$WORK/text.pdf" >/dev/null 2>&1
[ "$?" -eq 0 ] && ok "shim: delegates to the real markitdown for anything else" \
              || bad "shim did not delegate for text.pdf"

# --- happy path: real text layer short-circuits before OCR --------------------

head_ "A normal text PDF short-circuits before OCR"

out="$(bash "$CONVERT" "$WORK/text.pdf" 2>&1)"
echo "$out" | grep -q "OK -> $WORK/text.md" && ok "text.pdf converted OK" \
                                             || bad "text.pdf: $out"
echo "$out" | grep -qi "OCR" && bad "text.pdf invoked OCR (should have short-circuited)" \
                              || ok "text.pdf never touched OCR"
[ -s "$WORK/text.md" ] && grep -q "extractable text layer" "$WORK/text.md" \
    && ok "text.md has the real content" || bad "text.md missing expected content"

# --- markitdown succeeds but writes ~nothing: pre-existing OCR path -----------

head_ "An image-only PDF (markitdown exits 0, writes ~nothing) still falls back to OCR"

out="$(bash "$CONVERT" "$WORK/scanned.pdf" 2>&1)"
echo "$out" | grep -q "OCR fallback applied" && ok "scanned.pdf triggered the OCR fallback" \
                                              || bad "scanned.pdf: $out"
echo "$out" | grep -q "OK -> $WORK/scanned.md" && ok "scanned.pdf converted OK" \
                                                || bad "scanned.pdf: $out"
[ -s "$WORK/scanned.md" ] && grep -qi "HELLO OCR TEST" "$WORK/scanned.md" \
    && ok "scanned.md recovered the OCR'd text" || bad "scanned.md missing OCR text"

# --- the bug: markitdown fails outright, OCR must still be tried --------------

head_ "markitdown failing outright on a PDF still reaches OCR (the fix under test)"

out="$(bash "$CONVERT" "$WORK/forced-fail.pdf" 2>&1)"
echo "$out" | grep -q "FAILED: $WORK/forced-fail.pdf" \
    && bad "forced-fail.pdf was reported FAILED -- OCR fallback was not reached" \
    || ok "forced-fail.pdf was not reported FAILED"
echo "$out" | grep -q "OCR fallback applied" && ok "forced-fail.pdf's OCR fallback ran" \
                                              || bad "forced-fail.pdf: $out"
echo "$out" | grep -q "OK -> $WORK/forced-fail.md" \
    && ok "forced-fail.pdf counted as converted despite markitdown failing" \
    || bad "forced-fail.pdf: $out"
[ -s "$WORK/forced-fail.md" ] && grep -qi "HELLO OCR TEST" "$WORK/forced-fail.md" \
    && ok "forced-fail.md recovered the OCR'd text" || bad "forced-fail.md missing OCR text"
echo "$out" | grep -q "^Converted: 1  Skipped: 0  Failed: 0  Deleted originals: 0$" \
    && ok "summary line: 1 converted, 0 failed" || bad "summary line wrong: $out"

# --- non-PDF failures are unchanged: still FAILED, no OCR exists for them -----

head_ "A corrupt .docx still reports FAILED (no OCR path for non-PDFs)"

out="$(bash "$CONVERT" "$WORK/corrupt.docx" 2>&1)"
echo "$out" | grep -q "FAILED: $WORK/corrupt.docx" && ok "corrupt.docx reported FAILED" \
                                                    || bad "corrupt.docx: $out"
echo "$out" | grep -q "^Converted: 0  Skipped: 0  Failed: 1  Deleted originals: 0$" \
    && ok "summary line: 0 converted, 1 failed" || bad "summary line wrong: $out"
[ -f "$WORK/corrupt.md" ] && bad "corrupt.docx left a stray corrupt.md" \
                          || ok "no stray corrupt.md left behind"

# --- --delete-originals never touches a PDF, even after a successful fallback --

head_ "--delete-originals never deletes a PDF, even after a successful OCR fallback"

cp "$WORK/scanned.pdf" "$WORK/scanned2.pdf"
bash "$CONVERT" "$WORK/scanned2.pdf" --delete-originals --force >/dev/null 2>&1
[ -f "$WORK/scanned2.pdf" ] && ok "scanned2.pdf (the PDF original) still exists" \
                            || bad "scanned2.pdf was deleted -- PDFs must never be auto-deleted"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
