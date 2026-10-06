"""Speaker separation, on this machine, with no account and no licence gate.

The engine is `sherpa-onnx`: ONNX Runtime, no `torch`, one code path on macOS,
Linux and Windows. The two ONNX models are served from `k2-fsa`'s GitHub
releases over plain HTTPS with no token, no login and no terms click-through,
and that is the property that makes them shippable.

⛔ `pyannote.audio` must not become a dependency here. Its weights sit behind
gated Hugging Face terms that **each user accepts individually** on their own
account, and whoever skips it gets one merged speaker label rather than an
error — a silent wrong answer.

Three stages, and the middle one is where this differs from the obvious design:

    speech detection   where speech is, from Silero VAD
    embedding          a voice fingerprint per fixed window of speech
    clustering         windows grouped into speakers, then turned into turns

The obvious design asks a segmentation model where the speaker *changes* and
embeds whatever it hands back. That is what this module used to do, and on a
single mixed recording of two people in one room it failed badly: the segments
it produced held both voices, so every segment fingerprint came out looking
like every other one and the clusterer put 98% of the audio on one speaker.
The fingerprints were never the problem. Measured on a 49-minute two-person
interview (2026-09-15), with minutes of each speaker attributed by hand, the
embedding model below tells the two of them apart at a **1% equal-error rate**
on three-second windows — and a plain two-means clustering of a fixed window
grid, with nothing enrolled and no segmentation model involved, agreed with
every one of the 865 hand-attributed windows.

So speaker changes are not asked for. A grid of overlapping windows is laid
over the speech, each window is fingerprinted, the windows are clustered, and
the turn boundaries fall out of where the cluster labels change. A window
straddling a real speaker change is a blend of two voices and lands wherever
its blend lies, which is why the labels are smoothed over a few seconds before
boundaries are read off them: someone holds the floor for longer than one
window, so an isolated disagreement is noise rather than a turn.

Clustering is where the speaker count lands. Given `--speakers N` the windows
are split into exactly N; given nothing they are over-split and then merged
back by cosine similarity, and the count in the result is a finding rather than
an input. Both are offered because both are real: a scheduled call has a known
attendee count, a recording found on a voice recorder does not.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .audio import SAMPLE_RATE, read_wav_f32

RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"

# Silero VAD, MIT licensed, 2 MB, no gate. It replaces the segmentation model
# that used to sit here: all that is wanted from it is where speech is, and
# unlike a segmentation model it makes no claim about who is speaking.
VAD_URL = f"{RELEASES}/asr-models/silero_vad.onnx"
VAD_FILE = "silero-vad.onnx"

EMBEDDING_URL = (
    f"{RELEASES}/speaker-recongition-models/"
    "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
)
EMBEDDING_FILE = "embedding-campplus-zh-en.onnx"

# The window grid. Three seconds is long enough for a stable fingerprint and
# short enough that most windows hold one voice; one second of hop sets how
# precisely a turn boundary can be placed.
WINDOW_SECONDS = 3.0
HOP_SECONDS = 1.0

# A window shorter than this is not fingerprinted at all. Short backchannels
# ("yeah", "right") are left unattributed rather than guessed, which the
# transcript renders as an unknown speaker — honest, and cheap to read past.
MIN_WINDOW_SECONDS = 0.8

# Labels are smoothed over this span before turn boundaries are read off them.
SMOOTH_SECONDS = 4.0

# Cosine threshold used when the speaker count is unknown, applied between
# cluster centroids rather than between single windows: centroids average their
# members' noise away, so the number means the same thing at any recording
# length. Lower merges two people into one, higher splits one person into
# several.
DEFAULT_THRESHOLD = 0.5

# How many clusters the unknown-count path starts from before merging. More
# than this in one recording is a room, not a meeting, and the merge step
# cannot recover from a start that is already too coarse.
MAX_SPEAKERS = 8

# The CPU is the default deliberately: both models are small, the stage runs at
# roughly 0.1x of audio duration, and CoreML benchmarks no faster at two
# threads and slower at six — per-operator dispatch dominates a graph this
# size. `cuda` needs a CUDA-enabled sherpa-onnx build, which the PyPI wheel is
# not; ONNX Runtime falls back to the CPU without failing, so setting it on a
# plain install buys nothing and says nothing.
DEFAULT_PROVIDER = "cpu"


def resolve_provider() -> str:
    """Which ONNX Runtime execution provider the speaker models run on."""
    requested = os.environ.get("LOCAL_TRANSCRIBE_DIARIZE_PROVIDER", "auto").strip()
    if requested and requested != "auto":
        return requested
    return DEFAULT_PROVIDER


def resolve_threads() -> int:
    return int(os.environ.get("LOCAL_TRANSCRIBE_DIARIZE_THREADS", "2"))


class DiarizationUnavailable(RuntimeError):
    """The stage cannot run, with the reason and the way forward in the message."""


@dataclass
class Turn:
    start: float
    end: float
    speaker: int


def model_dir() -> Path:
    """Where the ONNX files are cached, once, per machine."""
    configured = os.environ.get("LOCAL_TRANSCRIBE_MODEL_DIR")
    if configured:
        return Path(configured).expanduser()
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
        return base / "local-transcribe" / "models"
    return Path.home() / ".cache" / "local-transcribe" / "models"


def _download(url: str, destination: Path) -> Path:
    """Fetch one model file, atomically, and say so on stderr while it happens.

    Atomically because a half-written ONNX file is indistinguishable from a
    whole one to the loader: it is downloaded beside the target and renamed, so
    an interrupted run leaves nothing for the next run to trip over.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    print(
        f"downloading {destination.name} (once, then cached in {destination.parent})…",
        file=sys.stderr,
    )
    try:
        with tempfile.TemporaryDirectory(prefix="lt-model-") as tmp:
            payload = Path(tmp) / "payload"
            with urllib.request.urlopen(url, timeout=120) as response:
                with payload.open("wb") as handle:
                    shutil.copyfileobj(response, handle)
            shutil.move(str(payload), str(destination))
    except urllib.error.URLError as exc:
        raise DiarizationUnavailable(
            f"could not download the speaker model from {url}: {exc}\n"
            "It is a plain public GitHub release — no account or token is needed — "
            "so this is a network or proxy problem.\n"
            "On a machine with no internet access, fetch the file elsewhere and "
            f"place it at {destination}."
        ) from exc
    return destination


