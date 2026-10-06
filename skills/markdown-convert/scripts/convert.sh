#!/usr/bin/env bash
# Convert files Claude Code's Read tool can't parse natively (PDF/DOCX/DOC/PPTX/XLSX/XLS/EML)
# into Markdown sidecar files (<name>.md) next to each original.
#
# Usage: convert.sh <file-or-directory> [--force] [--delete-originals] [--exts pdf,docx,...]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OCR_VENV="$HOME/.venvs/markdown-convert-ocr"
DEFAULT_EXTS="pdf,docx,doc,pptx,xlsx,xls,eml"
SAFE_DELETE_EXTS="docx,doc,pptx,xlsx,xls,eml" # never pdf -- OCR fallback output is lossy vs. the source

FORCE=0
DELETE_ORIGINALS=0
EXTS="$DEFAULT_EXTS"
TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --delete-originals) DELETE_ORIGINALS=1; shift ;;
    --exts) EXTS="$2"; shift 2 ;;
    -*) echo "ERR: unknown flag $1"; exit 2 ;;
    *) TARGET="$1"; shift ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "ERR: no path given"
  exit 2
fi
if [ ! -e "$TARGET" ]; then
  echo "ERR: path not found: $TARGET"
  exit 2
fi
if ! command -v markitdown >/dev/null 2>&1; then
  echo "ERR: markitdown not installed"
  exit 127
fi

IFS=',' read -ra EXT_ARR <<< "$EXTS"
FIND_EXPR=()
for e in "${EXT_ARR[@]}"; do
  if [ "${#FIND_EXPR[@]}" -eq 0 ]; then
    FIND_EXPR=(-iname "*.$e")
  else
    FIND_EXPR+=(-o -iname "*.$e")
  fi
done

IFS=',' read -ra SAFE_ARR <<< "$SAFE_DELETE_EXTS"
is_safe_delete_ext() {
  local needle="$1"
  for s in "${SAFE_ARR[@]}"; do
    [ "$needle" = "$s" ] && return 0
  done
  return 1
}

ensure_ocr_venv() {
  # Always delegate to setup_ocr_venv.sh -- it is fast and self-idempotent (have_gpu/venv_has_gpu),
  # and this is also what lets it upgrade an already-installed CPU-only venv to GPU once a GPU
  # becomes available, per its own "Idempotent" contract. Only its first run (no venv yet) prints
  # the setup banner; a no-op run is silent already.
  if [ ! -x "$OCR_VENV/bin/python" ]; then
    echo "==> Setting up local OCR environment (first use only; ~150MB, or ~2.5GB with an NVIDIA GPU)..." >&2
  fi
  # stdout is only the OCR_VENV=... line (noise on every call now); stderr keeps the banners.
  bash "$SCRIPT_DIR/setup_ocr_venv.sh" >/dev/null || return 1
  # The CUDA runtime wheels install their .so files under site-packages/nvidia/*/lib, which is
  # on no default loader path -- build LD_LIBRARY_PATH from them (same approach as
  # local-transcribe's run_transcribe.sh). Harmless on a CPU-only venv: the glob is empty.
  local nvlibs
  nvlibs=$(find "$OCR_VENV"/lib/python*/site-packages/nvidia -maxdepth 2 -type d -name lib 2>/dev/null | tr '\n' ':')
  nvlibs="${nvlibs%:}"  # no trailing empty component: the loader would read it as "."
  [ -n "$nvlibs" ] && export LD_LIBRARY_PATH="${nvlibs}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  return 0
}

CONVERTED=0
SKIPPED=0
FAILED=0
DELETED=0

