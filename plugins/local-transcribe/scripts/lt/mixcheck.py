"""Detecting whether two audio streams in one container are genuinely separate
sources, or the same mixed audio copied onto every track.

This is the check the plugin was missing until 2026-09-15. It treated "the
container holds 2+ audio streams" as "each stream is a separate source" and
labelled them `Me` / `Remote` on that basis alone. A real recording broke that
assumption: an OBS capture of a two-person meeting from **one** room
microphone still wrote two audio streams — the recording profile had two
tracks configured — and both streams carried the identical mix. Labelling them
per-track attributed the user's own sentences to the other person and back,
with nothing warning anyone. **A stream count is not a source count**; only the
samples say which one a file actually is, so this module looks at the samples
before any per-track label is handed out.

**Method.** Decoding the whole file to compare it would defeat the point on a
multi-gigabyte recording (the file that broke this was 2.35 GB / 49 minutes),
so a handful of short windows (`WINDOW_COUNT` of `WINDOW_SECONDS` each) are
sampled across the middle of the file — long enough to catch real speech,
short enough that the whole check runs in a few seconds regardless of how long
the recording is. Each window is decoded, per stream, with the plugin's own
bundled ffmpeg (never a system binary, never the whole file) to a low sample
rate mono PCM array.

**The comparison has to survive a level or encoding difference between the
tracks.** The two streams in the recording that broke this are *not*
byte-identical — they are the same audio at different gains and through
different encode paths — so a byte or raw-sample comparison reports "different"
and misses the case entirely. What is actually compared is each window's
short-term energy envelope (RMS over `FRAME_SECONDS` frames), z-scored so the
absolute level drops out, correlated at the best of a small range of time
offsets (`MAX_OFFSET_SECONDS`) in case the tracks are not sample-aligned. Two
independent voices produce uncorrelated loudness contours; the same mix
re-encoded onto two tracks produces the same contour wherever anyone is
speaking — high correlation regardless of gain or codec. This is why the
comparison never needs to recognise a single word.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .ffmpeg import ffmpeg_path, run_bytes

# Windows are sampled across the middle of the file, avoiding the first and
# last WINDOW_SECONDS — the part of a recording most likely to be silence, a
# beep, or someone still getting seated, none of which compares meaningfully.
WINDOW_SECONDS = 15.0
WINDOW_COUNT = 5

# Far too low to make the samples usable for speech, which is the point: this
# module only ever looks at loudness, never at content. High enough that a
# 50ms energy frame still holds 100 samples to average.
SAMPLE_RATE = 2000

# Energy-envelope frame length. Short enough to track syllable-level loudness
# changes — the thing that makes two independent voices decorrelate — long
# enough that a 15s window gives a few hundred stable frames to compare.
FRAME_SECONDS = 0.05

# The two tracks of a genuine multi-source recording are not guaranteed to be
# sample-aligned to the millisecond (buffering differs per audio device), so
# the best correlation within this window is taken rather than only at zero
# lag.
MAX_OFFSET_SECONDS = 1.0

# Justified against the two cases this module exists to tell apart (see
# evals/mixcheck_test.py, which measures both and asserts the gap):
#
#   - the real recording that broke Me/Remote labelling on 2026-09-15 — one
#     microphone, two OBS tracks carrying the identical mix at different
#     gains: median envelope correlation lands well above 0.9.
#   - two distinct `say` voices muxed onto two streams of one container, built
#     fresh by this module's own tests with the bundled ffmpeg: median
#     envelope correlation lands well under 0.3, often negative.
#
# 0.6 sits with wide headroom on both sides of that gap, nowhere near either
# measured cluster, so a recording landing near the threshold is more likely
# to indicate a bug in this module than a genuinely ambiguous file.
SAME_MIX_THRESHOLD = 0.6

# Peak amplitude below which a stream is holding nothing rather than something
# quiet. A track a recorder wrote but never fed is digital silence — a real
# recording measured -91 dB for both its mean and its peak across 66 minutes,
# which is the floor of 16-bit — while even a distant microphone in a quiet
# room peaks orders of magnitude above this.
SILENCE_PEAK = 1e-4


class MixCheckUnavailable(RuntimeError):
    """The comparison itself could not run — not a finding about the audio."""


@dataclass
class MixReport:
    """The verdict for one pair of streams."""

    status: str  # "distinct" | "mixed" | "inconclusive"
    score: float
    threshold: float = SAME_MIX_THRESHOLD
    windows_used: int = 0
    windows_total: int = 0
    stream_a: int = 0
    stream_b: int = 1
    detail: str = ""
    # Which of the two streams held no audio at all. A recorder that writes a
    # track it never fed produces exactly this, and the pair then cannot be
    # compared — but that is a finding about the file, not a failed check, so
    # it is carried rather than collapsed into "inconclusive".
    silent: tuple[int, ...] = ()

    @property
    def same_mix(self) -> bool:
        return self.status == "mixed"

    def describe(self) -> str:
        if self.status == "inconclusive":
            return (
                f"streams {self.stream_a}/{self.stream_b}: could not be compared "
                f"({self.detail})"
            )
        verdict = "same mix" if self.status == "mixed" else "distinct sources"
        return (
            f"streams {self.stream_a}/{self.stream_b}: {verdict} "
            f"(envelope correlation {self.score:.2f}, threshold {self.threshold:.2f}, "
            f"{self.windows_used}/{self.windows_total} windows used)"
        )


def _sample_windows(
    duration: float | None, count: int, window: float
) -> list[tuple[float, float]]:
    """Spread `count` windows across the middle of the file."""
    if not duration or duration <= 0:
        return [(0.0, window)]
    usable_end = max(duration - window, 0.0)
    if usable_end <= 0:
        return [(0.0, min(window, duration))]
    return [
        (start := (i + 1) / (count + 1) * usable_end, min(window, duration - start))
        for i in range(count)
    ]


def _extract_window(path: Path, stream_index: int, start: float, length: float) -> np.ndarray:
    """One window of one audio stream, decoded to mono PCM at SAMPLE_RATE.

    `-ss` before `-i` is a fast, seek-based cut — approximate to the nearest
    frame rather than sample-exact, which is irrelevant here: the correlation
    below already searches a small range of offsets to absorb exactly this
    kind of slop, and it is what keeps this check fast on a multi-gigabyte
    file instead of decoding it end to end.
    """
    args = [
        ffmpeg_path(), "-nostdin", "-hide_banner", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-t", f"{length:.3f}",
        "-i", str(path),
        "-map", f"0:a:{stream_index}",
        "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1",
    ]
    result = run_bytes(args)
    if result.returncode != 0:
        raise MixCheckUnavailable(
            f"ffmpeg could not extract stream {stream_index} at {start:.0f}s: "
            f"{result.stderr.decode('utf-8', errors='replace').strip()}"
        )
    return np.frombuffer(result.stdout, dtype="<i2").astype(np.float32) / 32768.0


def _envelope(samples: np.ndarray) -> np.ndarray | None:
    """Short-term RMS, z-scored so absolute level carries no information.

    Returns None when the window is too short or too quiet to compare —
    near-silence has no envelope shape to correlate, and a low score from it
    would be a false "distinct" rather than a real finding.
    """
    frame_len = max(1, int(SAMPLE_RATE * FRAME_SECONDS))
    n_frames = len(samples) // frame_len
    if n_frames < 10:
        return None
    trimmed = samples[: n_frames * frame_len].reshape(n_frames, frame_len)
    rms = np.sqrt(np.mean(trimmed.astype(np.float64) ** 2, axis=1) + 1e-12)
    std = rms.std()
    if std < 1e-6:
        return None
    return (rms - rms.mean()) / std


def _best_correlation(a: np.ndarray, b: np.ndarray, max_offset_frames: int) -> float | None:
    """Pearson correlation of two envelopes, at whichever small offset fits best."""
    best: float | None = None
    for offset in range(-max_offset_frames, max_offset_frames + 1):
        if offset >= 0:
            aa, bb = a[offset:], b[: len(a) - offset]
        else:
            aa, bb = a[: len(b) + offset], b[-offset:]
        n = min(len(aa), len(bb))
        if n < 10:
            continue
        aa, bb = aa[:n], bb[:n]
        denom = np.sqrt(np.dot(aa, aa) * np.dot(bb, bb))
        if denom < 1e-9:
            continue
        corr = float(np.dot(aa, bb) / denom)
        if best is None or corr > best:
            best = corr
    return best


def compare(
    path: Path,
    duration: float | None,
    stream_a: int = 0,
    stream_b: int = 1,
    *,
    window_seconds: float = WINDOW_SECONDS,
    window_count: int = WINDOW_COUNT,
    threshold: float = SAME_MIX_THRESHOLD,
) -> MixReport:
    """Compare two audio streams of one container: same mix, or separate sources?"""
    spans = _sample_windows(duration, window_count, window_seconds)
    max_offset_frames = max(1, int(MAX_OFFSET_SECONDS / FRAME_SECONDS))
    scores: list[float] = []
    loudest = {stream_a: 0.0, stream_b: 0.0}
    for start, length in spans:
        window_a = _extract_window(path, stream_a, start, length)
        window_b = _extract_window(path, stream_b, start, length)
        for index, window in ((stream_a, window_a), (stream_b, window_b)):
            if len(window):
                loudest[index] = max(loudest[index], float(np.abs(window).max()))
        env_a, env_b = _envelope(window_a), _envelope(window_b)
        if env_a is None or env_b is None:
            continue
        if (corr := _best_correlation(env_a, env_b, max_offset_frames)) is not None:
            scores.append(corr)

    silent = tuple(index for index in (stream_a, stream_b) if loudest[index] < SILENCE_PEAK)

    if not scores:
        detail = (
            f"stream {silent[0]} holds no audio at all"
            if len(silent) == 1
            else "both streams hold no audio at all"
            if len(silent) == 2
            else "every sampled window was silent, or near enough, on at "
                 "least one of the two streams"
        )
        return MixReport(
            status="inconclusive", score=0.0, threshold=threshold,
            windows_used=0, windows_total=len(spans),
            stream_a=stream_a, stream_b=stream_b,
            detail=detail, silent=silent,
        )

    score = float(np.median(scores))
    status = "mixed" if score >= threshold else "distinct"
    return MixReport(
        status=status, score=score, threshold=threshold,
        windows_used=len(scores), windows_total=len(spans),
        stream_a=stream_a, stream_b=stream_b, silent=silent,
    )


def classify(path: Path, audio_stream_count: int, duration: float | None) -> list[MixReport]:
    """Compare stream 0 against every other stream; one report per pair.

    Comparing everything to stream 0 rather than every possible pair is
    deliberate: the shape this exists for is exactly two streams (OBS's own
    two-track output), stream 0 is `Me` by default, and for the rare case of
    more than two streams the question that matters is whether each other
    stream is really a separate source from that one.
    """
    return [compare(path, duration, 0, other) for other in range(1, audio_stream_count)]


def overall_status(reports: list[MixReport]) -> str:
    """"mixed" if any pair is the same mix, else "distinct" if any pair was
    conclusively compared, else "inconclusive" if nothing could be checked."""
    if not reports:
        return "inconclusive"
    if any(r.status == "mixed" for r in reports):
        return "mixed"
    if any(r.status == "distinct" for r in reports):
        return "distinct"
    return "inconclusive"


def silent_streams(reports: list[MixReport]) -> list[int]:
    """Every stream index found to hold no audio, across all the pairs."""
    found: set[int] = set()
    for report in reports:
        found.update(report.silent)
    return sorted(found)


def carrying_audio(reports: list[MixReport], audio_stream_count: int) -> list[int]:
    """The stream indices that actually hold something.

    A silent track is not a source, so it must not be handed a speaker label.
    The count of streams a container advertises is therefore not the count of
    sources even after the same-mix check has run: a recorder can write a
    track it never fed, and this is what separates those two questions.
    """
    silent = set(silent_streams(reports))
    return [index for index in range(audio_stream_count) if index not in silent]


__all__ = [
    "FRAME_SECONDS",
    "MAX_OFFSET_SECONDS",
    "SAME_MIX_THRESHOLD",
    "SAMPLE_RATE",
    "SILENCE_PEAK",
    "WINDOW_COUNT",
    "WINDOW_SECONDS",
    "MixCheckUnavailable",
    "MixReport",
    "carrying_audio",
    "classify",
    "compare",
    "overall_status",
    "silent_streams",
]