def ensure_models() -> tuple[Path, Path]:
    """Return (vad, embedding) paths, downloading them on first use."""
    vad = Path(
        os.environ.get("LOCAL_TRANSCRIBE_VAD_MODEL") or model_dir() / VAD_FILE
    ).expanduser()
    embedding = Path(
        os.environ.get("LOCAL_TRANSCRIBE_EMBEDDING_MODEL")
        or model_dir() / EMBEDDING_FILE
    ).expanduser()

    for path, url, variable in (
        (vad, VAD_URL, "LOCAL_TRANSCRIBE_VAD_MODEL"),
        (embedding, EMBEDDING_URL, "LOCAL_TRANSCRIBE_EMBEDDING_MODEL"),
    ):
        if not path.exists():
            if os.environ.get(variable):
                raise DiarizationUnavailable(
                    f"{variable} points at {path}, which does not exist."
                )
            _download(url, path)

    return vad, embedding


def speech_regions(samples: np.ndarray, vad_model: Path) -> list[tuple[float, float]]:
    """Where speech is, in seconds, from Silero VAD.

    Long stretches are deliberately not broken up here — `max_speech_duration`
    is generous because a region is only a container for the window grid, and a
    region boundary is not a claim that the speaker changed.
    """
    import sherpa_onnx

    config = sherpa_onnx.VadModelConfig(
        silero_vad=sherpa_onnx.SileroVadModelConfig(
            model=str(vad_model),
            threshold=0.5,
            min_silence_duration=0.35,
            min_speech_duration=0.25,
            max_speech_duration=60.0,
        ),
        sample_rate=SAMPLE_RATE,
        num_threads=resolve_threads(),
        provider=resolve_provider(),
    )
    detector = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=120)

    regions: list[tuple[float, float]] = []

    def drain() -> None:
        while not detector.empty():
            segment = detector.front
            start = segment.start / SAMPLE_RATE
            regions.append((start, start + len(segment.samples) / SAMPLE_RATE))
            detector.pop()

    # Half a second at a time, and drained after every push. The size is not
    # cosmetic: the detector holds pushed audio until a segment closes, so
    # feeding it in long stretches both overflows its buffer — which it reports
    # on stderr as it grows — and returns far coarser regions. Measured on five
    # minutes of one interview, 30-second pushes returned a single 270-second
    # region where half-second pushes returned 28 that follow the pauses.
    step = SAMPLE_RATE // 2
    for offset in range(0, len(samples), step):
        detector.accept_waveform(samples[offset:offset + step])
        drain()
    detector.flush()
    drain()
    return regions