convert_one() {
  local f="$1"
  local ext="${f##*.}"
  local ext_lower out bytes markitdown_failed=0
  ext_lower=$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')
  out="${f%.*}.md"

  if [ -f "$out" ] && [ "$FORCE" -ne 1 ]; then
    echo "SKIP (exists): $out"
    SKIPPED=$((SKIPPED + 1))
    return
  fi

  if [ "$ext_lower" = "eml" ]; then
    if ! python3 "$SCRIPT_DIR/eml_to_md.py" "$f" "$out" 2>"$out.err"; then
      echo "FAILED: $f"; cat "$out.err"; rm -f "$out.err"
      FAILED=$((FAILED + 1)); return
    fi
    rm -f "$out.err"
  else
    if ! markitdown "$f" > "$out.tmp" 2>"$out.err"; then
      # markitdown failed outright. There's no OCR path for non-PDFs, so that's a real failure.
      # For a PDF, defer: OCR gets a chance below before this is reported as FAILED.
      if [ "$ext_lower" != "pdf" ]; then
        echo "FAILED: $f"; cat "$out.err"; rm -f "$out.tmp" "$out.err"
        FAILED=$((FAILED + 1)); return
      fi
      markitdown_failed=1
      cat "$out.err" >&2
      rm -f "$out.tmp" "$out.err"
    else
      mv "$out.tmp" "$out"
      rm -f "$out.err"
    fi
  fi

  if [ "$markitdown_failed" -eq 1 ]; then
    bytes=0
  else
    bytes=$(wc -c < "$out")
  fi

  # PDFs with a near-empty text layer -- or where markitdown failed outright, or exited 0 while
  # writing nothing at all -- are usually scanned/image-only: fall back to local OCR. A PDF is
  # only reported FAILED (below) once OCR has also failed or produced nothing usable.
  if [ "$ext_lower" = "pdf" ] && [ "$bytes" -lt 200 ]; then
    if ensure_ocr_venv; then
      local ocr_out="$out.ocr_tmp" ocr_err="$out.ocr.err" ocr_bytes
      if "$OCR_VENV/bin/python" "$SCRIPT_DIR/ocr_pdf.py" "$f" "$ocr_out" 2>"$ocr_err"; then
        ocr_bytes=$(wc -c < "$ocr_out")
        if [ "$ocr_bytes" -gt "$bytes" ]; then
          mv "$ocr_out" "$out"
          bytes=$ocr_bytes
          echo "  (OCR fallback applied: $bytes bytes)"
        else
          rm -f "$ocr_out"
        fi
      else
        echo "  (OCR fallback failed, keeping markitdown output)"
        cat "$ocr_err"
      fi
      rm -f "$ocr_err"
    else
      echo "  (OCR fallback unavailable, keeping markitdown output)"
    fi
  fi

  # Nothing usable came out of either path: markitdown produced no file (or an empty one) and
  # OCR didn't improve on that. This is the only way a PDF still ends up FAILED -- non-PDFs
  # already returned early above, so this check is a no-op for them.
  if [ "$ext_lower" = "pdf" ] && [ ! -s "$out" ]; then
    echo "FAILED: $f (markitdown failed or empty; OCR unavailable or produced nothing usable)"
    rm -f "$out"
    FAILED=$((FAILED + 1))
    return
  fi

  echo "OK -> $out ($bytes bytes)"
  CONVERTED=$((CONVERTED + 1))

  if [ "$DELETE_ORIGINALS" -eq 1 ] && [ "$bytes" -gt 0 ] && is_safe_delete_ext "$ext_lower"; then
    rm -f "$f"
    echo "  deleted original: $f"
    DELETED=$((DELETED + 1))
  fi
}

if [ -d "$TARGET" ]; then
  while IFS= read -r -d '' f; do
    convert_one "$f"
  done < <(find "$TARGET" -type f \( "${FIND_EXPR[@]}" \) \
             -not -path "*/.obsidian/*" -not -path "*/.trash/*" -not -path "*/.copilot*/*" -print0)
else
  convert_one "$TARGET"
fi

echo "---"
echo "Converted: $CONVERTED  Skipped: $SKIPPED  Failed: $FAILED  Deleted originals: $DELETED"
