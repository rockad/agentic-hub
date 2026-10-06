"""Probing an input file and deciding which input shape it is.

Speaker-label quality is a property of what the file contains, not of which tool
made it, so the pipeline detects the shape and refuses the ones it cannot yet
handle rather than silently producing an unlabelled wall of text.

Shapes, per the migration plan:

    A   one audio stream, no usable speaker split      (dictation, or a table mic)
    B   two or more audio streams in one container     (OBS track 1 + track 2)
    C   one multi-channel stream mapped to sources     (macOS aggregate device)
    F   video with no audio at all
"""

from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path

from .ffmpeg import FfmpegMissing, ffmpeg_path, ffprobe_path, run

AUDIO_EXTENSIONS = {
    # what phones and handheld recorders actually write
    ".m4a", ".mp3", ".opus", ".ogg", ".oga", ".amr", ".3gp", ".3gpp",
    ".wma", ".aiff", ".aif", ".aifc", ".wav", ".flac", ".caf", ".mp4a",
}
VIDEO_EXTENSIONS = {".mkv", ".mp4", ".mov", ".m4v", ".webm", ".avi", ".flv", ".ts"}


@dataclass
class AudioStream:
    index: int
    channels: int
    sample_rate: int
    codec: str


@dataclass
class Probe:
    path: Path
    duration: float | None
    audio: list[AudioStream] = field(default_factory=list)
    has_video: bool = False
    probed_with: str = "ffprobe"

    @property
    def shape(self) -> str:
        if not self.audio:
            return "F" if self.has_video else "unknown"
        if len(self.audio) >= 2:
            return "B"
        if self.audio[0].channels >= 2:
            return "C"
        return "A"

    @property
    def sample_rate(self) -> int | None:
        return self.audio[0].sample_rate if self.audio else None


def probe(path: Path) -> Probe:
    probe_bin = ffprobe_path()
    if probe_bin:
        return _probe_with_ffprobe(path, probe_bin)
    return _probe_with_ffmpeg(path)


def _probe_with_ffprobe(path: Path, probe_bin: str) -> Probe:
    result = run([
        probe_bin, "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", str(path),
    ])
    if result.returncode != 0:
        raise ValueError(f"ffprobe could not read {path.name}: {result.stderr.strip()}")

    data = json.loads(result.stdout or "{}")
    duration = data.get("format", {}).get("duration")
    out = Probe(path=path, duration=float(duration) if duration else None)

    for stream in data.get("streams", []):
        kind = stream.get("codec_type")
        if kind == "video":
            # A cover-art JPEG is a video stream that is not a video.
            if stream.get("disposition", {}).get("attached_pic"):
                continue
            out.has_video = True
        elif kind == "audio":
            out.audio.append(AudioStream(
                index=len(out.audio),
                channels=int(stream.get("channels") or 1),
                sample_rate=int(stream.get("sample_rate") or 0),
                codec=stream.get("codec_name", "?"),
            ))
    return out


def _probe_with_ffmpeg(path: Path) -> Probe:
    """Fallback when only the wheel's `ffmpeg` is available.

    `ffmpeg -i <file>` with no output exits non-zero by design and prints the
    stream table to stderr; that table carries everything needed here.
    """
    result = run([ffmpeg_path(), "-hide_banner", "-i", str(path)])
    text = result.stderr or ""
    if "Invalid data found" in text or "No such file" in text:
        raise ValueError(f"ffmpeg could not read {path.name}")

    duration = None
    if m := re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", text):
        h, mm, s = m.groups()
        duration = int(h) * 3600 + int(mm) * 60 + float(s)

    out = Probe(path=path, duration=duration, probed_with="ffmpeg -i")
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("Stream #"):
            continue
        if ": Video:" in line and "attached pic" not in line:
            out.has_video = True
        elif ": Audio:" in line:
            codec = (re.search(r": Audio: (\w+)", line) or [None, "?"])[1]
            rate = int(m.group(1)) if (m := re.search(r"(\d+) Hz", line)) else 0
            channels = 1
            if "stereo" in line:
                channels = 2
            elif m := re.search(r"(\d+) channels", line):
                channels = int(m.group(1))
            elif "mono" in line:
                channels = 1
            out.audio.append(AudioStream(
                index=len(out.audio), channels=channels,
                sample_rate=rate, codec=codec,
            ))
    return out


def extract_wav(path: Path, dest: Path, *, stream: int = 0) -> Path:
    """Downmix one audio stream to the 16 kHz mono WAV every engine wants.

    Whisper resamples to 16 kHz internally, so doing it here changes no accuracy
    and makes the engines interchangeable.
    """
    args = [
        ffmpeg_path(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(path),
        "-map", f"0:a:{stream}",
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(dest),
    ]
    result = run(args)
    if result.returncode != 0 or not dest.exists():
        raise RuntimeError(
            "ffmpeg failed to extract audio:\n"
            f"  {shlex.join(args)}\n{result.stderr.strip()}"
        )
    return dest


__all__ = [
    "AUDIO_EXTENSIONS", "VIDEO_EXTENSIONS", "AudioStream", "Probe",
    "FfmpegMissing", "extract_wav", "probe",
]
