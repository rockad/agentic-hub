#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "obsws-python>=1.7",
# ]
# ///
"""Record a call or a screen locally, using whichever recorder this machine has.

    uv run --script record.py detect          # what can this machine deliver?
    uv run --script record.py start           # start, on the best backend
    uv run --script record.py status
    uv run --script record.py stop            # prints the file it wrote

Recording is optional — the plugin's job is transcription, and a file you
already have needs none of this. OBS is supported properly because it is the
only cross-platform recorder that separates your microphone from the far end,
which is what deterministic speaker labels need; it stays one backend among
several rather than a dependency.

`detect` is the important subcommand. It reports what each backend would
*actually* give you, so nobody discovers after an hour-long call that the file
cannot tell four people apart.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lt import recorders  # noqa: E402
from lt.archive import copy_recording  # noqa: E402
from lt.recorders import RecorderError  # noqa: E402

CONSENT = (
    "Recording other people: say out loud that you are recording and get "
    "agreement before you start. A local screen recording of a Meet call is "
    "invisible to the other participants — Meet's own recording shows them an "
    "indicator, this shows them nothing. See references/consent.md."
)

REFUSED = 3  # nothing was recorded, and the reason is printed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="record", description=__doc__.split("\n")[0])
    parser.add_argument(
        "action", choices=("detect", "start", "stop", "status"),
        help="detect reports every backend's real capability; start/stop/status drive one",
    )
    parser.add_argument(
        "--backend", default=None,
        help=f"pin a backend ({', '.join(recorders.BACKENDS)}); default is to negotiate",
    )
    parser.add_argument(
        "--mic-only", action="store_true",
        help="accept a microphone-only recording, where the far end will be silent",
    )
    parser.add_argument(
        "--dictation", dest="mic_only", action="store_true",
        help="alias for --mic-only: you are recording yourself, nobody else",
    )
    parser.add_argument(
        "--archive-dir", type=Path, default=None,
        help="copy the finished recording here (default: LOCAL_TRANSCRIBE_ARCHIVE_DIR, else no copy)",
    )
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    return parser.parse_args(argv)


def render_capabilities(reports: list[recorders.Capabilities]) -> str:
    lines = []
    for report in reports:
        mark = "✅" if report.available else "⛔"
        lines.append(f"{mark} {report.name}")
        if report.available:
            audio = []
            audio.append("mic" if report.mic else "no mic")
            audio.append("system audio" if report.system_audio else "NO system audio")
            if report.separate_tracks:
                audio.append("separate tracks")
            lines.append(f"    captures: {'video, ' if report.video else ''}{', '.join(audio)}")
            lines.append(f"    input shape: {report.shape or 'unknown'}")
            lines.append(f"    speaker labels: {report.label_quality}")
            if not report.can_record_a_call:
                lines.append("    ⚠️ cannot record a call — the far end would be silent")
        for blocker in report.blockers:
            for i, part in enumerate(blocker.splitlines()):
                lines.append(f"    {'blocked: ' if i == 0 else '          '}{part}")
        for note in report.notes:
            lines.append(f"    note: {note}")
    return "\n".join(lines)


def resolve(args: argparse.Namespace, *, for_a_call: bool) -> recorders.Recorder:
    if args.backend:
        recorder = recorders.get(args.backend)
        report = recorder.capabilities()
        if not report.available:
            raise RecorderError(
                f"Backend {args.backend!r} is not usable on this machine:\n"
                + "\n".join(f"  {b}" for b in report.blockers)
            )
        return recorder

    recorder, reports = recorders.choose(for_a_call=for_a_call)
    if recorder is None:
        raise RecorderError(
            "No recorder on this machine can capture a call — every available "
            "backend would record your microphone and leave the other "
            "participants silent.\n\n" + render_capabilities(reports) +
            "\n\nEither fix one of the above, or pass --mic-only if a "
            "microphone-only recording is what you actually want."
        )
    return recorder


def report_recording(rec: recorders.Recording, *, as_json: bool) -> None:
    if as_json:
        print(json.dumps({
            "backend": rec.backend,
            "path": str(rec.path) if rec.path else None,
            "active": rec.active,
            "duration": rec.duration,
            "bytes": rec.bytes_written,
            "notes": rec.notes,
        }, indent=2))
        return
    state = "recording" if rec.active else "stopped"
    print(f"{rec.backend}: {state}", file=sys.stderr)
    if rec.duration:
        print(f"  duration: {rec.duration:.0f}s", file=sys.stderr)
    if rec.bytes_written is not None:
        print(f"  size: {rec.bytes_written / 1_048_576:.1f} MiB", file=sys.stderr)
    for note in rec.notes:
        print(f"  {note}", file=sys.stderr)
    if rec.path:
        print(rec.path)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if args.action == "detect":
        reports = recorders.survey()
        if args.json:
            print(json.dumps([r.as_dict() for r in reports], indent=2))
        else:
            print(render_capabilities(reports))
            if pin := recorders.pinned():
                print(f"\nLOCAL_TRANSCRIBE_RECORDER pins: {pin}")
            usable = [r.name for r in reports if r.can_record_a_call]
            print(
                f"\nCan record a call: {', '.join(usable) if usable else 'none of them'}"
            )
        return 0

    try:
        if args.action == "start":
            recorder = resolve(args, for_a_call=not args.mic_only)
            print(CONSENT, file=sys.stderr)
            print("", file=sys.stderr)
            rec = recorder.start(mic_only_ok=args.mic_only)
            report_recording(rec, as_json=args.json)
            return 0

        if args.action == "status":
            recorder = recorders.get(args.backend) if args.backend else None
            if recorder is None:
                for name in recorders.PREFERENCE:
                    candidate = recorders.get(name)
                    try:
                        rec = candidate.status()
                    except RecorderError:
                        continue
                    if rec.active:
                        report_recording(rec, as_json=args.json)
                        return 0
                print("Nothing is recording.", file=sys.stderr)
                return 0
            report_recording(recorder.status(), as_json=args.json)
            return 0

        # stop
        recorder = recorders.get(args.backend) if args.backend else None
        if recorder is None:
            for name in recorders.PREFERENCE:
                candidate = recorders.get(name)
                try:
                    if candidate.status().active:
                        recorder = candidate
                        break
                except RecorderError:
                    continue
        if recorder is None:
            print("Nothing is recording, so there is nothing to stop.", file=sys.stderr)
            return REFUSED

        rec = recorder.stop()
        report_recording(rec, as_json=args.json)
        if rec.path:
            result = copy_recording(rec.path, args.archive_dir)
            print(f"  {result.message}", file=sys.stderr)
            print(
                "  Transcribe it with: transcribe.py "
                f"'{rec.path}' --probe-only", file=sys.stderr,
            )
        return 0

    except RecorderError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return REFUSED


if __name__ == "__main__":
    sys.exit(main())
