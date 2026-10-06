"""The recorder backend interface.

Recording is one optional way to get an input file, and OBS is one of several
recorders — so this is an interface with implementations rather than an
if-chain. `capabilities()` is the reason: a backend must be able to say, before
anything is recorded, **what speaker-label quality it will actually deliver**,
so nobody discovers after an hour-long call that the file cannot tell four
people apart.

Backends report the input *shape* they produce, using the same letters the
transcriber detects:

    B   two audio streams in one container      → deterministic Me / Remote N
    C   one multi-channel stream mapped to sources → deterministic, once mapped
    D   one mixed stream                        → diarization only, no Me anchor
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path


class RecorderError(RuntimeError):
    """A backend could not do what was asked, with a reason worth printing."""


@dataclass
class Capabilities:
    """What a backend will actually deliver on this machine, right now."""

    name: str
    available: bool
    video: bool = False
    mic: bool = False
    system_audio: bool = False
    separate_tracks: bool = False
    shape: str | None = None
    label_quality: str = "unknown"
    notes: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)

    @property
    def can_record_a_call(self) -> bool:
        """A call needs the far end. Mic-only makes a worthless recording."""
        return self.available and self.system_audio

    def as_dict(self) -> dict:
        data = asdict(self)
        data["can_record_a_call"] = self.can_record_a_call
        return data


@dataclass
class Recording:
    """A recording in progress or just finished."""

    backend: str
    path: Path | None
    active: bool
    started_at: float | None = None
    duration: float | None = None
    """How long the recording has run, **in seconds**. A backend whose API
    reports milliseconds converts before filling this in."""
    bytes_written: int | None = None
    notes: list[str] = field(default_factory=list)


class Recorder:
    """One recorder backend. Subclasses implement the five methods."""

    name: str = "unnamed"

    def detect(self) -> bool:
        """Is this backend usable on this machine right now?"""
        raise NotImplementedError

    def capabilities(self) -> Capabilities:
        """What it will deliver — honest about what it cannot do."""
        raise NotImplementedError

    def start(self, *, mic_only_ok: bool = False) -> Recording:
        raise NotImplementedError

    def stop(self) -> Recording:
        raise NotImplementedError

    def status(self) -> Recording:
        raise NotImplementedError


# --- state, for backends that cannot answer "am I recording?" themselves ----

def state_dir() -> Path:
    """Where a backend keeps the little state it needs between invocations.

    `screencapture` has no way to ask whether it is running, so its PID and
    output path have to be written down. OBS answers `GetRecordStatus` and needs
    none of this.
    """
    override = os.environ.get("LOCAL_TRANSCRIBE_STATE_DIR")
    if override:
        base = Path(override)
    else:
        xdg = os.environ.get("XDG_STATE_HOME")
        base = Path(xdg) / "local-transcribe" if xdg else Path.home() / ".local/state/local-transcribe"
    base.mkdir(parents=True, exist_ok=True)
    return base


def write_state(name: str, data: dict) -> Path:
    path = state_dir() / f"{name}.json"
    data = {**data, "written_at": time.time()}
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def read_state(name: str) -> dict | None:
    path = state_dir() / f"{name}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def clear_state(name: str) -> None:
    (state_dir() / f"{name}.json").unlink(missing_ok=True)
