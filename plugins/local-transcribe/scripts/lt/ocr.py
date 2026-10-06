"""Reading the text that was on the screen, on a local vision model.

A screen recording carries two channels of meaning and only one of them is
speech. The number on the slide, the error in the terminal, the name of the
dashboard someone is pointing at — none of it is ever said aloud, and a
transcript that drops it is a transcript of half the meeting.

The pipeline is deliberately dull:

    ffmpeg scene detection     pick the frames where the screen actually changed
    a local vision model       read the text off each one
    text-level de-duplication  one slide shown for four minutes is one entry

Frames are chosen by change rather than by clock, because a slide deck is
mostly still and a fixed interval either misses a slide or reads the same one
thirty times. `--ocr-interval` switches to the clock for the recordings where
that is wrong — a scrolling document, say, which never scene-changes.

Nothing leaves the machine: the frames go to the Ollama on loopback and the
JPEGs live in the run's temporary directory, which is deleted with it.
"""

from __future__ import annotations

import base64
import os
import re
from dataclasses import dataclass
from pathlib import Path

from . import ollama
from .ffmpeg import ffmpeg_path, run

# Qwen2.5-VL is Apache-2.0 and leads the small open models on OCR benchmarks;
# the Granite fallback is Apache-2.0 too and IBM tuned it for documents, so it
# reads a slide well at a third of the size. Neither is behind a licence anyone
# has to accept or an account anyone has to hold — which rules out
# llama3.2-vision (Meta's licence withholds the multimodal grant in the EU) and
# minicpm-v (commercial use behind a registration form), whatever their scores.
DEFAULT_MODEL = "qwen2.5vl:7b"
FALLBACK_MODEL = "granite3.2-vision:2b"

# An image spends the same context budget as text, and Ollama's default window
# is small enough to truncate one silently — the model then answers from the
# part of the picture that fitted, with no error anywhere.
DEFAULT_NUM_CTX = 8192

# Holding the weights between frames; without it a forty-frame run reloads six
# gigabytes forty times.
KEEP_ALIVE = "10m"

# A scene score is roughly how much of the frame changed, and slides score far
# lower than intuition suggests. Measured here: swapping the whole title line of
# a slide on the same white background scores **0.0396**, because the text is a
# small fraction of the picture — while a window switch in a real screen
# recording scores 0.10–0.17 and scrolling or typing scores 0.005–0.027. So the
# threshold sits at 0.03: above the noise of a moving cursor, below a template
# deck advancing to its next slide. A higher default was tried first and missed
# the second slide of a two-slide deck entirely, silently.
DEFAULT_SCENE = 0.03
DEFAULT_MIN_GAP = 4.0      # seconds; also stops a crossfade becoming ten frames

# Scene detection cannot see what does not change, and a deck left on one slide
# for twenty minutes changes nothing. Without a backstop such a recording is
# read once, at second zero, and the transcript then says the screen held one
# thing for the whole meeting — which is a claim about the sampling, not about
# the meeting. So a frame is taken at least this often regardless.
DEFAULT_BACKSTOP = 120.0
DEFAULT_MAX_FRAMES = 40
DEFAULT_HEIGHT = 1080
HARD_FRAME_CAP = 2000      # safety valve for a recording that changes constantly

PROMPT = """Read the text in this screenshot from a screen recording.

Write out every piece of legible text exactly as it appears — headings, body
text, labels, table cells, code, terminal output, numbers. Keep the reading
order and keep line breaks where they are.

If the image contains no legible text at all, reply with exactly: NO_TEXT

Output only the text itself. Do not describe the image, do not explain, do not
add a preamble, and never write text you cannot actually read in the image."""

NO_TEXT = re.compile(
    r"^(no[_ ]text|there (is|are) no (legible |visible |readable )?text\b|"
    r"the image (contains|has) no (legible |visible |readable )?text\b)",
    re.IGNORECASE,
)

# Two frames of the same slide differ by a cursor. Above this share of shared
# words they are one slide, and the earlier timestamp is the one that matters.
SAME_SLIDE = 0.85


class OcrUnavailable(RuntimeError):
    """OCR was asked for and cannot run — a missing model, usually."""


@dataclass
class Frame:
    time: float
    path: Path


@dataclass
class Slide:
    """Text read off the screen, and when it first appeared."""
    start: float
    end: float
    text: str