def _window_grid(
    regions: list[tuple[float, float]]
) -> tuple[list[tuple[float, float]], list[int]]:
    """Overlapping windows covering the speech, and which region each came from.

    The region index travels with the window because everything downstream has
    to know where the silences are: neither the smoothing vote nor a turn
    boundary may reach across one.
    """
    grid: list[tuple[float, float]] = []
    belongs: list[int] = []

    def add(start: float, end: float, region: int) -> None:
        grid.append((start, end))
        belongs.append(region)

    for index, (start, end) in enumerate(regions):
        if end - start < MIN_WINDOW_SECONDS:
            continue
        if end - start <= WINDOW_SECONDS:
            add(start, end, index)
            continue
        position = start
        while position + WINDOW_SECONDS <= end:
            add(position, position + WINDOW_SECONDS, index)
            position += HOP_SECONDS
        # The tail of a region that the grid did not reach is worth a window of
        # its own whenever it is long enough to fingerprint, so the last words
        # before a pause are attributed rather than dropped.
        if end - position >= MIN_WINDOW_SECONDS:
            add(max(start, end - WINDOW_SECONDS), end, index)
    return grid, belongs


def _embed_windows(
    samples: np.ndarray, grid: list[tuple[float, float]], embedding_model: Path
) -> np.ndarray:
    import sherpa_onnx

    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(embedding_model),
            num_threads=resolve_threads(),
            provider=resolve_provider(),
        )
    )
    vectors: list[np.ndarray] = []
    for start, end in grid:
        stream = extractor.create_stream()
        stream.accept_waveform(
            sample_rate=SAMPLE_RATE,
            waveform=samples[int(start * SAMPLE_RATE):int(end * SAMPLE_RATE)],
        )
        stream.input_finished()
        vector = np.array(extractor.compute(stream), dtype=np.float32)
        norm = float(np.linalg.norm(vector))
        vectors.append(vector / norm if norm else vector)
    return np.stack(vectors)


def _spherical_kmeans(
    vectors: np.ndarray, clusters: int, *, restarts: int = 10
) -> np.ndarray:
    """Cluster unit vectors by cosine similarity.

    Plain k-means on normalised vectors, restarted from several random seeds
    and keeping the tightest result, because a single seed on speech embeddings
    lands in a poor split often enough to matter and the whole thing costs
    milliseconds next to the embedding pass.
    """
    if clusters <= 1 or len(vectors) <= clusters:
        return np.zeros(len(vectors), dtype=int)

    rng = np.random.default_rng(0)
    best_labels, best_score = None, -np.inf
    for _ in range(restarts):
        centres = vectors[rng.choice(len(vectors), clusters, replace=False)].copy()
        labels = np.zeros(len(vectors), dtype=int)
        for _ in range(50):
            labels = np.argmax(vectors @ centres.T, axis=1)
            moved = False
            for index in range(clusters):
                members = vectors[labels == index]
                if not len(members):
                    members = vectors[rng.integers(len(vectors))][None, :]
                centre = members.mean(axis=0)
                norm = float(np.linalg.norm(centre))
                centre = centre / norm if norm else centre
                if not np.allclose(centre, centres[index]):
                    centres[index], moved = centre, True
            if not moved:
                break
        score = float((vectors * centres[labels]).sum())
        if score > best_score:
            best_labels, best_score = labels.copy(), score
    assert best_labels is not None
    return best_labels


def _merge_by_threshold(
    vectors: np.ndarray, labels: np.ndarray, threshold: float
) -> np.ndarray:
    """Merge clusters whose centroids are more alike than `threshold`.

    Average linkage, one merge at a time, recomputing the centroid each round so
    a chain of similar clusters collapses rather than merging only in pairs.
    """
    labels = labels.copy()
    while True:
        present = sorted(set(labels.tolist()))
        if len(present) < 2:
            return labels
        centres = {}
        for index in present:
            centre = vectors[labels == index].mean(axis=0)
            norm = float(np.linalg.norm(centre))
            centres[index] = centre / norm if norm else centre

        closest, best = None, -np.inf
        for position, first in enumerate(present):
            for second in present[position + 1:]:
                score = float(centres[first] @ centres[second])
                if score > best:
                    closest, best = (first, second), score
        if closest is None or best < threshold:
            return labels
        labels[labels == closest[1]] = closest[0]


