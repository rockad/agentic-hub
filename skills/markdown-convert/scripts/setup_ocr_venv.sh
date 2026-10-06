#!/usr/bin/env bash
# Sets up a local, pip-only OCR environment (pypdfium2 + rapidocr-onnxruntime) for
# scanned/image-only PDFs -- no system packages (poppler, tesseract) and no sudo required.
# With an NVIDIA GPU present (nvidia-smi works) it installs the CUDA build of onnxruntime
# plus the CUDA 13 runtime wheels *into the venv* (~2.5 GB), the same way local-transcribe
# does, so OCR runs on the GPU: measured 2026-08-29 on an RTX 3070 Ti, ~1.7 s/page vs
# ~5.5 s/page on 16 CPU cores. Without a GPU it stays the CPU stack (~150 MB).
# Idempotent: re-running upgrades an existing CPU venv to GPU when a GPU has appeared.
set -euo pipefail

VENV_DIR="$HOME/.venvs/markdown-convert-ocr"
PY="$VENV_DIR/bin/python"

have_gpu() { command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; }
venv_has_gpu() { [ -x "$PY" ] && uv pip list --python "$PY" 2>/dev/null | grep -qi '^onnxruntime-gpu'; }

if [ -x "$PY" ]; then
  if have_gpu && ! venv_has_gpu; then
    echo "==> GPU detected but the OCR venv is CPU-only -- upgrading in place" >&2
  else
    echo "OCR_VENV=$VENV_DIR"
    exit 0
  fi
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "ERR: uv not installed (see https://docs.astral.sh/uv/getting-started/installation/)"
  exit 127
fi

[ -x "$PY" ] || uv venv "$VENV_DIR" >&2
uv pip install --python "$PY" pypdfium2 rapidocr-onnxruntime pillow numpy >&2

if have_gpu; then
  # rapidocr-onnxruntime depends on the CPU `onnxruntime` wheel, which shares the import
  # package with `onnxruntime-gpu` and clobbers it -- so swap after, never alongside.
  uv pip uninstall --python "$PY" onnxruntime onnxruntime-gpu >&2 || true
  uv pip install --python "$PY" onnxruntime-gpu \
    nvidia-cuda-runtime nvidia-cublas nvidia-curand nvidia-cufft nvidia-cudnn-cu13 >&2
  echo "==> OCR venv is GPU-enabled (onnxruntime-gpu + CUDA 13 runtime wheels)" >&2
fi

echo "OCR_VENV=$VENV_DIR"