@dataclass
class OcrResult:
    slides: list[Slide]
    model: str | None = None
    frames_considered: int = 0
    frames_read: int = 0
    device: str | None = None
    skipped_because: str | None = None
    # True when the recording changed so constantly that extraction hit its own
    # safety cap, which means the end of it was never looked at. Silence here
    # would make a sampling artefact read as a fact about the screen.
    truncated: bool = False

    @property
    def ran(self) -> bool:
        return self.model is not None and self.skipped_because is None


def default_model() -> str:
    return os.environ.get("LOCAL_TRANSCRIBE_OCR_MODEL", DEFAULT_MODEL)


def preflight(model: str) -> str | None:
    """Why OCR cannot run, or None if it can. Called before the long stages."""
    installed = ollama.installed_models()
    if installed is None:
        return (
            f"Ollama is not reachable at {ollama.url()} "
            "(start it, or set LOCAL_TRANSCRIBE_OLLAMA_URL)"
        )
    if not ollama.has_model(model, installed=installed):
        size = " (about 6 GB)" if model == DEFAULT_MODEL else ""
        smaller = (
            f"; `{FALLBACK_MODEL}` is a third of the size"
            if model != FALLBACK_MODEL else ""
        )
        return (
            f"the vision model {model} is not pulled — run "
            f"`ollama pull {model}`{size}{smaller}, or name another "
            "with --ocr-model"
        )
    return None


# --- frame selection --------------------------------------------------------


def _select_expression(
    scene: float, min_gap: float, backstop: float = DEFAULT_BACKSTOP
) -> str:
    """Frame 0, then any big enough change far enough from the last one — and,
    whatever happens, a frame once every `backstop` seconds.

    The gap is enforced inside the filter rather than afterwards, so a busy
    recording never writes ten thousand JPEGs to be thrown away, and the
    backstop is enforced the same way so a still one is not read once and
    declared unchanging.
    """
    terms = [
        "eq(n\\,0)",
        f"(gt(scene\\,{scene})*gt(t-prev_selected_t\\,{min_gap}))",
    ]
    if backstop and backstop > 0:
        terms.append(f"gt(t-prev_selected_t\\,{backstop})")
    return f"select='{'+'.join(terms)}'"


def _interval_expression(interval: float) -> str:
    return f"fps=1/{interval}"


def _parse_times(stderr: str) -> list[float]:
    return [float(m) for m in re.findall(r"pts_time:([0-9.]+)", stderr)]


def extract_frames(
    video: Path,
    work: Path,
    *,
    scene: float = DEFAULT_SCENE,
    min_gap: float = DEFAULT_MIN_GAP,
    interval: float | None = None,
    backstop: float = DEFAULT_BACKSTOP,
    height: int = DEFAULT_HEIGHT,
    max_frames: int = DEFAULT_MAX_FRAMES,
) -> list[Frame]:
    """Write candidate frames as JPEGs and return them with their timestamps.

    JPEG rather than PNG because a thousand lossless 1080p frames is a gigabyte
    of temporary files for no gain: the vision model reads a quality-2 JPEG the
    same way, and the payload to Ollama is a fifth of the size.
    """
    work.mkdir(parents=True, exist_ok=True)
    picker = (
        _interval_expression(interval)
        if interval
        else _select_expression(scene, min_gap, backstop)
    )
    # `min(height,ih)` so a 720p source is never upscaled into blur.
    chain = f"{picker},scale=-2:'min({height}\\,ih)':flags=lanczos,showinfo"
    pattern = str(work / "frame-%05d.jpg")

    def attempt(sync_flag: list[str]) -> tuple[int, str]:
        args = [
            ffmpeg_path(), "-nostdin", "-hide_banner", "-loglevel", "info", "-y",
            "-i", str(video), "-map", "0:v:0", "-an", "-vf", chain,
            *sync_flag, "-frames:v", str(HARD_FRAME_CAP), "-q:v", "2", pattern,
        ]
        result = run(args)
        return result.returncode, result.stderr or ""

    code, stderr = attempt(["-fps_mode", "vfr"])
    if code != 0 and "fps_mode" in stderr:
        # Anything older than ffmpeg 5 knows this only by its previous name.
        code, stderr = attempt(["-vsync", "vfr"])
    if code != 0:
        raise OcrUnavailable(f"ffmpeg could not read frames from {video.name}:\n{stderr.strip()}")

    files = sorted(work.glob("frame-*.jpg"))
    times = _parse_times(stderr)
    frames = [
        Frame(time=times[i] if i < len(times) else 0.0, path=path)
        for i, path in enumerate(files)
    ]
    return frames if max_frames <= 0 else thin(frames, max_frames)


