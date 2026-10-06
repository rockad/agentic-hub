#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = [
#   "imageio-ffmpeg>=0.5",
#   "numpy>=1.24",
#   "sherpa-onnx>=1.12",
#   "mlx-whisper>=0.4 ; sys_platform == 'darwin' and platform_machine == 'arm64'",
#   "faster-whisper>=1.1 ; sys_platform != 'darwin'",
# ]
# ///
"""Transcribe an audio or video file entirely on this machine.

Nothing leaves the laptop: speech recognition runs on weights downloaded once,
speaker separation runs on two small ONNX models downloaded once, and the
on-screen text reader runs on a local Ollama.

    uv run --script transcribe.py memo.m4a --dictation           # one speaker
    uv run --script transcribe.py meeting.m4a --speakers 3        # three people
    uv run --script transcribe.py call.mkv                       # OBS two-track
    uv run --script transcribe.py demo.mkv --no-ocr              # skip the screen

A recording with a picture has two channels of meaning and only one of them is
speech, so a file with video also gets its screen read: the frames where the
picture changed go to a local vision model, and what it reads lands in its own
section. That stage is on by default and `--no-ocr` turns it off, which is the
right flag for a talking-head recording where the screen carries nothing.

Three labelling paths, best first:

    two audio streams   Me / Remote — checked by sampling both streams and
                         comparing them; only used once they are found to
                         actually differ (see lt/mixcheck.py)
    one mixed stream    Speaker 1..N from the diarizer, with --speakers as a hint
    --dictation         one speaker, no labels at all

A stream count is not a source count: a two-track OBS recording made from one
microphone can write two audio streams that both carry the identical mix, and
labelling them per-track would attribute one person's words to the other. So
before the "two audio streams" path is trusted, the streams are sampled and
compared; only once they are found to genuinely differ are `Me` / `Remote`
handed out.

What it will not do otherwise is guess which shape a file is. A one-stream
audio file is byte-for-byte the same shape whether it holds a dictated memo or
six people round a table microphone, so with no instruction it stops and asks
rather than rendering a meeting as one unlabelled wall of text that reads as
fine.

A diarized speaker can also be **named from an enrolled voice print**, so
`Speaker 1` becomes a real name rather than staying numbered:

    uv run --script transcribe.py memo.m4a --enroll 'Alice'
    uv run --script transcribe.py call.m4a --speakers 2 \
        --enroll-from-speaker 2 --enroll 'Bob'
    uv run --script transcribe.py meeting.m4a --speakers 3   # named automatically

`--enroll` computes and stores a print, then exits without transcribing;
`--enroll-from-speaker` builds it from one diarized cluster of a multi-speaker
file instead of the whole thing. Every later run with `--speakers`/`--diarize`
then names any cluster that matches an enrolled print closely enough, and
leaves the rest numbered — see `lt/voices.py` for the mechanism and the
privacy design, which is deliberate: prints are biometric data, stored only
locally, and never created as a side effect of anything else this script does.

A remaining numbered speaker can also be **named from context, with no voice
ever fingerprinted**:

    uv run --script transcribe.py call.m4a --speakers 2 \
        --attendees 'Ada Lovelace,Alan Turing'

`--attendees` names a speaker by elimination once every other speaker on the
call is named (an enrolled print handles the common case of naming yourself),
by a self-introduction, or by being addressed by name — never by guessing
between two candidates that both fit, which is reported instead as part of
the verification block below, carrying the evidence for whoever is still
`Speaker N`. See `lt/naming.py` for the precedence and the reasoning.

`--names-file PATH` is a separate, opt-in fix for a different problem:
recognition mangling a name it has never seen. It applies whole-word spelling
corrections you supply yourself — see `references/known-names.example.txt`
and `lt/spelling.py` — and never invents a correction on its own.

Everything a run was uncertain about — an unresolved speaker, a shaky voice
match, a stretch of speech nobody could be matched to, a possibly mis-heard
name, a term spelled two ways — lands in one `## Needs a quick look` block at
the end of the transcript and one line on stderr, answerable in a single
reply. It never delays or withholds the transcript itself; `--verify` is on
by default and `--no-verify` turns it off. See `lt/verify.py`.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lt import asr, diarize as diarize_mod, label, media, mixcheck, naming, ocr, quality  # noqa: E402
from lt import rerender as rerender_mod, spelling, transcript, verify, voices  # noqa: E402
from lt.ffmpeg import FfmpegMissing, ffmpeg_path, ffprobe_path  # noqa: E402

NOT_YET = 3  # exit code for an input shape this version cannot label honestly


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="transcribe",
        description="Transcribe an audio or video file locally.",
    )
    parser.add_argument(
        "input", type=Path, nargs="?", default=None,
        help="the audio or video file (not needed with --list-voices or --forget)",
    )
    parser.add_argument(
        "--out", type=Path, default=None,
        help="directory for the transcript (default: beside the input file)",
    )
    parser.add_argument(
        "--dictation", action="store_true",
        help="the recording has one speaker; skip speaker separation",
    )
    parser.add_argument(
        "--speakers", type=int, default=None,
        help="how many speakers to expect; 1 is the same as --dictation, "
             "more than 1 turns speaker separation on with that count",
    )
    parser.add_argument(
        "--diarize", action="store_true",
        help="separate speakers without saying how many there are",
    )
    parser.add_argument(
        "--names", default=None,
        help="comma-separated real names for Speaker 1, 2, … in order of first "
             "appearance, e.g. --names 'Alice,Bob'",
    )
    parser.add_argument(
        "--attendees", default=None,
        help="comma-separated names of everyone on the call, e.g. "
             "'Ada Lovelace,Alan Turing' — names any speaker context settles: "
             "by elimination once every other speaker is named, or from a "
             "self-introduction or being addressed by name. Never guesses "
             "between candidates; an unsettled speaker is reported in an "
             "'Unresolved speakers' section instead of --names 1-2-3 order",
    )
    parser.add_argument(
        "--names-file", type=Path, default=None, metavar="PATH",
        help="opt-in spelling correction for proper nouns recognition mangles "
             "— 'Correct Spelling: misheard one, misheard two' per line, or a "
             "Markdown file whose body holds a canonical/renderings table, "
             "applied as whole-word substitution; see "
             "references/known-names.example.txt and lt/spelling.py",
    )
    parser.add_argument(
        "--speaker-threshold", type=float, default=None,
        help=f"cosine threshold when the count is unknown (default "
             f"{diarize_mod.DEFAULT_THRESHOLD}); lower splits one voice into "
             f"several, higher merges two into one",
    )
    parser.add_argument(
        "--enroll", default=None, metavar="NAME",
        help="enrol a voice print under this name from this file, and exit "
             "without transcribing; on a file with several speakers, pair "
             "with --enroll-from-speaker",
    )
    parser.add_argument(
        "--enroll-from-speaker", type=int, default=None, metavar="N",
        help="which diarized speaker (1, 2, …) to enrol with --enroll, on a "
             "file that has several — read a transcript of it first to know "
             "which numbered speaker is who",
    )
    parser.add_argument(
        "--list-voices", action="store_true",
        help="print the enrolled voices (name, source, model, date) and exit",
    )
    parser.add_argument(
        "--forget", default=None, metavar="NAME",
        help="delete an enrolled voice's print and exit",
    )
    parser.add_argument(
        "--rerender", type=Path, default=None, metavar="TRANSCRIPT",
        help="rebuild an existing transcript's 'Needs a quick look' block "
             "from its own turn lines and exit; no audio, no recognition",
    )
    parser.add_argument(
        "--identify", action=argparse.BooleanOptionalAction, default=True,
        help="name a diarized speaker when it matches an enrolled voice "
             "(default on); naming only ever happens for someone enrolled, "
             "and only when the match is unambiguous",
    )
    parser.add_argument(
        "--verify", action=argparse.BooleanOptionalAction, default=True,
        help="collect everything the run was uncertain about — an unresolved "
             "speaker, a shaky voice match, unattributed speech, a possibly "
             "mis-heard name, a term spelled two ways — into one block at "
             "the end of the transcript and on stderr (default on); the "
             "transcript is complete either way, this only adds the ask",
    )
    parser.add_argument("--language", default=None, help="ISO code, e.g. en, fi, ru")
    parser.add_argument("--engine", default=None, help="mlx-whisper | faster-whisper")
    parser.add_argument("--model", default=None, help="engine-specific model name")
    parser.add_argument(
        "--stream", type=int, default=None,
        help="transcribe only this audio stream of a multi-stream container",
    )
    parser.add_argument(
        "--me-stream", type=int, default=0,
        help="which audio stream is your own microphone in a multi-stream "
             "recording (default 0, which is OBS track 1)",
    )
    parser.add_argument(
        "--no-ocr", action="store_true",
        help="do not read the text on the screen, even though the file has video",
    )
    parser.add_argument(
        "--ocr", action="store_true",
        help="read the on-screen text and fail if the vision model is missing "
             "(it is on by default for a file with video, and skipped with a "
             "note when the model is not pulled)",
    )
    parser.add_argument(
        "--ocr-model", default=None,
        help=f"vision model for the on-screen text (default {ocr.DEFAULT_MODEL}; "
             f"{ocr.FALLBACK_MODEL} is the small one)",
    )
    parser.add_argument(
        "--ocr-scene", type=float, default=ocr.DEFAULT_SCENE,
        help=f"how much of the frame must change to count as a new screen "
             f"(default {ocr.DEFAULT_SCENE}; lower reads more frames)",
    )
    parser.add_argument(
        "--ocr-interval", type=float, default=None,
        help="read a frame every N seconds instead of on change — for a "
             "recording that never scene-changes, such as a scrolling document",
    )
    parser.add_argument(
        "--ocr-min-gap", type=float, default=ocr.DEFAULT_MIN_GAP,
        help=f"seconds that must pass before another frame is read "
             f"(default {ocr.DEFAULT_MIN_GAP})",
    )
    parser.add_argument(
        "--ocr-backstop", type=float, default=ocr.DEFAULT_BACKSTOP,
        help=f"read a frame at least this often even when nothing changed "
             f"(default {ocr.DEFAULT_BACKSTOP:.0f}s; 0 turns it off), so a deck "
             f"left on one slide is not read once and called unchanging",
    )
    parser.add_argument(
        "--ocr-max-frames", type=int, default=ocr.DEFAULT_MAX_FRAMES,
        help=f"most frames to read, spread across the recording "
             f"(default {ocr.DEFAULT_MAX_FRAMES})",
    )
    parser.add_argument(
        "--probe-only", action="store_true",
        help="report what the file contains and exit",
    )
    return parser.parse_args(argv)


def describe(probe: media.Probe) -> str:
    parts = [
        f"{probe.path.name}: {transcript.hhmmss(probe.duration)}",
        f"shape {probe.shape}",
        f"{len(probe.audio)} audio stream(s)",
    ]
    if probe.audio:
        first = probe.audio[0]
        parts.append(f"{first.sample_rate} Hz, {first.channels} ch, {first.codec}")
    if probe.has_video:
        parts.append("video present")
    return " · ".join(parts)


def refuse(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return NOT_YET


class Plan:
    """What the run will do, decided once from the file and the flags.

    `mode` is one of:

        dictation    one speaker, no labels
        diarize      one mixed stream, labels from the diarizer
        streams      one recognition per audio stream, labels by construction
        screen       no audio at all; the screen is the whole recording
    """

    def __init__(
        self,
        mode: str,
        *,
        speakers: int | None = None,
        mix_skipped: str | None = None,
        stream: int | None = None,
    ) -> None:
        self.mode = mode
        self.speakers = speakers
        # Set only when this plan was reached from a multi-stream file whose
        # streams turned out to be the same mix, or to hold no audio at all —
        # carries why the "streams" path was not used, so the transcript
        # header can say so.
        self.mix_skipped = mix_skipped
        # Which audio stream to transcribe, when the file has several and only
        # one of them holds anything. Without this the run would default to
        # stream 0 and transcribe silence whenever the live track is not the
        # first one.
        self.stream = stream


def gate(
    probe: media.Probe,
    args: argparse.Namespace,
    *,
    want_ocr: bool = False,
    mix_reports: list[mixcheck.MixReport] | None = None,
) -> tuple[int | None, Plan | None]:
    """Decide whether this version can transcribe this file honestly."""
    single = args.dictation or args.speakers == 1
    wants_labels = args.diarize or (args.speakers or 0) > 1

    if probe.shape == "F":
        # A silent screen recording used to be refused outright. With the
        # on-screen text reader there is now something real to produce from
        # it — a slide deck, a demo, a terminal session — so it is refused
        # only when the one stage that could read it has been turned off.
        if want_ocr:
            return None, Plan("screen")
        return refuse(
            f"{probe.path.name} has a video stream and no audio, so there is "
            "nothing to transcribe and --no-ocr turned off the one stage that "
            "could have read the screen. Drop --no-ocr to read the on-screen text."
        ), None

    if not probe.audio:
        return refuse(f"no audio stream found in {probe.path.name}"), None

    # Two or more streams — what a two-track recorder such as OBS produces.
    # A stream count is not a source count, though: a two-track recording made
    # from one microphone can write two streams that both carry the identical
    # mix, and only the samples say which this file is (see lt/mixcheck.py).
    # `mix_reports` carries that finding in; when it says "mixed" the
    # container cannot be trusted to label itself, and this falls back to
    # exactly the same question a genuine single-stream file would ask.
    if len(probe.audio) >= 2 and args.stream is None:
        status = mixcheck.overall_status(mix_reports) if mix_reports else "inconclusive"

        if status == "mixed":
            if single:
                return None, Plan("dictation", mix_skipped=status)
            if wants_labels:
                return None, Plan("diarize", speakers=args.speakers, mix_skipped=status)
            return refuse(
                f"{probe.path.name} carries {len(probe.audio)} audio streams, but "
                "sampling and comparing them shows they carry the same mixed audio, "
                "not separate sources — one microphone recorded everyone, and "
                "whatever wrote this file copied that mix onto every track. "
                "Me / Remote labels from it would be a guess dressed up as a fact, "
                "which is why this refuses rather than producing them.\n"
                "Say which it is instead:\n"
                "  --dictation            one speaker, no labels\n"
                "  --speakers 3           three people, labelled Speaker 1–3\n"
                "  --diarize              several people, let the model count them\n"
                "For real per-track labels on the next recording, see SETUP.md §4.3 — "
                "route each source to its own track in OBS (Advanced output mode, "
                "microphone on track 1, everyone else on track 2)."
            ), None

        # A track the recorder wrote but never fed is not a source, and the
        # pair it belongs to cannot be correlated — one side has no envelope
        # to correlate against. That came back as "inconclusive", and this
        # used to treat inconclusive as licence to label by track anyway: a
        # 66-minute two-person conversation was published with every word
        # attributed to `Me`, because the other track was digital silence.
        #
        # So the streams that hold nothing are dropped, and what is left
        # decides. One real stream is a single-source file and asks the same
        # question any single-stream file asks; nothing conclusive about two
        # real streams is not a basis for labelling either of them.
        live = mixcheck.carrying_audio(mix_reports or [], len(probe.audio))
        if len(live) == 1:
            only = live[0]
            silent = ", ".join(str(i) for i in mixcheck.silent_streams(mix_reports or []))
            if single:
                return None, Plan("dictation", mix_skipped="silent", stream=only)
            if wants_labels:
                return None, Plan(
                    "diarize", speakers=args.speakers, mix_skipped="silent", stream=only
                )
            return refuse(
                f"{probe.path.name} carries {len(probe.audio)} audio streams, but "
                f"stream {silent} holds no audio at all — the recorder wrote a "
                f"track it never fed. Only stream {only} has anything on it, so "
                "this is a single-source recording however many tracks it "
                "advertises, and Me / Remote labels from it would put both "
                "people's words on one of them.\n"
                "Say what is on it instead:\n"
                "  --dictation            one speaker, no labels\n"
                "  --speakers 2           two people, labelled Speaker 1–2\n"
                "  --diarize              several people, let the model count them\n"
                "For real per-track labels on the next recording, check in OBS "
                "that each source is actually routed to its own track and that "
                "both tracks show level while you speak."
            ), None

        if status == "inconclusive":
            if single:
                return None, Plan("dictation", mix_skipped=status)
            if wants_labels:
                return None, Plan("diarize", speakers=args.speakers, mix_skipped=status)
            return refuse(
                f"{probe.path.name} carries {len(probe.audio)} audio streams, but "
                "they could not be compared, so whether they hold separate "
                "sources is unknown. Labelling by track would be a guess "
                "presented as a fact.\n"
                "Say what is on it instead:\n"
                "  --dictation            one speaker, no labels\n"
                "  --speakers 2           two people, labelled Speaker 1–2\n"
                "  --diarize              several people, let the model count them\n"
                "  --stream 0             transcribe one track on its own"
            ), None

        qualifier = "checked and found to carry separate sources"
        if single:
            return refuse(
                f"{probe.path.name} carries {len(probe.audio)} audio streams "
                f"({qualifier}), which is one source per stream — so it is not a "
                "single-speaker recording.\n"
                "Drop --dictation to get Me / Remote labels, or pass --stream 0 "
                "(or 1) to transcribe one side of it on its own."
            ), None
        return None, Plan("streams")

    if probe.shape == "C" and args.stream is None and not single and not wants_labels:
        first = probe.audio[0]
        return refuse(
            f"{probe.path.name} has one {first.channels}-channel audio stream. On some "
            "setups — a macOS aggregate device, for one — those channels map to separate "
            "sources, and downmixing them would throw away the speaker split.\n"
            "Mapping channels to speakers is not built. Either:\n"
            "  --dictation            downmix and transcribe as one speaker\n"
            "  --speakers N           downmix and separate the voices with the diarizer\n"
            "  --stream 0             transcribe one stream only"
        ), None

    if single:
        return None, Plan("dictation")

    if wants_labels:
        return None, Plan("diarize", speakers=args.speakers)

    return refuse(
        f"{probe.path.name} is a single audio stream, which is the same shape whether "
        "it is a dictated memo or six people round a table mic — the container cannot "
        "tell them apart, and defaulting the choice either way is wrong half the time.\n"
        "Say which it is:\n"
        "  --dictation            one speaker, no labels\n"
        "  --speakers 3           three people, labelled Speaker 1–3\n"
        "  --diarize              several people, let the model count them"
    ), None


def recognise(wav: Path, args: argparse.Namespace) -> asr.Recognition:
    # `vocabulary_prompt` is derived from --names-file once in main() and
    # carried on args alongside the flags it came from, because every call
    # site here already passes args as the bundle of what the run was asked
    # to do. Priming is the half of that file which fixes recognition rather
    # than repairing its output, so it has to reach the decoder, not only
    # the text afterwards.
    return asr.transcribe(
        wav,
        engine=args.engine,
        model=args.model,
        language=args.language,
        initial_prompt=getattr(args, "vocabulary_prompt", None),
    )


def mix_verification_note(mix_reports: list[mixcheck.MixReport] | None) -> str:
    """What the header can honestly say about whether the streams were checked.

    This is the wording that used to be an unconditional "deterministic, no
    model" — a claim the plugin could not actually back up, since it never
    looked at the samples. Now it says exactly what ran: the correlation
    scores if the check completed, or that it could not be completed, never
    a guarantee stronger than what was measured.
    """
    if not mix_reports:
        return "not checked for a shared mix"
    scored = [r for r in mix_reports if r.status != "inconclusive"]
    if not scored:
        # Unreachable from the per-stream path since an inconclusive check no
        # longer reaches it, and worded for the case where it is read anyway:
        # never as a claim that the streams were separate.
        return "checked, but inconclusive — the streams were never established "\
               "as separate sources"
    pairs = ", ".join(f"{r.stream_a}/{r.stream_b}: {r.score:.2f}" for r in scored)
    return (
        f"checked and found distinct (envelope correlation {pairs}, "
        f"threshold {mixcheck.SAME_MIX_THRESHOLD:.2f})"
    )


def stream_label(index: int, me_stream: int, total: int) -> str:
    """`Me` for your own microphone, `Remote` for the other side."""
    if index == me_stream:
        return "Me"
    if total <= 2:
        return "Remote"
    others = [i for i in range(total) if i != me_stream]
    return f"Remote {others.index(index) + 1}"


def run_ocr(
    source: Path, args: argparse.Namespace, model: str, work: Path
) -> ocr.OcrResult:
    """Read the screen, reporting each frame as it goes.

    The per-frame line is not decoration: a vision model takes seconds per
    frame, so a run with forty frames is minutes of apparent silence, and a
    person watching needs to see it is progressing rather than hung.
    """
    def progress(index: int, total: int, at: float, chars: int) -> None:
        found = f"{chars} characters" if chars else "no text"
        print(
            f"  frame {index}/{total} at {transcript.hhmmss(at)} — {found}",
            file=sys.stderr,
        )

    result = ocr.read(
        source, work,
        model=model,
        scene=args.ocr_scene,
        min_gap=args.ocr_min_gap,
        interval=args.ocr_interval,
        backstop=args.ocr_backstop,
        max_frames=args.ocr_max_frames,
        progress=progress,
    )
    if result.ran:
        where = f" on the {result.device}" if result.device else ""
        print(
            f"read {len(result.slides)} distinct screen(s) from "
            f"{result.frames_read} frame(s){where}",
            file=sys.stderr,
        )
    return result


def screen_only(
    probe: media.Probe, args: argparse.Namespace, model: str
) -> int:
    """A recording with no audio at all: the screen is the whole document."""
    print(
        f"no audio stream — reading the screen only, with {model}…",
        file=sys.stderr,
    )
    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix="local-transcribe-ocr-") as tmp:
            result = run_ocr(args.input, args, model, Path(tmp))
    except ocr.OcrUnavailable as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if result.skipped_because:
        print(f"error: {result.skipped_because}", file=sys.stderr)
        return 2
    if not result.slides:
        print(
            f"error: {probe.path.name} has no audio, and no legible text was "
            "found on any of the frames that were read — so there is nothing "
            "to write. Try --ocr-scene 0.05 to read more frames, or "
            "--ocr-interval 10 if the picture never changes abruptly.",
            file=sys.stderr,
        )
        return NOT_YET

    recognition = asr.Recognition(
        segments=[], language=None, engine="none (no audio)",
        model="none", device="n/a",
    )

    elapsed = time.monotonic() - started
    print(f"read the screen in {elapsed:.0f}s", file=sys.stderr)

    rendered = transcript.render(
        probe, recognition,
        single_speaker=False,
        speakers_note="none — this recording has no audio",
        ocr=result,
    )
    destination = (args.out or args.input.parent) / f"{args.input.stem}.transcript.md"
    transcript.write(destination, rendered)
    print(destination)
    return 0


def list_voices_command() -> int:
    prints = voices.list_voices()
    if not prints:
        print(f"no voices enrolled in {voices.voices_dir()}")
        return 0
    print(f"{len(prints)} voice(s) enrolled in {voices.voices_dir()}:")
    for print_ in prints:
        print(
            f"  {print_.name} — {print_.seconds:.0f}s from {print_.source}, "
            f"{print_.embedding_model}, enrolled {print_.enrolled}"
        )
    return 0


def forget_command(name: str) -> int:
    if voices.forget_voice(name):
        print(f"forgot {name}")
        return 0
    print(f"error: no voice enrolled as {name!r}", file=sys.stderr)
    return 2


def rerender_command(path: Path, names_file: Path | None) -> int:
    """Rebuild one transcript's quick-look block from its own turn lines.

    No audio is opened and no model is loaded, so this is the way to see a
    detector change against real speech without paying for recognition
    again. It rewrites the file in place; the transcript text itself is
    untouched, only the section that asks questions about it.
    """
    if not path.exists():
        print(f"error: no such file: {path}", file=sys.stderr)
        return 2

    known_terms: set[str] = set()
    if names_file is not None:
        if not names_file.exists():
            print(f"error: no such file: {names_file}", file=sys.stderr)
            return 2
        for correction in spelling.parse_names_file(names_file):
            known_terms.add(correction.correct)
            known_terms.update(correction.misheard)

    text = path.read_text(encoding="utf-8")
    updated, report = rerender_mod.rebuild(
        text, known_terms=known_terms, names_file=names_file
    )
    if not report.utterances:
        print(f"error: no turn lines found in {path.name}", file=sys.stderr)
        return 2

    path.write_text(updated, encoding="utf-8")
    print(
        f"rerendered {report.utterances} turn(s), {report.speakers} speaker(s): "
        f"quick-look block {report.before_lines} -> {report.after_lines} line(s), "
        f"{report.manglings} mangling(s), {report.casing_groups} casing group(s)",
        file=sys.stderr,
    )
    print(
        "note: speaker-identification checks are not re-run — a transcript "
        "records no similarity scores, so any low-confidence or unresolved "
        "section from the original run is dropped rather than guessed at",
        file=sys.stderr,
    )
    print(path)
    return 0


def run_enroll(args: argparse.Namespace, probe: media.Probe) -> int:
    """Compute and store a voice print, then exit without transcribing.

    Enrolment is its own action rather than a flag layered onto a normal run:
    a print is derived from one speaker's audio and filed once, and folding
    that into the transcription path would make `--enroll` interact with
    every other flag — `--ocr`, `--stream`, the labelling paths — for no
    benefit, since none of them touch what gets stored.

    `--enroll-from-speaker` re-diarizes the file with whatever
    `--speakers`/`--diarize`/`--speaker-threshold` were given, or the
    auto-clustering default if none were. That repeats work a transcription
    run already did, deliberately: clustering is deterministic for a given
    file and those parameters (see `lt.voices.enroll_from_speaker`), so the
    speaker numbers match whatever transcript the user already read to know
    which one to enrol.
    """
    if not probe.audio:
        print(f"error: no audio stream found in {probe.path.name}", file=sys.stderr)
        return 2

    try:
        with tempfile.TemporaryDirectory(prefix="local-transcribe-enroll-") as tmp:
            wav = media.extract_wav(
                args.input, Path(tmp) / "audio.wav", stream=args.stream or 0
            )
            if args.enroll_from_speaker is not None:
                hint = (
                    f"{args.speakers} speakers" if args.speakers
                    else "an unknown number of speakers"
                )
                print(
                    f"separating {hint} to isolate speaker "
                    f"{args.enroll_from_speaker} "
                    f"(sherpa-onnx on {diarize_mod.resolve_provider()})…",
                    file=sys.stderr,
                )
                turns = diarize_mod.diarize(
                    wav, speakers=args.speakers, threshold=args.speaker_threshold
                )
                vector, seconds, model = voices.enroll_from_speaker(
                    wav, turns, args.enroll_from_speaker
                )
            else:
                print("finding speech to enrol from…", file=sys.stderr)
                vector, seconds, model = voices.enroll_from_file(wav)
    except (diarize_mod.DiarizationUnavailable, voices.VoiceStoreError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print_ = voices.enroll(args.enroll, vector, seconds, model, args.input.name)
    print(
        f"enrolled {print_.name}: {print_.seconds:.0f}s of speech from "
        f"{args.input.name}, {print_.embedding_model} → "
        f"{voices.path_for(print_.name)}",
        file=sys.stderr,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if args.list_voices:
        return list_voices_command()
    if args.forget:
        return forget_command(args.forget)
    if args.rerender is not None:
        return rerender_command(args.rerender, args.names_file)

    if args.enroll_from_speaker is not None and not args.enroll:
        print("error: --enroll-from-speaker needs --enroll NAME", file=sys.stderr)
        return 2
    if args.enroll is not None and not args.enroll.strip():
        print("error: --enroll needs a name", file=sys.stderr)
        return 2
    if args.enroll_from_speaker is not None and args.enroll_from_speaker < 1:
        print("error: --enroll-from-speaker must be 1 or more", file=sys.stderr)
        return 2

    if args.input is None:
        print(
            "error: an input file is required (--list-voices and --forget "
            "are the only commands that don't need one)",
            file=sys.stderr,
        )
        return 2

    if args.dictation and args.diarize:
        print(
            "error: --dictation and --diarize contradict each other. --dictation "
            "says one speaker, --diarize says separate them.",
            file=sys.stderr,
        )
        return 2
    if args.speakers is not None and args.speakers < 1:
        print("error: --speakers must be 1 or more", file=sys.stderr)
        return 2
    if args.ocr and args.no_ocr:
        print(
            "error: --ocr and --no-ocr contradict each other.",
            file=sys.stderr,
        )
        return 2

    names_file_corrections: list[spelling.Correction] | None = None
    if args.names_file is not None:
        if not args.names_file.exists():
            print(f"error: no such file: {args.names_file}", file=sys.stderr)
            return 2
        try:
            names_file_corrections = spelling.parse_names_file(args.names_file)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        args.vocabulary_prompt = spelling.prompt_from(names_file_corrections)
        if args.vocabulary_prompt:
            # Say how many of the list actually reached the recogniser, not
            # how many the file holds. The prompt window is finite and a long
            # list is truncated by the decoder, so reporting the file's size
            # would overstate what was primed — the same overstatement that
            # made an earlier version of this line misleading.
            primed = len(spelling.primed_terms(names_file_corrections))
            total = len(names_file_corrections)
            shortfall = (
                f" ({total - primed} more listed than the prompt window fits, "
                "and they are corrected after recognition instead)"
                if primed < total else ""
            )
            print(
                f"priming {primed} term(s) from {args.names_file.name} "
                f"before recognition{shortfall}",
                file=sys.stderr,
            )

    if not args.input.exists():
        print(f"error: no such file: {args.input}", file=sys.stderr)
        return 2

    try:
        ffmpeg_path()
    except FfmpegMissing as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    try:
        probe = media.probe(args.input)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(describe(probe), file=sys.stderr)
    if not ffprobe_path():
        print("note: no ffprobe; stream facts came from ffmpeg -i", file=sys.stderr)

    if args.enroll:
        return run_enroll(args, probe)

    # A stream count is not a source count (see lt/mixcheck.py's docstring for
    # the recording that proved it): before any per-track Me / Remote label is
    # even considered, sample a handful of short windows from each pair of
    # streams and check whether they are actually different audio. This is
    # cheap — a few seconds regardless of file size, because it never decodes
    # more than the sampled windows — so it runs whenever there is more than
    # one stream, including under --probe-only.
    mix_reports: list[mixcheck.MixReport] | None = None
    if len(probe.audio) >= 2:
        print("checking whether the audio streams are separate sources…", file=sys.stderr)
        try:
            mix_reports = mixcheck.classify(args.input, len(probe.audio), probe.duration)
        except mixcheck.MixCheckUnavailable as exc:
            print(f"note: could not check the streams against each other — {exc}", file=sys.stderr)
        else:
            for report in mix_reports:
                print(f"  {report.describe()}", file=sys.stderr)

    if args.probe_only:
        return 0

    if args.ocr and not probe.has_video:
        print(
            f"error: --ocr was given but {probe.path.name} has no video stream, "
            "so there is no screen to read.",
            file=sys.stderr,
        )
        return 2

    # On by default wherever there is a screen to read, off on request. The
    # model being absent is not the same as the user declining the stage, so
    # the two are settled separately: this decides what was asked for, and the
    # preflight below decides what can actually run.
    want_ocr = probe.has_video and not args.no_ocr
    ocr_model = args.ocr_model or ocr.default_model()

    code, plan = gate(probe, args, want_ocr=want_ocr, mix_reports=mix_reports)
    if code is not None or plan is None:
        return code if code is not None else NOT_YET

    if args.attendees and plan.mode != "diarize":
        # `Me`/`Remote` are already facts about which stream the audio came
        # from, and dictation has only one speaker — naming from context has
        # nothing numbered to work on in either case, so this says so rather
        # than silently doing nothing with a flag the user did pass.
        print(
            f"note: --attendees has nothing to name here — this file's "
            f"speakers came from {plan.mode}, not from --speakers/--diarize",
            file=sys.stderr,
        )

    ocr_skipped: str | None = None
    if want_ocr:
        # Asked before recognition rather than discovered after it: pulling a
        # vision model is six gigabytes, and finding that out at the end of an
        # hour of transcription is finding it out at the worst moment.
        if reason := ocr.preflight(ocr_model):
            if args.ocr or plan.mode == "screen":
                # Either explicitly asked for, or the only stage this file has.
                print(f"error: {reason}", file=sys.stderr)
                return 2
            print(f"note: no on-screen text — {reason}", file=sys.stderr)
            want_ocr, ocr_skipped = False, reason
        elif plan.mode != "screen":  # the screen-only path announces itself
            how = (
                f"a frame every {args.ocr_interval:.0f}s"
                if args.ocr_interval
                else f"on scene change > {args.ocr_scene}"
            )
            print(
                f"reading on-screen text with {ocr_model} "
                f"({how}, at most {args.ocr_max_frames} frames)…",
                file=sys.stderr,
            )

    if plan.mode == "screen":
        return screen_only(probe, args, ocr_model)

    engine_name = asr.resolve_engine(args.engine)
    device_name = asr.resolve_device(engine_name)
    print(
        f"transcribing with {engine_name} / "
        f"{asr.resolve_model(engine_name, args.model)} "
        f"on {asr.accelerator_note(engine_name, device_name)}…",
        file=sys.stderr,
    )
    if engine_name == "faster-whisper" and device_name == "cpu":
        print(
            "note: no usable CUDA device, so recognition runs on the CPU — "
            "expect several times the wall clock of a GPU run",
            file=sys.stderr,
        )

    started = time.monotonic()
    utterances: list[label.Utterance] | None = None
    speakers_note: str | None = None
    speakers_found = 0
    naming_result: naming.NamingResult | None = None
    identify_matches: list[voices.SpeakerMatch] = []

    try:
        with tempfile.TemporaryDirectory(prefix="local-transcribe-") as tmp:
            work = Path(tmp)

            if plan.mode == "streams":
                total = len(probe.audio)
                per_stream: list[tuple[str, list[asr.Segment]]] = []
                recognition: asr.Recognition | None = None
                for index in range(total):
                    who = stream_label(index, args.me_stream, total)
                    print(f"  stream {index} → {who}", file=sys.stderr)
                    wav = media.extract_wav(
                        args.input, work / f"stream{index}.wav", stream=index
                    )
                    one = recognise(wav, args)
                    recognition = recognition or one
                    per_stream.append((who, one.segments))

                assert recognition is not None
                all_segments = [s for _, segments in per_stream for s in segments]
                recognition = asr.Recognition(
                    segments=sorted(all_segments, key=lambda s: s.start),
                    language=recognition.language,
                    engine=recognition.engine,
                    model=recognition.model,
                    device=recognition.device,
                )
                utterances = label.from_streams(per_stream)
                speakers_found = total
                speakers_note = (
                    f"{total} audio streams, labelled by source "
                    f"(stream {args.me_stream} is Me) — "
                    f"{mix_verification_note(mix_reports)}"
                )

            else:
                stream = args.stream if args.stream is not None else (plan.stream or 0)
                wav = media.extract_wav(args.input, work / "audio.wav", stream=stream)
                recognition = recognise(wav, args)

                if plan.mode == "diarize":
                    hint = (
                        f"{plan.speakers} speakers"
                        if plan.speakers
                        else "an unknown number of speakers"
                    )
                    print(
                        f"separating {hint} "
                        f"(sherpa-onnx on {diarize_mod.resolve_provider()})…",
                        file=sys.stderr,
                    )
                    turns = diarize_mod.diarize(
                        wav,
                        speakers=plan.speakers,
                        threshold=args.speaker_threshold,
                    )
                    found = diarize_mod.speaker_count(turns)
                    utterances = label.from_diarization(recognition.segments, turns)
                    print(
                        f"found {found} speaker(s) across {len(turns)} turn(s)",
                        file=sys.stderr,
                    )

                    # A clustering that puts nearly everything on one speaker is
                    # still reported, by `lt/quality.py`, as labels not worth
                    # trusting. What used to happen here as well was a second
                    # pass on a different embedding model, chosen from that same
                    # dominance figure — and it was a regression. The dominance
                    # measures the *clustering*, the retry treated it as evidence
                    # about the *embedding*, and the model it switched to
                    # separates voices far less well: measured on a two-person
                    # interview (2026-09-15) the default tells the speakers apart
                    # at a 1% equal-error rate and the one the retry preferred at
                    # 21%. So every recording the heuristic fired on came out
                    # labelled by the worse of the two models, while printing a
                    # line saying it had improved matters.
                    #
                    # `LOCAL_TRANSCRIBE_EMBEDDING_MODEL` remains for pinning a
                    # different model by hand, which is a decision with a reason
                    # behind it rather than a guess made from one number.
                    speakers_found = found

                    # Identification runs before naming-from-context, which
                    # runs before --names — three sources of a name, weakest
                    # last, so each can override what came before it. A name
                    # given on the command line is knowledge the user just
                    # asserted about *this* recording; naming from context
                    # (elimination, a self-introduction) is this module's own
                    # inference from the same recording; an enrolled print is
                    # a standing guess carried over from an earlier one.
                    # label.rename() maps onto speakers by position regardless
                    # of their current text, so applying it last lets an
                    # explicit --names silently win the position it names —
                    # the "always wins" rule from the identify note onward,
                    # without needing a second code path for it.
                    identify_note = None
                    if args.identify:
                        _, embedding_model = diarize_mod.ensure_models()
                        identify_result = voices.identify(
                            wav, turns, utterances, embedding_model=embedding_model
                        )
                        identify_note = identify_result.note
                        identify_matches = identify_result.matches
                        if identify_note:
                            print(identify_note, file=sys.stderr)

                    naming_note = None
                    if args.attendees:
                        attendees = naming.parse_attendees(args.attendees)
                        naming_result = naming.resolve_names(utterances, attendees)
                        if naming_result.assignments:
                            naming_note = "named from context: " + ", ".join(
                                f"{a.speaker} → {a.name} ({a.basis})"
                                for a in naming_result.assignments
                            )
                            print(naming_note, file=sys.stderr)
                        # Whatever is left unresolved is reported by the
                        # --verify pass below, alongside every other kind of
                        # uncertainty, rather than as its own separate print
                        # here — see lt/verify.py.

                    if args.names:
                        utterances = label.rename(utterances, args.names.split(","))

                    # On a two-person recording the other speaker is either a
                    # name or `Unknown` — never `Speaker 2`, which would tell
                    # the reader nothing the meeting had not already told them.
                    # This runs after every naming route, including --names, so
                    # it only ever sees what none of them could resolve.
                    unknown_note = None
                    if (replaced := naming.name_or_unknown(utterances)) is not None:
                        unknown_note = (
                            f"{replaced} could not be named from context and is "
                            f"shown as {naming.UNKNOWN_SPEAKER}, this being a "
                            "two-speaker recording where a number would say less"
                        )
                        print(unknown_note, file=sys.stderr)

                    speakers_note = (
                        f"{found} separated by sherpa-onnx diarization"
                        + (
                            f", count given as {plan.speakers}"
                            if plan.speakers
                            else ", count found by clustering"
                        )
                        + (f" — {identify_note}" if identify_note else "")
                        + (f" — {naming_note}" if naming_note else "")
                        + (f" — {unknown_note}" if unknown_note else "")
                    )
    except asr.EngineUnavailable as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except diarize_mod.DiarizationUnavailable as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if plan.mix_skipped:
        # Reached "dictation" or "diarize" from a multi-stream file whose
        # streams turned out to be the same mix — say so in the header rather
        # than leaving the reader to wonder why a multi-stream file has no
        # per-track labels.
        used = args.stream if args.stream is not None else (plan.stream or 0)
        if plan.mix_skipped == "silent":
            silent = ", ".join(
                str(i) for i in mixcheck.silent_streams(mix_reports or [])
            )
            skip_note = (
                f"{len(probe.audio)} audio streams, but stream {silent} holds no "
                f"audio at all — per-track Me / Remote labelling was skipped as "
                f"a silent track is not a source; stream {used} was transcribed"
            )
        elif plan.mix_skipped == "inconclusive":
            skip_note = (
                f"{len(probe.audio)} audio streams that could not be compared — "
                f"per-track Me / Remote labelling was skipped rather than "
                f"assumed; stream {used} was transcribed instead"
            )
        else:
            mixed_pairs = ", ".join(
                f"{r.stream_a}/{r.stream_b}: {r.score:.2f}"
                for r in (mix_reports or [])
                if r.status == "mixed"
            )
            skip_note = (
                f"{len(probe.audio)} audio streams carry the same mixed audio "
                f"({mixed_pairs}, threshold {mixcheck.SAME_MIX_THRESHOLD:.2f}) — "
                f"per-track Me / Remote labelling was skipped; stream "
                f"{used} was transcribed instead"
            )
        speakers_note = (
            f"single (dictation) — {skip_note}"
            if plan.mode == "dictation"
            else f"{speakers_note} — {skip_note}"
        )

    ocr_result: ocr.OcrResult | None = None
    if want_ocr:
        try:
            with tempfile.TemporaryDirectory(prefix="local-transcribe-ocr-") as tmp:
                ocr_result = run_ocr(args.input, args, ocr_model, Path(tmp))
        except ocr.OcrUnavailable as exc:
            # The speech is already recognised, and it is worth keeping. A
            # failed screen read costs the file its slides, not its transcript.
            print(f"warning: the screen was not read — {exc}", file=sys.stderr)
            ocr_result = ocr.OcrResult(
                slides=[], model=ocr_model, skipped_because=str(exc)
            )
    elif ocr_skipped:
        ocr_result = ocr.OcrResult(slides=[], skipped_because=ocr_skipped)

    # Judge the run before presenting any of it. A looped recognition pass
    # produces plenty of confident-looking output whose speaker labels are
    # meaningless, and saying so is the difference between a transcript and a
    # transcript-shaped lie.
    report = quality.assess(
        recognition.segments,
        utterances,
        speakers_found=speakers_found,
        requested_language=args.language,
        labels_inferred=plan.mode == "diarize",
    )
    for warning in report.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    if utterances is not None and not report.labels_trustworthy:
        speakers_note = f"{speakers_note} — NOT RELIABLE, see the warning below"

    # After quality judges the run on what recognition actually produced, and
    # before anything counts words or gets written out — a spelling fix
    # should not change whether a run looked like a repetition loop, and it
    # should be reflected in the word count the run reports about itself.
    spelling_note = "off"
    if names_file_corrections is not None:
        if utterances is not None:
            made = spelling.apply_to_utterances(utterances, names_file_corrections)
        else:
            made = spelling.apply_to_segments(recognition.segments, names_file_corrections)
        spelling_note = f"{made} substitution(s) from {args.names_file.name}"

    if utterances is not None:
        plain = " ".join(f"{u.speaker or 'Unknown'}: {u.text}" for u in utterances)
    else:
        plain = " ".join(segment.text for segment in recognition.segments)

    elapsed = time.monotonic() - started
    ratio = f"{elapsed / probe.duration:.2f}×" if probe.duration else "?"
    print(
        f"recognised {len(recognition.segments)} segment(s), "
        f"{len(plain.split())} words in {elapsed:.0f}s ({ratio} of audio duration)",
        file=sys.stderr,
    )

    verification_block = ""
    if args.verify:
        # Reuses whatever utterances the run actually produced; a dictation
        # or streams run has no diarized speaker concept at all, so it is
        # wrapped as unlabelled Utterances purely so the text-only checks
        # (manglings, casing) can run over it the same way — is_diarized
        # below is what keeps the speaker-related checks from misreading
        # that wrapping as "every turn is unattributed".
        verify_utterances = utterances if utterances is not None else [
            label.Utterance(s.start, s.end, None, s.text) for s in recognition.segments
        ]
        known_terms: set[str] = set()
        if names_file_corrections:
            for correction in names_file_corrections:
                known_terms.add(correction.correct)
                known_terms.update(correction.misheard)

        verification = verify.build(
            verify_utterances,
            is_diarized=plan.mode == "diarize",
            unresolved=naming_result.unresolved if naming_result else None,
            identify_matches=identify_matches,
            known_terms=known_terms,
        )
        if not verification.is_empty():
            print(verify.summarize(verification), file=sys.stderr)
        verification_block = verify.render(verification, names_file=args.names_file)

    rendered = transcript.render(
        probe,
        recognition,
        single_speaker=plan.mode == "dictation",
        utterances=utterances,
        speakers_note=speakers_note,
        warnings=report.warnings,
        ocr=ocr_result,
        spelling_note=spelling_note,
        verification_block=verification_block or None,
    )
    out_dir = args.out or args.input.parent
    destination = out_dir / f"{args.input.stem}.transcript.md"
    transcript.write(destination, rendered)
    print(destination)
    return 0


if __name__ == "__main__":
    sys.exit(main())
