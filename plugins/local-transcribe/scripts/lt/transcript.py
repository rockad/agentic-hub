"""Writing the transcript out as an ordinary Markdown file.

Ordinary is the point: it lands next to its input by default and the reader can
file it wherever their notes live. The header reports the source's own sample
rate, so a poor transcript from an 8 kHz phone recording is explainable rather
than mysterious.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .asr import Recognition
from .label import Utterance
from .media import Probe
from .ocr import OcrResult


def hhmmss(seconds: float | None) -> str:
    if seconds is None:
        return "unknown"
    total = int(round(seconds))
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


@dataclass
class Render:
    body: str
    plain_text: str


def _quality_note(probe: Probe) -> str | None:
    rate = probe.sample_rate or 0
    if rate and rate < 16000:
        return (
            f"The source is {rate} Hz, below the 16 kHz the recogniser works at. "
            "It transcribes, with real accuracy loss on unclear speech."
        )
    return None


def _ocr_header(probe: Probe, ocr: OcrResult | None) -> str:
    """One line saying whether the screen was read, and if not, why not.

    A reader who cannot tell "there was nothing on the screen" from "nobody
    looked at the screen" cannot trust the absence of a slide, so the header
    states which of the two this file is.
    """
    if not probe.has_video:
        return "no video stream"
    if ocr is None:
        return "off"
    if ocr.skipped_because:
        return f"skipped — {ocr.skipped_because}"
    where = f" on {ocr.device}" if ocr.device else ""
    of_candidates = (
        f" of {ocr.frames_considered}"
        if ocr.frames_considered > ocr.frames_read else ""
    )
    truncated = " — SAMPLING CAPPED, the end of the recording was not looked at" \
        if ocr.truncated else ""
    return (
        f"{ocr.model}{where}, {len(ocr.slides)} screen(s) "
        f"from {ocr.frames_read}{of_candidates} frame(s){truncated}"
    )


def render(
    probe: Probe,
    recognition: Recognition,
    *,
    single_speaker: bool,
    utterances: list[Utterance] | None = None,
    speakers_note: str | None = None,
    warnings: list[str] | None = None,
    ocr: OcrResult | None = None,
    spelling_note: str = "off",
    verification_block: str | None = None,
) -> Render:
    """Render the transcript.

    `utterances` carries speaker labels when a labelling stage ran; without it
    the recognised segments are written unlabelled, which is the dictation
    path. `speakers_note` is the one-line account of how the labels were
    arrived at — the reader needs to know whether `Me` was determined by which
    track the audio came from or guessed by a clustering model.

    `spelling_note` reports the opt-in known-names pass (`lt/spelling.py`):
    "off" when `--names-file` was never given, or a substitution count when it
    was — the same "say what ran, not a guess about what it fixed" rule the
    on-screen-text line already follows. `verification_block` is the rendered
    `## Needs a quick look` section from `lt/verify.py` — already Markdown, or
    `None`/empty when the run had nothing to ask about.
    """
    lines: list[str] = []
    rate = probe.sample_rate

    if speakers_note:
        speakers = speakers_note
    elif single_speaker:
        speakers = "single (dictation)"
    else:
        speakers = "not separated"

    lines += [
        "---",
        "type: transcript",
        f"source: {probe.path.name}",
        f"duration: {hhmmss(probe.duration)}",
        f"audio: {rate or 'unknown'} Hz, "
        f"{probe.audio[0].channels if probe.audio else 0} channel(s), "
        f"{probe.audio[0].codec if probe.audio else 'none'}",
        f"engine: {recognition.engine} / {recognition.model}",
        f"device: {recognition.device}",
        f"language: {recognition.language or 'unknown'}",
        f"speakers: {speakers}",
        f"on-screen text: {_ocr_header(probe, ocr)}",
        f"names corrected: {spelling_note}",
        "---",
        "",
        f"# {probe.path.stem}",
        "",
    ]

    # Before anything else, because a reader who trusts the next paragraph has
    # already been misled. A degenerate run says so at the top of its own file.
    for warning in warnings or []:
        lines += ["> [!warning] This transcript may not be trustworthy"]
        lines += [f"> {line}" for line in warning.split("\n")]
        lines += [""]

    if note := _quality_note(probe):
        lines += [f"> [!note] Source audio quality", f"> {note}", ""]

    if verification_block:
        lines += [verification_block.rstrip("\n"), ""]

    if ocr is not None and ocr.slides:
        lines += [
            "## On-screen text",
            "",
            "> [!note] Read from the video by a model",
            f"> {ocr.model} read {ocr.frames_read} frame(s) of the video stream. "
            "Unlike the speaker labels on a two-track recording, this is a "
            "model's reading and can be wrong — check anything you intend to "
            "quote against the recording itself.",
            "",
        ]
        for slide in ocr.slides:
            span = hhmmss(slide.start)
            if slide.end - slide.start > 1:
                span = f"{span}–{hhmmss(slide.end)}"
            lines += [f"**[{span}]**", "", "```text", slide.text.strip(), "```", ""]

    lines += ["## Transcript", ""]
    if not recognition.segments:
        lines += ["*No speech was recognised in this file.*", ""]

    plain: list[str] = []
    if utterances is not None:
        for utterance in utterances:
            # Two different facts, and a reader has to be able to tell them
            # apart: `Unattributed` is one stretch of speech no cluster could
            # be matched to — too short or too quiet — while `Unknown`, set by
            # `lt/naming.py`, is a whole speaker whose name could not be
            # determined. "Nobody knows who said this line" is not the same
            # claim as "one person said all of these and we do not know who".
            who = utterance.speaker or "Unattributed"
            lines.append(f"**[{hhmmss(utterance.start)}] {who}:** {utterance.text}")
            lines.append("")
            plain.append(f"{who}: {utterance.text}")
    else:
        for segment in recognition.segments:
            lines.append(f"**[{hhmmss(segment.start)}]** {segment.text}")
            lines.append("")
            plain.append(segment.text)

    return Render(body="\n".join(lines).rstrip() + "\n", plain_text=" ".join(plain))


def write(destination: Path, render_result: Render) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(render_result.body, encoding="utf-8")
    return destination
