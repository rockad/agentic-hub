"""Voice prints: enrolling a person once, so a later recording can name them.

A voice print is a single embedding vector — the same fingerprint `diarize.py`
computes per window, averaged over enough of one person's speech that it
represents them rather than one sentence. Identification is the same
comparison the clusterer already makes internally, just against a saved
vector instead of another window: cosine similarity on unit vectors, computed
by the same `sherpa-onnx` extractor.

**A voice print is biometric personal data.** This plugin is public and other
people install it, so the design here answers to that rather than to
convenience:

- The store is a directory **outside any git repository by default** —
  `~/.local/share/local-transcribe/voices/` (`%LOCALAPPDATA%` on Windows) —
  and `LOCAL_TRANSCRIBE_VOICES_DIR` is the only way to move it. There is no
  path under this plugin's own tree, because a plugin directory is exactly
  the kind of place that ends up committed, synced, or bundled into a support
  ticket.
- **Enrolment is always an explicit act naming a person.** Nothing enrols as
  a side effect of transcribing, diarizing, or identifying — a colleague's
  voice is never captured just because they were in a call someone else
  transcribed.
- **The print is the only thing stored.** No audio, no waveform, no clip —
  a few dozen floats and the bookkeeping needed to use them safely.

Two measured facts set the constants below. First, **an embedding is only
comparable to another embedding from the same model** — the vector space a
model produces is that model's own geometry, and a cosine score between
spaces trained separately measures nothing. So every print records the exact
model filename it was computed with, and a comparison across models is
refused rather than silently producing a number. Second, held-out fingerprint
scores on two real recordings (`_inbox/voice-check`, 2026-09-16) put a real
match's window-vs-print similarity at a median of **+0.744 and +0.772**, and
an impostor's at **+0.392 and +0.415** — a gap of roughly 0.33 between the
lowest true match seen and the highest false one. `IDENTIFY_THRESHOLD` sits
near the middle of that gap rather than either edge, so a slightly quieter or
more distant recording than the ones measured still clears it; the same data
made `IDENTIFY_MARGIN` easy to set generously low, since two *different*
enrolled people's prints scored roughly 0.33–0.45 apart against the same
cluster in every case measured — an ambiguous pair this far apart has not
been observed, so a small margin is enough to catch one without ever
rejecting a clean recording. See `evals/voices_test.py` for how these were
checked, and this module's own docstrings below for exactly what is averaged
to build the vector each side compares.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from . import diarize as diarize_mod
from .audio import SAMPLE_RATE, read_wav_f32
from .diarize import Turn
from .label import Utterance

# A print built from less than this much real speech — VAD-detected, not file
# duration — is refused rather than stored. Below it a print is dominated by
# one or two sentences' worth of pitch and prosody rather than the speaker's
# voice in general, which is exactly the kind of quiet-looking failure this
# plugin refuses elsewhere: a bad print does not announce itself, it just
# scores low against everyone including its own owner.
MIN_ENROLL_SECONDS = 20.0

# A cluster is named only when its best match clears both of these against
# every stored print. See the module docstring for the measurement behind
# them: real matches ran +0.744/+0.772, impostors +0.392/+0.415, so 0.55 sits
# in the middle of that gap and 0.08 is generous against a gap that measured
# roughly 0.33–0.45 between two different people's prints.
IDENTIFY_THRESHOLD = 0.55
IDENTIFY_MARGIN = 0.08

# How much of a cluster's longest turns to pool into its comparison
# embedding. More is a steadier estimate; this is already several times
# MIN_ENROLL_SECONDS, and every real turn beyond it is diminishing return
# for the extra embedding calls.
IDENTIFY_SAMPLE_SECONDS = 30.0


class VoiceStoreError(RuntimeError):
    """Enrolment, identification or lookup cannot proceed, reason in the message."""


@dataclass
class VoicePrint:
    """One stored fingerprint. Every field is what a reader needs to trust it."""

    name: str
    embedding: list[float]
    embedding_model: str
    seconds: float
    source: str
    enrolled: str  # ISO date, e.g. 2026-09-16
    version: int = field(default=1)

    def vector(self) -> np.ndarray:
        return np.array(self.embedding, dtype=np.float32)


def voices_dir() -> Path:
    """Where prints are stored — local disk, never a path this plugin ships.

    `LOCAL_TRANSCRIBE_VOICES_DIR` is the only override, on the same pattern as
    `diarize.model_dir`, but the default is deliberately not analogous: models
    are public files worth sharing across projects, and a print is personal
    data that must never end up somewhere `git status` can see it. Neither
    default here is inside this repository, a clone of it, or any other
    directory a `git add -A` could reach.
    """
    configured = os.environ.get("LOCAL_TRANSCRIBE_VOICES_DIR")
    if configured:
        return Path(configured).expanduser()
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
        return base / "local-transcribe" / "voices"
    return Path.home() / ".local" / "share" / "local-transcribe" / "voices"


def _slug(name: str) -> str:
    """A filesystem-safe stem for `name`, collapsing whitespace and case.

    Two names that collapse to the same slug ("Alex Kim" and "alex-kim")
    share one file — acceptable for a store one person keeps by hand and
    checks with `--list-voices`, and far simpler than inventing a second
    identity axis for what is, in practice, a handful of enrolled people.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    if not slug:
        raise VoiceStoreError(f"{name!r} has no usable characters for a filename")
    return slug


