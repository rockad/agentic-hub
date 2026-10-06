---
name: markdown-convert
description: Convert PDFs, Office documents (docx/doc/pptx/xlsx/xls), and raw .eml emails into Markdown sidecar files (<name>.md) next to the original -- for any vault file Claude Code's Read tool can't parse natively (or can only dump raw MIME/XML from). Falls back to local OCR (pypdfium2 + rapidocr-onnxruntime -- no cloud, no system packages, no sudo) when a PDF has no extractable text layer (scanned documents, screenshots). Optionally deletes the non-PDF originals once a good .md sidecar exists.
when_to_use: The user wants vault files converted to markdown, scanned/image PDFs made readable/searchable, or a batch of email/office attachments turned into notes. Keywords -- convert to markdown, batch convert, files I can't read, OCR this PDF, eml to markdown, delete the original after converting. Skip for a single already-markdown file, or when the generic `markitdown` skill's default (print-to-terminal, or save under ~/.agents/output/) is what's actually wanted instead of an in-place vault sidecar.
argument-hint: "<file-or-directory> [--force] [--delete-originals] [--exts pdf,docx,doc,pptx,xlsx,xls,eml]"
allowed-tools: Bash(bash *) Bash(python3 *) Read
metadata:
  author: aleksandr
  local_only: true
  requires: markitdown CLI on PATH (uv tool install 'markitdown[all]'); uv (for the on-demand OCR venv)
---

# markdown-convert

Batch-converts files that Claude Code's `Read` tool either can't open at all (`.docx`, `.xlsx`, `.xls`, `.doc`, `.pptx`) or can only read as noisy raw source (`.eml` -- raw MIME with base64 bodies) into a clean `<name>.md` sidecar next to the original. PDFs are included too: `Read` can already view them, but a real `.md` sidecar makes them searchable via Obsidian/`mcp__obsidian__*` and grep, and lets a scanned/image-only PDF get OCR'd into actual text.

Packages a repeatable approach so the conversion doesn't need to be reinvented per-request.

## Why not just the `markitdown` skill

The generic `markitdown` skill is for one-off "convert this file and show me / save it under `~/.agents/output/`" requests. This skill is for **batch, in-place, vault-native** conversion: it walks a directory, writes each output next to its source (so Obsidian picks it up and wikilinks resolve normally), skips files already converted, and adds two things plain `markitdown` doesn't do:

- **OCR fallback for scanned PDFs.** `markitdown`'s PDF path is text-layer extraction only (pdfminer/pypdfium2) -- a scanned/photographed page yields ~0 bytes. This skill detects a suspiciously small result (<200 bytes) and re-renders the page(s) with `pypdfium2`, then runs `rapidocr-onnxruntime` (ONNX, GPU via CUDA when an NVIDIA card is present, else CPU; no system binary, no tesseract/poppler apt packages) to actually extract the text. Keeps whichever result is longer.
- **`.eml` handling.** `markitdown` has no raw-email converter (only Outlook `.msg` via its `outlook` extra) -- fed a `.eml` it just returns the file's raw MIME source (headers, boundaries, base64 blobs). This skill's `eml_to_md.py` parses the message properly with Python's stdlib `email` package, decodes the real body (plain text, or HTML run through `markitdown` for a clean Markdown render), and lists attachment filenames instead of dumping their bytes.

## Workflow

