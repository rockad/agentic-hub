"""Speech recognition, behind an interface.

Three implementations plus a stub:

    mlx-whisper       Apple Metal, the fast path on Apple Silicon
    faster-whisper    CTranslate2, CUDA where there is an NVIDIA card, else CPU
    ollama            a stub — Ollama cannot transcribe as of 0.33.3 (see below)

Ollama runs the on-screen text stage but cannot do speech recognition: its
`POST /v1/audio/transcriptions` endpoint parses uploads but no audio-capable
model is published, so a text model answers "model does not support multimodal
requests". The stub exists so that the day an audio model appears, the switch
is a config value rather than a rewrite.

Every engine is handed a decoded float32 array, never a path — `mlx_whisper`
loads a path by shelling out to a bare `ffmpeg`, which defeats taking `ffmpeg`
from a wheel and fails only after the weights are in memory.
"""

from __future__ import annotations

import os
import platform
import sys
from dataclasses import dataclass
from pathlib import Path

from .audio import read_wav_f32

DEFAULT_MODELS = {
    "mlx-whisper": "mlx-community/whisper-large-v3-turbo",
    "faster-whisper": "large-v3-turbo",
}

# ⚠️ **Never set this to True.** Whisper's default is to feed each 30-second
# window the text it produced for the previous one, which on a real recording
# of any length can drop it into a repetition loop it never leaves — one phrase
# emitted for minutes on end. The damage is not confined to the text: segment
# timestamps stall and run backwards while it loops, so speaker turns can no
# longer be placed and every label lands on one speaker.
#
# Measured on a 46-minute two-person call, conditioning on versus off: the top
# three-word phrase went from 1848 occurrences to 10, backwards timestamps from
# many to none, and recognition from 275 s to 71 s — worse output, four times
# slower, and it looked plausible. Short or highly regular audio never triggers
# it, which is why it must be off by default rather than guarded by a test.
CONDITION_ON_PREVIOUS_TEXT = False


class EngineUnavailable(RuntimeError):
    pass


@dataclass
class Segment:
    start: float
    end: float
    text: str


@dataclass
class Recognition:
    segments: list[Segment]
    language: str | None
    engine: str
    model: str
    device: str = "unknown"


def cuda_devices() -> int:
    """How many CUDA devices CTranslate2 can see, 0 if none or if it cannot look.

    Asked of CTranslate2 rather than of `torch` or `nvidia-smi`, because
    CTranslate2 is the runtime that will actually do the work: a machine with a
    driver and a card but a CPU-only wheel must answer 0 here, or the run picks
    `cuda` and dies after the model has loaded.
    """
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


def resolve_device(engine: str) -> str:
    """The accelerator this run will use, decided before the model loads.

    `mlx-whisper` is Metal by construction — MLX's default device is the GPU on
    every Apple Silicon machine and there is no CPU variant to choose. For
    `faster-whisper` the choice is real, so it is made explicitly rather than
    left to `device="auto"`: a wrong guess there surfaces as a crash after the
    weights are in memory.
    """
    requested = os.environ.get("LOCAL_TRANSCRIBE_ASR_DEVICE", "auto")

    if engine == "mlx-whisper":
        return "metal"
    if requested != "auto":
        return requested
    return "cuda" if cuda_devices() else "cpu"


def resolve_compute(device: str) -> str:
    """Quantisation for `faster-whisper`, matched to the device.

    `float16` on a GPU and `int8` on a CPU are each several times faster than
    the other choice on that hardware. CTranslate2's own `default` means "use
    whatever the converted model was saved as", which is not necessarily either.
    """
    if configured := os.environ.get("LOCAL_TRANSCRIBE_ASR_COMPUTE"):
        return configured
    return "float16" if device == "cuda" else "int8"


def accelerator_note(engine: str, device: str) -> str:
    """One line for stderr and the transcript header: what is doing the work."""
    if engine == "mlx-whisper":
        try:
            import mlx.core as mx

            name = mx.default_device()
            return f"Apple GPU via MLX ({name})"
        except Exception:
            return "Apple GPU via MLX"
    if device == "cuda":
        count = cuda_devices()
        return f"NVIDIA GPU via CTranslate2 ({count} device(s), float16)"
    return f"CPU ({resolve_compute(device)})"


def default_engine() -> str:
    if sys.platform == "darwin" and platform.machine() == "arm64":
        return "mlx-whisper"
    return "faster-whisper"


def resolve_engine(requested: str | None = None) -> str:
    return (
        requested
        or os.environ.get("LOCAL_TRANSCRIBE_ASR_ENGINE")
        or default_engine()
    )