def thin(frames: list[Frame], max_frames: int) -> list[Frame]:
    """Spread the cut across the recording instead of truncating at the cap.

    Cutting the tail would silently turn "the last forty minutes had no slides"
    into a fact about the transcript rather than about the meeting.
    """
    if max_frames <= 0 or len(frames) <= max_frames:
        return frames
    if max_frames == 1:
        return frames[:1]
    step = (len(frames) - 1) / (max_frames - 1)
    return [frames[round(i * step)] for i in range(max_frames)]


# --- reading ----------------------------------------------------------------


def _encode(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def clean(answer: str) -> str:
    """Drop the model's ways of saying "nothing here" and its stray commentary."""
    text = (answer or "").strip()
    if not text:
        return ""
    # Some models fence the whole answer even when told not to.
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    if NO_TEXT.match(text) and len(text) < 120:
        return ""
    if len(text.strip()) < 3:
        return ""
    return text


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def same_slide(a: str, b: str) -> bool:
    """Is this the frame before, with a cursor moved?"""
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return False
    overlap = len(wa & wb) / max(len(wa), len(wb))
    return overlap >= SAME_SLIDE


def merge(slides: list[Slide]) -> list[Slide]:
    """Collapse runs of the same screen into one entry that spans them."""
    out: list[Slide] = []
    for slide in slides:
        if out and same_slide(out[-1].text, slide.text):
            previous = out[-1]
            previous.end = slide.end
            if len(slide.text) > len(previous.text):
                previous.text = slide.text
            continue
        out.append(slide)
    return out


def read_frames(
    frames: list[Frame],
    *,
    model: str,
    timeout: float = 180.0,
    progress=None,
) -> list[Slide]:
    slides: list[Slide] = []
    for index, frame in enumerate(frames, start=1):
        try:
            answer = ollama.generate(
                model, PROMPT, images=[_encode(frame.path)],
                timeout=timeout, temperature=0.0,
                num_ctx=DEFAULT_NUM_CTX, keep_alive=KEEP_ALIVE,
            )
        except ollama.OllamaError as exc:
            raise OcrUnavailable(str(exc)) from exc
        text = clean(answer)
        if progress:
            progress(index, len(frames), frame.time, len(text))
        if text:
            slides.append(Slide(start=frame.time, end=frame.time, text=text))
    return merge(slides)


def read(
    video: Path,
    work: Path,
    *,
    model: str | None = None,
    scene: float = DEFAULT_SCENE,
    min_gap: float = DEFAULT_MIN_GAP,
    interval: float | None = None,
    backstop: float = DEFAULT_BACKSTOP,
    max_frames: int = DEFAULT_MAX_FRAMES,
    progress=None,
) -> OcrResult:
    """Extract frames, read them, and report what was actually done."""
    name = model or default_model()
    if reason := preflight(name):
        return OcrResult(slides=[], skipped_because=reason)

    # Extracted uncapped, then thinned here, so `frames_considered` is the real
    # number of candidates rather than a copy of how many were read.
    candidates = extract_frames(
        video, work, scene=scene, min_gap=min_gap,
        interval=interval, backstop=backstop, max_frames=0,
    )
    if not candidates:
        return OcrResult(
            slides=[], model=name,
            skipped_because="no frames could be read from the video stream",
        )

    frames = thin(candidates, max_frames)
    slides = read_frames(frames, model=name, progress=progress)
    return OcrResult(
        slides=slides,
        model=name,
        frames_considered=len(candidates),
        frames_read=len(frames),
        device=ollama.residency(name),
        truncated=len(candidates) >= HARD_FRAME_CAP,
    )


__all__ = [
    "DEFAULT_MAX_FRAMES", "DEFAULT_MIN_GAP", "DEFAULT_MODEL", "DEFAULT_NUM_CTX",
    "DEFAULT_SCENE", "FALLBACK_MODEL", "KEEP_ALIVE",
    "Frame", "OcrResult", "OcrUnavailable", "Slide",
    "clean", "default_model", "extract_frames", "merge", "preflight",
    "read", "read_frames", "same_slide", "thin",
]