1. **Confirm scope before a directory-wide run.** Converting a whole vault subtree can touch dozens of files -- if the user's ask is ambiguous ("convert the vault"), confirm the target folder rather than defaulting to the whole vault.
2. Check `markitdown` is installed: `command -v markitdown`. If missing, tell the user to run `uv tool install 'markitdown[all]'` (plain `pip install` fails on this machine with `externally-managed-environment` -- `uv tool install` is the one that's been verified to work here) and stop. Don't attempt another install method.
3. Run the helper:

   `$SKILL_DIR` = this skill's folder -- `${CLAUDE_SKILL_DIR}` in Claude Code, the directory containing this SKILL.md elsewhere.

   ```bash
   bash "$SKILL_DIR"/scripts/convert.sh "<file-or-directory>" [--force] [--delete-originals] [--exts pdf,docx,doc,pptx,xlsx,xls,eml]
   ```

   - No flags: converts every matched file under the path that doesn't already have a `.md` sibling, leaves all originals in place.
   - `--force`: reconvert even if a `.md` sibling already exists (overwrites it).
   - `--delete-originals`: after a successful, non-empty conversion, delete the original -- but **only** for `docx`/`doc`/`pptx`/`xlsx`/`xls`/`eml`. PDFs are never auto-deleted by this flag (the OCR fallback is lossy relative to the source, and `Read` can already view PDFs directly, so keeping the source PDF has a real reason to exist beyond just having a sidecar).
   - `--exts`: restrict/expand which extensions a *directory* scan matches (comma-separated, no dots). Irrelevant when the target is a single file -- that file always converts regardless of its extension.
4. The script prints one line per file: `OK -> <path> (<bytes> bytes)`, `SKIP (exists): <path>`, or `FAILED: <path>` with the error. PDF OCR fallbacks additionally print `(OCR fallback applied: N bytes)`. A summary line closes the run: `Converted: N  Skipped: M  Failed: K  Deleted originals: D`.
5. **First OCR use on a machine** triggers `setup_ocr_venv.sh`, which creates `~/.venvs/markdown-convert-ocr` via `uv venv` and installs `pypdfium2`, `rapidocr-onnxruntime`, `pillow`, `numpy` (~150MB, one-time; cached for all future runs). **With an NVIDIA GPU** (`nvidia-smi` works) it additionally swaps in `onnxruntime-gpu` and the CUDA 13 runtime wheels (~2.5GB, into the venv only, same approach as `local-transcribe`), and `convert.sh` points `LD_LIBRARY_PATH` at them -- OCR then runs on the GPU (RTX 3070 Ti, 2026-08-29: ~1.7 s/page vs ~5.5 s/page on 16 CPU cores, identical text). Re-running the setup script upgrades an existing CPU venv in place once a GPU is present. `ocr_pdf.py` reports `ocr provider: CUDAExecutionProvider` (or `CPUExecutionProvider`) on stderr. This never touches system packages or needs sudo.
6. **After converting**, spot-check a couple of outputs (`Read` a sample or two) before reporting success -- OCR quality on low-res scans and markitdown's table/layout handling on complex documents both vary. If a result looks garbled or truncated, say so rather than reporting a clean success.
7. If the vault has a `.prettierrc.json` (per `Job search/CLAUDE.md`-style root `CLAUDE.md` conventions, `proseWrap: never`), running `prettier --write` over freshly converted `.md` files is reasonable cleanup -- OCR/markitdown output sometimes has inconsistent blank-line runs or trailing whitespace that prettier normalizes harmlessly. Don't reformat file content beyond what prettier does (no manual rewriting of OCR'd text to "fix" it) since these are meant to be faithful extractions, not edited notes.

## Output

```
OK -> <path>.md (N bytes)
  (OCR fallback applied: M bytes)
SKIP (exists): <path>.md
FAILED: <path>: <error>
---
Converted: N  Skipped: M  Failed: K  Deleted originals: D
```

## Notes

- **Detection heuristic for OCR fallback is a flat 200-byte threshold**, not a per-page ratio. It's deliberately simple: cheap enough to run even on a 1-page PDF that turns out to have no more real text after OCR either (a title-only slide, say) -- the script just keeps whichever output is longer.
- **`.eml` body preference order**: plain-text part first, HTML part (rendered to Markdown via `markitdown`) only if no plain-text part exists. Attachments are listed by filename only -- never decoded/extracted; if attachment content itself needs converting, point this skill (or the base `markitdown` skill) at the extracted attachment file directly.
- **Never delete a PDF automatically.** If the user explicitly wants a PDF original removed after conversion, that's a separate, explicit `rm` -- not something `--delete-originals` does.
- **Idempotent**: safe to re-run over the same directory repeatedly; already-converted files are skipped unless `--force` is passed.