def resolve_model(engine: str, requested: str | None = None) -> str:
    return (
        requested
        or os.environ.get("LOCAL_TRANSCRIBE_ASR_MODEL")
        or DEFAULT_MODELS.get(engine, "large-v3-turbo")
    )


def transcribe(
    wav: Path,
    *,
    engine: str | None = None,
    model: str | None = None,
    language: str | None = None,
    initial_prompt: str | None = None,
) -> Recognition:
    """Recognise speech, optionally with a vocabulary primed first.

    `initial_prompt` is a comma-separated list of terms the recogniser should
    reach for. It matters most on **code-switched speech**, and measurably:
    a Russian sentence carrying Latin technical terms came back as
    `кластер Кьюбор Ниц … Орго Акты Джитлэп` — fluent-sounding Cyrillic
    nonsense — under both auto-detected and forced-`ru` decoding, and as
    `кластер Kubernetes, а также ArgoCD, GitLab` when the same terms were
    primed. Ordinary English *phrases* inside Russian already survive without
    it, because they are vocabulary the model expects; rare technical terms
    are what it invents a plausible local spelling for.
    """
    engine = resolve_engine(engine)
    model = resolve_model(engine, model)

    if engine == "mlx-whisper":
        return _mlx(wav, model, language, initial_prompt)
    if engine == "faster-whisper":
        return _faster(wav, model, language, initial_prompt)
    if engine == "ollama":
        raise EngineUnavailable(
            "Ollama has no audio-capable model, so it cannot transcribe.\n"
            "Its /v1/audio/transcriptions endpoint exists but every published model "
            "answers 'model does not support multimodal requests'.\n"
            "Use LOCAL_TRANSCRIBE_ASR_ENGINE=mlx-whisper (Apple Silicon) or "
            "faster-whisper (everything else). Ollama still runs the on-screen "
            "text stage."
        )
    raise EngineUnavailable(
        f"Unknown ASR engine {engine!r}. Known: mlx-whisper, faster-whisper, ollama."
    )


def _mlx(
    wav: Path, model: str, language: str | None, initial_prompt: str | None = None
) -> Recognition:
    try:
        import mlx_whisper
    except ImportError as exc:
        raise EngineUnavailable(
            "mlx-whisper is not installed. It is the default engine on Apple "
            "Silicon; on other platforms set LOCAL_TRANSCRIBE_ASR_ENGINE=faster-whisper."
        ) from exc

    result = mlx_whisper.transcribe(
        read_wav_f32(wav),
        path_or_hf_repo=model,
        language=language,
        verbose=None,
        condition_on_previous_text=CONDITION_ON_PREVIOUS_TEXT,
        initial_prompt=initial_prompt,
    )
    segments = [
        Segment(float(s["start"]), float(s["end"]), s["text"].strip())
        for s in result.get("segments", [])
        if s.get("text", "").strip()
    ]
    return Recognition(
        segments,
        result.get("language") or language,
        "mlx-whisper",
        model,
        device=accelerator_note("mlx-whisper", "metal"),
    )


def _faster(
    wav: Path, model: str, language: str | None, initial_prompt: str | None = None
) -> Recognition:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise EngineUnavailable(
            "faster-whisper is not installed. On Apple Silicon the default engine "
            "is mlx-whisper; elsewhere install faster-whisper."
        ) from exc

    device = resolve_device("faster-whisper")
    compute = resolve_compute(device)

    try:
        whisper = WhisperModel(model, device=device, compute_type=compute)
    except (RuntimeError, ValueError) as exc:
        if device != "cuda":
            raise
        # A card the driver shows but the runtime cannot use — a CPU-only
        # CTranslate2 build, a driver/CUDA mismatch, or a GPU already full.
        # Falling back is right, but silently would hide a machine that should
        # be fast and is not, so it says so.
        print(
            f"note: CUDA was detected but could not be used ({exc}); "
            "falling back to the CPU path, which is several times slower",
            file=sys.stderr,
        )
        device = "cpu"
        compute = resolve_compute(device)
        whisper = WhisperModel(model, device=device, compute_type=compute)

    raw, info = whisper.transcribe(
        read_wav_f32(wav),
        language=language,
        vad_filter=True,
        condition_on_previous_text=CONDITION_ON_PREVIOUS_TEXT,
        initial_prompt=initial_prompt,
    )
    segments = [
        Segment(float(s.start), float(s.end), s.text.strip())
        for s in raw
        if s.text.strip()
    ]
    return Recognition(
        segments,
        getattr(info, "language", None) or language,
        "faster-whisper",
        model,
        device=accelerator_note("faster-whisper", device),
    )
