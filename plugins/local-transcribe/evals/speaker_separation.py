#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["numpy>=1.24", "sherpa-onnx>=1.12"]
# ///
"""Measure speaker separation on a real recording, against ranges you supply.

`quality_test.py` covers the pipeline's arithmetic on synthetic vectors, which
is the part that can be checked without audio. It cannot tell you whether two
actual voices in an actual room come apart, and that question has been answered
wrongly here twice — once by trusting a clustering that had collapsed, once by
trusting a range label nobody had verified. So this exists as a rig rather than
a fixture: point it at a recording you know, tell it which stretches belong to
whom, and it reports what the pipeline does with them.

No recording is committed with it. The ranges are the only input that carries
knowledge, and they must come from someone who has read or heard the file —
attribute by content, then trim a couple of seconds off each end, because a
warm conversation carries short acknowledgements from the other party.

    ./speaker_separation.py call.wav --speakers 2 \
        --truth 'Ada:0:11-1:25' --truth 'Alan:6:07-8:30'

Two numbers matter in the output. **Agreement** is the share of ground-truth
windows the pipeline put on the right speaker, and it is the headline. **EER**
is the equal-error rate of one speaker's fingerprint against another's, which
says whether the embedding model can tell them apart at all — a bad agreement
with a good EER means the fault is in clustering or in the boundaries, and a
bad EER means it is in the model or the audio.

The input must be 16 kHz mono WAV, which is what `lt/media.py` extracts:

    ffmpeg -i call.mkv -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le call.wav
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from lt import diarize as dz  # noqa: E402
from lt.audio import SAMPLE_RATE, read_wav_f32  # noqa: E402


def parse_time(text: str) -> float:
    """Seconds from `12.5`, `1:25` or `1:02:03`."""
    parts = text.strip().split(":")
    if len(parts) > 3:
        raise argparse.ArgumentTypeError(f"cannot read {text!r} as a time")
    total = 0.0
    for part in parts:
        total = total * 60 + float(part)
    return total


def parse_truth(value: str) -> tuple[str, float, float]:
    """`Name:start-end`, where start and end may be `mm:ss`."""
    name, _, span = value.partition(":")
    if not name or "-" not in span:
        raise argparse.ArgumentTypeError(
            f"expected NAME:START-END, got {value!r} (e.g. 'Alan:6:07-8:30')"
        )
    start, _, end = span.rpartition("-")
    return name, parse_time(start), parse_time(end)


def embed(extractor, samples: np.ndarray) -> np.ndarray:
    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=SAMPLE_RATE, waveform=samples)
    stream.input_finished()
    vector = np.array(extractor.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm else vector


def equal_error_rate(same: np.ndarray, other: np.ndarray) -> float:
    best = 1.0
    for cut in np.unique(np.concatenate([same, other])):
        best = min(best, max(float((same < cut).mean()), float((other >= cut).mean())))
    return best


def area_under_curve(same: np.ndarray, other: np.ndarray) -> float:
    ranks = np.concatenate([same, other]).argsort().argsort().astype(float) + 1
    taken = ranks[: len(same)].sum()
    return (taken - len(same) * (len(same) + 1) / 2) / (len(same) * len(other))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__ and __doc__.splitlines()[0])
    parser.add_argument("wav", type=Path, help="16 kHz mono WAV")
    parser.add_argument("--speakers", type=int, default=None)
    parser.add_argument("--threshold", type=float, default=None)
    parser.add_argument(
        "--truth", action="append", default=[], type=parse_truth,
        help="NAME:START-END, repeatable; stretches you know belong to one person",
    )
    parser.add_argument(
        "--trim", type=float, default=2.0,
        help="seconds to drop from each end of every range (default 2.0)",
    )
    args = parser.parse_args(argv)

    samples = read_wav_f32(args.wav)
    print(f"{args.wav.name}: {len(samples)/SAMPLE_RATE/60:.1f} minutes")

    turns = dz.diarize(args.wav, speakers=args.speakers, threshold=args.threshold)
    held = {}
    for name, start, end in args.truth:
        held.setdefault(name, []).append((start + args.trim, end - args.trim))

    spread: dict[int, float] = {}
    for turn in turns:
        spread[turn.speaker] = spread.get(turn.speaker, 0.0) + turn.end - turn.start
    total = sum(spread.values()) or 1.0
    print(
        f"{len(turns)} turns, {dz.speaker_count(turns)} speakers: "
        + ", ".join(
            f"speaker {speaker + 1} {seconds:.0f}s ({seconds / total:.0%})"
            for speaker, seconds in sorted(spread.items())
        )
    )

    if not held:
        print("no --truth ranges given, so nothing is scored")
        return 0

    # Agreement: every window of ground truth, against the turn covering it.
    def speaker_at(when: float) -> int | None:
        for turn in turns:
            if turn.start <= when < turn.end:
                return turn.speaker
        return None

    rows: list[tuple[str, int | None]] = []
    for name, spans in held.items():
        for start, end in spans:
            when = start
            while when < end:
                rows.append((name, speaker_at(when)))
                when += 1.0

    named = [row for row in rows if row[1] is not None]
    print(
        f"\n{len(rows)} ground-truth seconds, {len(rows) - len(named)} of them "
        "falling in no turn (silence, or too short to fingerprint)"
    )

    # Each ground-truth name is credited to the cluster it most often lands in.
    mapping: dict[str, int] = {}
    for name in held:
        counts: dict[int, int] = {}
        for row_name, speaker in named:
            if row_name == name and speaker is not None:
                counts[speaker] = counts.get(speaker, 0) + 1
        if counts:
            mapping[name] = max(counts, key=lambda key: counts[key])
    if len(set(mapping.values())) < len(mapping):
        print(
            "⚠️  two ground-truth speakers map to the same cluster — the pipeline "
            "merged them, so agreement below is not meaningful"
        )
    print("cluster mapping: " + ", ".join(
        f"{name} → speaker {speaker + 1}" for name, speaker in mapping.items()))

    agree = sum(1 for name, speaker in named if mapping.get(name) == speaker)
    print(f"agreement: {agree}/{len(named)} = {agree / max(1, len(named)):.1%}")

    # EER, which asks about the model rather than the pipeline.
    if len(held) >= 2:
        import sherpa_onnx

        _, embedding = dz.ensure_models()
        extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(embedding),
                num_threads=dz.resolve_threads(),
                provider=dz.resolve_provider(),
            )
        )
        window = int(dz.WINDOW_SECONDS * SAMPLE_RATE)
        vectors: dict[str, list[np.ndarray]] = {}
        prints: dict[str, np.ndarray] = {}
        for name, spans in held.items():
            first, *rest = spans
            prints[name] = embed(
                extractor,
                samples[int(first[0] * SAMPLE_RATE):int(first[1] * SAMPLE_RATE)],
            )
            vectors[name] = [
                embed(extractor, samples[start:start + window])
                for span_start, span_end in (rest or [first])
                for start in range(
                    int(span_start * SAMPLE_RATE),
                    int(span_end * SAMPLE_RATE) - window,
                    int(dz.HOP_SECONDS * SAMPLE_RATE),
                )
            ]

        print("\nfingerprint separation, held out from each print:")
        names = list(prints)
        for name in names:
            for other in names:
                if other == name:
                    continue
                same = np.array([float(prints[name] @ v) for v in vectors[name]])
                apart = np.array([float(prints[name] @ v) for v in vectors[other]])
                if not len(same) or not len(apart):
                    print(f"  {name} vs {other}: not enough held-out audio")
                    continue
                print(
                    f"  {name}'s print: own {np.median(same):+.3f}, "
                    f"{other} {np.median(apart):+.3f}, "
                    f"AUC {area_under_curve(same, apart):.3f}, "
                    f"EER {equal_error_rate(same, apart):.0%}"
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
