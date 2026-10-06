"""Locating `ffmpeg` and `ffprobe`, wheel first.

The plugin takes `ffmpeg` from the `imageio-ffmpeg` wheel rather than the
system, so that the whole setup needs nothing but `uv` — no `brew install
ffmpeg`, no `apt-get`, no `sudo`. A system binary on PATH is still preferred
when present: it is usually newer and handles more containers.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path


class FfmpegMissing(RuntimeError):
    pass


@lru_cache(maxsize=1)
def ffmpeg_path() -> str:
    override = os.environ.get("LOCAL_TRANSCRIBE_FFMPEG")
    if override:
        if not Path(override).exists():
            raise FfmpegMissing(f"LOCAL_TRANSCRIBE_FFMPEG points at a missing file: {override}")
        return override

    system = shutil.which("ffmpeg")
    if system:
        return system

    try:
        import imageio_ffmpeg
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise FfmpegMissing(
            "No ffmpeg on PATH and the imageio-ffmpeg wheel is not installed."
        ) from exc
    return imageio_ffmpeg.get_ffmpeg_exe()


@lru_cache(maxsize=1)
def ffprobe_path() -> str | None:
    """`ffprobe` is optional — the wheel ships only `ffmpeg`.

    Returns None when there is no ffprobe, and the caller falls back to parsing
    `ffmpeg -i`'s stderr, which reports the same stream facts in a less
    convenient form.
    """
    override = os.environ.get("LOCAL_TRANSCRIBE_FFPROBE")
    if override:
        return override if Path(override).exists() else None

    system = shutil.which("ffprobe")
    if system:
        return system

    # The wheel's ffmpeg sometimes sits beside an ffprobe in the same directory.
    sibling = Path(ffmpeg_path()).with_name("ffprobe")
    return str(sibling) if sibling.exists() else None


def run(args: list[str], *, capture: bool = True) -> subprocess.CompletedProcess:
    """Run a command with stdin closed, so ffmpeg never blocks on a prompt."""
    return subprocess.run(
        args,
        stdin=subprocess.DEVNULL,
        capture_output=capture,
        text=True,
        check=False,
    )


def run_bytes(args: list[str]) -> subprocess.CompletedProcess:
    """Like `run`, but stdout is raw bytes rather than decoded text.

    For piping decoded PCM straight out of ffmpeg (`-f s16le pipe:1`), where
    `text=True` would try to decode audio samples as a string and fail.
    """
    return subprocess.run(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