def _cluster(
    vectors: np.ndarray, speakers: int | None, threshold: float
) -> np.ndarray:
    if speakers and speakers > 1:
        return _spherical_kmeans(vectors, speakers)
    start = min(MAX_SPEAKERS, max(2, len(vectors) // 8))
    return _merge_by_threshold(vectors, _spherical_kmeans(vectors, start), threshold)


def _smooth(
    grid: list[tuple[float, float]], labels: np.ndarray, regions_of: list[int]
) -> np.ndarray:
    """Majority vote over neighbouring windows of the same speech region.

    Someone holds the floor for longer than one window, so a lone disagreement
    between two agreeing neighbours is noise. The vote never reaches across a
    silence, because the windows either side of a pause are not evidence about
    each other.
    """
    centres = np.array([(start + end) / 2 for start, end in grid])
    smoothed = labels.copy()
    for index in range(len(labels)):
        near = (
            (np.abs(centres - centres[index]) <= SMOOTH_SECONDS / 2)
            & (np.array(regions_of) == regions_of[index])
        )
        values, counts = np.unique(labels[near], return_counts=True)
        smoothed[index] = values[counts.argmax()]
    return smoothed


def _turns_from_labels(
    grid: list[tuple[float, float]],
    labels: np.ndarray,
    regions: list[tuple[float, float]],
    regions_of: list[int],
) -> list[Turn]:
    """Read turn boundaries off the label sequence.

    A boundary between two windows with different labels is placed midway
    between their centres, which is the most that overlapping windows can say
    about where a voice changed. Each run is clamped to its speech region, so no
    turn claims the silence around it.
    """
    turns: list[Turn] = []
    centres = [(start + end) / 2 for start, end in grid]
    run_start = 0
    for index in range(1, len(labels) + 1):
        ends_run = (
            index == len(labels)
            or labels[index] != labels[run_start]
            or regions_of[index] != regions_of[run_start]
        )
        if not ends_run:
            continue

        region = regions[regions_of[run_start]]
        first, last = run_start, index - 1
        start = (
            region[0]
            if first == 0 or regions_of[first - 1] != regions_of[first]
            else (centres[first - 1] + centres[first]) / 2
        )
        end = (
            region[1]
            if last == len(labels) - 1 or regions_of[last + 1] != regions_of[last]
            else (centres[last] + centres[last + 1]) / 2
        )
        if end > start:
            turns.append(Turn(float(start), float(end), int(labels[run_start])))
        run_start = index

    # Speaker ids in order of first appearance, so `Speaker 1` is whoever spoke
    # first rather than whichever cluster the clusterer happened to build first.
    order: dict[int, int] = {}
    for turn in turns:
        order.setdefault(turn.speaker, len(order))
    for turn in turns:
        turn.speaker = order[turn.speaker]

    merged: list[Turn] = []
    for turn in turns:
        if merged and merged[-1].speaker == turn.speaker and turn.start - merged[-1].end < 0.5:
            merged[-1].end = turn.end
        else:
            merged.append(turn)
    return merged


def diarize(
    wav: Path,
    *,
    speakers: int | None = None,
    threshold: float | None = None,
    embedding_model: Path | None = None,
) -> list[Turn]:
    """Split a 16 kHz mono WAV into speaker turns.

    `speakers` is the count to produce when it is known. When it is None the
    clusterer decides from `threshold`, and the count in the result is a
    finding rather than an input.
    """
    try:
        import sherpa_onnx  # noqa: F401
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise DiarizationUnavailable(
            "sherpa-onnx is not installed, so speaker separation cannot run.\n"
            "It is declared in the script header, so this means the environment "
            "was built by hand — re-run through `uv run --script`."
        ) from exc

    vad_model, embedding = ensure_models()
    if embedding_model is not None:
        embedding = embedding_model

    samples = read_wav_f32(wav)
    regions = speech_regions(samples, vad_model)
    if not regions:
        raise DiarizationUnavailable(
            f"no speech found in {wav.name}, so there are no speakers to separate.\n"
            "If the file does hold speech, it is quieter than the detector's "
            "threshold — transcribe it with --dictation instead."
        )

    grid, regions_of = _window_grid(regions)
    if not grid:
        raise DiarizationUnavailable(
            f"the speech in {wav.name} is all shorter than "
            f"{MIN_WINDOW_SECONDS:.1f}s per stretch, which is too fragmented to "
            "fingerprint. Transcribe it with --dictation instead."
        )

    vectors = _embed_windows(samples, grid, embedding)
    labels = _cluster(
        vectors, speakers, DEFAULT_THRESHOLD if threshold is None else threshold
    )
    labels = _smooth(grid, labels, regions_of)
    return _turns_from_labels(grid, labels, regions, regions_of)


def speaker_count(turns: list[Turn]) -> int:
    return len({turn.speaker for turn in turns})


__all__ = [
    "DEFAULT_PROVIDER",
    "DEFAULT_THRESHOLD",
    "EMBEDDING_FILE",
    "EMBEDDING_URL",
    "HOP_SECONDS",
    "MAX_SPEAKERS",
    "MIN_WINDOW_SECONDS",
    "SMOOTH_SECONDS",
    "VAD_FILE",
    "VAD_URL",
    "WINDOW_SECONDS",
    "DiarizationUnavailable",
    "Turn",
    "diarize",
    "ensure_models",
    "model_dir",
    "resolve_provider",
    "resolve_threads",
    "speaker_count",
    "speech_regions",
]