def path_for(name: str) -> Path:
    return voices_dir() / f"{_slug(name)}.json"


def list_voices() -> list[VoicePrint]:
    """Every stored print, sorted by name. An absent store is empty, not an error."""
    directory = voices_dir()
    if not directory.is_dir():
        return []
    prints: list[VoicePrint] = []
    for path in sorted(directory.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            prints.append(VoicePrint(**data))
        except (json.JSONDecodeError, TypeError, KeyError) as exc:
            print(f"warning: skipping unreadable voice print {path}: {exc}", file=sys.stderr)
    prints.sort(key=lambda p: p.name.lower())
    return prints


def load_voice(name: str) -> VoicePrint | None:
    path = path_for(name)
    if not path.exists():
        return None
    return VoicePrint(**json.loads(path.read_text(encoding="utf-8")))


def save_voice(print_: VoicePrint) -> Path:
    """Write one print to disk, permissioned as the biometric data it is.

    `chmod` is best-effort: it does the real thing on macOS and Linux, and on
    Windows only clears the read-only bit, which is what `Path.chmod` can do
    there. Neither platform's limitation is a reason to skip the attempt on
    the other.
    """
    directory = voices_dir()
    directory.mkdir(parents=True, exist_ok=True)
    try:
        directory.chmod(0o700)
    except OSError:
        pass
    path = path_for(print_.name)
    path.write_text(json.dumps(asdict(print_), indent=2), encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path


def forget_voice(name: str) -> bool:
    """Delete a stored print by name, case-insensitively. True if one was found."""
    target = name.strip().lower()
    for print_ in list_voices():
        if print_.name.lower() == target:
            path_for(print_.name).unlink()
            return True
    return False


def print_from_regions(
    samples: np.ndarray, regions: list[tuple[float, float]], embedding_model: Path
) -> tuple[np.ndarray | None, float]:
    """The centroid embedding of `regions`, and how many seconds they cover.

    This is the one routine both enrolment paths and identification share:
    lay `diarize`'s own window grid over whatever stretch of audio belongs to
    one person, embed every window with the same extractor the clusterer
    uses, and average the unit vectors back onto the unit sphere — exactly
    how `diarize._merge_by_threshold` builds a cluster centroid, because a
    voice print *is* a cluster centroid, just one that outlives the file it
    came from. Averaging beats picking a single window because it cancels the
    prosody of whatever one sentence happened to say, which the measurements
    in this module's docstring already needed to spread the comparison across
    several held-out windows to get a stable answer for the same reason.

    Returns `(None, seconds)` when the regions are too fragmented to produce
    even one window — the caller decides what that means.
    """
    seconds = sum(end - start for start, end in regions)
    grid, _ = diarize_mod._window_grid(regions)
    if not grid:
        return None, seconds
    vectors = diarize_mod._embed_windows(samples, grid, embedding_model)
    centroid = vectors.mean(axis=0)
    norm = float(np.linalg.norm(centroid))
    return (centroid / norm if norm else centroid), seconds


def _require_floor(seconds: float, *, context: str) -> None:
    if seconds < MIN_ENROLL_SECONDS:
        raise VoiceStoreError(
            f"only {seconds:.0f}s of real speech found {context} (measured "
            f"after silence is removed by voice-activity detection, not from "
            f"the file's length) — at least {MIN_ENROLL_SECONDS:.0f}s is "
            "needed for a print worth trusting. A weak print would score low "
            "against everyone, including its own owner, without ever saying "
            "so. Use a longer recording of them."
        )


def enroll_from_file(wav: Path) -> tuple[np.ndarray, float, Path]:
    """The dictated-memo route: every VAD speech region is this one person.

    Only correct when the whole file genuinely holds one speaker — the
    caller is responsible for that, the same way `--dictation` is trusted
    rather than verified elsewhere in this plugin. Returns
    `(vector, seconds, embedding_model)`; the caller attaches the name.
    """
    vad_model, default_embedding = diarize_mod.ensure_models()
    samples = read_wav_f32(wav)
    regions = diarize_mod.speech_regions(samples, vad_model)
    if not regions:
        raise VoiceStoreError(f"no speech found in {wav.name} to enrol from")
    vector, seconds = print_from_regions(samples, regions, default_embedding)
    if vector is None:
        raise VoiceStoreError(
            f"the speech in {wav.name} is all shorter than "
            f"{diarize_mod.MIN_WINDOW_SECONDS:.1f}s per stretch, too "
            "fragmented to fingerprint"
        )
    _require_floor(seconds, context=f"in {wav.name}")
    return vector, seconds, default_embedding


def enroll_from_speaker(
    wav: Path, turns: list[Turn], speaker_number: int
) -> tuple[np.ndarray, float, Path]:
    """The interview route: one diarized cluster's turns, and only those.

    `speaker_number` is the 1-based number a transcript shows (`Speaker 1`,
    `Speaker 2`…); `Turn.speaker` is 0-based internally, so the conversion
    happens once, here, rather than asking every caller to remember which
    convention they are holding. The caller must have diarized `wav` with the
    same `--speakers`/`--speaker-threshold` that produced the transcript the
    user read to identify this speaker — clustering is deterministic for a
    given file and those parameters (`diarize._spherical_kmeans` seeds its
    random state at 0), so re-running it reproduces the same numbering rather
    than reshuffling it.
    """
    present = sorted({turn.speaker for turn in turns})
    internal = speaker_number - 1
    if internal not in present:
        raise VoiceStoreError(
            f"speaker {speaker_number} was not found — this diarization pass "
            f"produced speaker(s) {', '.join(str(s + 1) for s in present)}. "
            "If this doesn't match the transcript you read, re-run with the "
            "same --speakers (or --diarize) and --speaker-threshold that "
            "produced it; the numbering follows those, not the file alone."
        )
    _, default_embedding = diarize_mod.ensure_models()
    samples = read_wav_f32(wav)
    regions = sorted((turn.start, turn.end) for turn in turns if turn.speaker == internal)
    vector, seconds = print_from_regions(samples, regions, default_embedding)
    if vector is None:
        raise VoiceStoreError(
            f"speaker {speaker_number}'s turns in {wav.name} are all shorter "
            f"than {diarize_mod.MIN_WINDOW_SECONDS:.1f}s each, too fragmented "
            "to fingerprint"
        )
    _require_floor(seconds, context=f"for speaker {speaker_number} in {wav.name}")
    return vector, seconds, default_embedding


def enroll(name: str, vector: np.ndarray, seconds: float, embedding_model: Path, source: str) -> VoicePrint:
    """Store a computed print under `name`, overwriting any print already there.

    Overwriting rather than merging or refusing is deliberate: re-enrolling
    someone is how a bad print gets fixed, and there is no way to average an
    old print with a new one that means anything, since two prints can come
    from different amounts of speech and — if a model was ever repinned —
    different embedding spaces entirely.
    """
    name = name.strip()
    if not name:
        raise VoiceStoreError("a voice needs a name to enrol under")
    print_ = VoicePrint(
        name=name,
        embedding=[float(x) for x in vector],
        embedding_model=embedding_model.name,
        seconds=round(float(seconds), 1),
        source=source,
        enrolled=dt.date.today().isoformat(),
    )
    save_voice(print_)
    return print_


def cluster_print(
    samples: np.ndarray, turns: list[Turn], speaker_id: int, embedding_model: Path
) -> tuple[np.ndarray | None, float]:
    """The comparison embedding for one diarized cluster, during identification.

    Pools the cluster's longest turns, up to `IDENTIFY_SAMPLE_SECONDS`, rather
    than every turn it has — a 40-minute cluster does not need forty minutes
    of embedding calls to be recognised, and its longest turns are the least
    likely to be a straddled speaker change or a short backchannel.
    """
    mine = sorted(
        (turn for turn in turns if turn.speaker == speaker_id),
        key=lambda turn: turn.end - turn.start,
        reverse=True,
    )
    regions: list[tuple[float, float]] = []
    pooled = 0.0
    for turn in mine:
        if pooled >= IDENTIFY_SAMPLE_SECONDS:
            break
        regions.append((turn.start, turn.end))
        pooled += turn.end - turn.start
    if not regions:
        return None, 0.0
    return print_from_regions(samples, regions, embedding_model)


def best_match(
    vector: np.ndarray, prints: list[VoicePrint]
) -> tuple[VoicePrint, float, float] | None:
    """The strongest matching print, if the match is not ambiguous.

    `prints` must already be filtered to the current embedding model — this
    function does the comparison, not the compatibility check, so a caller
    working across models does not accidentally get a number that looks like
    a score and means nothing. A single candidate cannot be ambiguous by
    definition, so the runner-up score is a sentinel below any real cosine
    similarity (-1.0) when there is only one print to compare against.
    """
    if not prints:
        return None
    scored = sorted(
        ((float(vector @ print_.vector()), print_) for print_ in prints),
        key=lambda pair: pair[0],
        reverse=True,
    )
    best_score, best_print = scored[0]
    runner_up = scored[1][0] if len(scored) > 1 else -1.0
    if best_score < IDENTIFY_THRESHOLD:
        return None
    if best_score - runner_up < IDENTIFY_MARGIN:
        return None
    return best_print, best_score, runner_up


@dataclass
class SpeakerMatch:
    """One accepted identification: the (renamed) speaker and how well it
    matched. `lt/verify.py` reads these to flag an accepted-but-shaky match —
    see its `LOW_CONFIDENCE_BELOW` — without re-deciding anything `identify`
    already settled."""

    speaker: str
    similarity: float


@dataclass
class IdentifyResult:
    note: str | None
    matches: list[SpeakerMatch] = field(default_factory=list)


def identify(
    wav: Path, turns: list[Turn], utterances: list[Utterance], *, embedding_model: Path
) -> IdentifyResult:
    """Name diarized clusters that match an enrolled voice, and say how.

    Renames `utterances` in place — `Speaker N` becomes the enrolled name —
    and returns an `IdentifyResult`: `note` is one line for the transcript
    header naming which speakers were identified and at what similarity, or
    `None` when nothing was (no voices enrolled, no compatible print, or
    every cluster's best match fell short of `best_match`'s threshold and
    margin); `matches` is every accepted identification with its similarity,
    for `lt/verify.py` to judge separately from whether it was accepted at
    all.

    Two clusters can never be given the same enrolled name in one run: every
    cluster's best match is computed first, then claims are accepted
    strongest match first, so if two clusters both look like the same
    enrolled person the stronger match keeps the name and the weaker one is
    left `Speaker N` — numbered is honest, and attributing the same person to
    two different clusters never is.
    """
    prints = list_voices()
    if not prints:
        return IdentifyResult(None, [])

    compatible = [p for p in prints if p.embedding_model == embedding_model.name]
    ignored_models = {p.embedding_model for p in prints if p.embedding_model != embedding_model.name}
    if ignored_models:
        print(
            f"note: ignoring {len(prints) - len(compatible)} enrolled voice(s) "
            f"printed with {', '.join(sorted(ignored_models))} — this run's "
            f"embedding model is {embedding_model.name}, and a print is only "
            "ever compared within the model it was made with",
            file=sys.stderr,
        )
    if not compatible:
        return IdentifyResult(None, [])

    samples = read_wav_f32(wav)
    order: dict[int, int] = {}
    for turn in turns:
        order.setdefault(turn.speaker, len(order) + 1)

    candidates: list[tuple[float, int, str]] = []
    for speaker_id in sorted(order):
        vector, _ = cluster_print(samples, turns, speaker_id, embedding_model)
        if vector is None:
            continue
        match = best_match(vector, compatible)
        if match is None:
            continue
        matched_print, score, _ = match
        candidates.append((score, speaker_id, matched_print.name))

    accepted = _resolve_claims(candidates)
    note = _apply_matches(utterances, order, accepted)
    matches = [SpeakerMatch(speaker=name, similarity=score) for name, score in accepted.values()]
    return IdentifyResult(note=note, matches=matches)


def _resolve_claims(candidates: list[tuple[float, int, str]]) -> dict[int, tuple[str, float]]:
    """Which cluster gets which enrolled name, strongest match first.

    Pure and audio-free on purpose, unlike `identify` around it: this is the
    one piece of the decision that has nothing to do with embeddings or
    files, so it is tested directly on made-up scores rather than through a
    real recording. A name already claimed by a stronger match is not
    claimed again — a cluster that would otherwise take it is left out of
    the result entirely, which `_apply_matches` reads as "leave it numbered".
    """
    accepted: dict[int, tuple[str, float]] = {}
    claimed: set[str] = set()
    for score, speaker_id, name in sorted(candidates, reverse=True):
        if name in claimed:
            continue
        claimed.add(name)
        accepted[speaker_id] = (name, score)
    return accepted


def _apply_matches(
    utterances: list[Utterance], order: dict[int, int], accepted: dict[int, tuple[str, float]]
) -> str | None:
    """Rename the accepted clusters in place, and describe the change.

    A speaker id absent from `accepted` — never matched, or matched but lost
    its claim to a stronger cluster in `_resolve_claims` — is left exactly as
    it was: still `Speaker N`, not renamed to anything, because there is
    nothing here that decides its fate one way or the other.
    """
    if not accepted:
        return None
    renames = {f"Speaker {order[sid]}": name for sid, (name, _) in accepted.items()}
    for utterance in utterances:
        if utterance.speaker in renames:
            utterance.speaker = renames[utterance.speaker]
    parts = ", ".join(
        f"Speaker {order[sid]} → {name} (similarity {score:.2f})"
        for sid, (name, score) in sorted(accepted.items(), key=lambda item: order[item[0]])
    )
    return f"identified from enrolled voices: {parts}"


__all__ = [
    "IDENTIFY_MARGIN",
    "IDENTIFY_SAMPLE_SECONDS",
    "IDENTIFY_THRESHOLD",
    "MIN_ENROLL_SECONDS",
    "IdentifyResult",
    "SpeakerMatch",
    "VoicePrint",
    "VoiceStoreError",
    "best_match",
    "cluster_print",
    "enroll",
    "enroll_from_file",
    "enroll_from_speaker",
    "forget_voice",
    "identify",
    "list_voices",
    "load_voice",
    "path_for",
    "print_from_regions",
    "save_voice",
    "voices_dir",
]
