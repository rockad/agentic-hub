"""Recorder backends, and choosing between them by what they can deliver.

The recorder's job is **capability negotiation**, not just start/stop: on a
machine with more than one backend, silently picking the convenient one produces
a mixed single stream that no speaker separation can un-mix. So detection
reports what each backend would actually give you, and the caller chooses
knowingly.
"""

from __future__ import annotations

import os

from .base import Capabilities, Recorder, RecorderError, Recording
from .obs import ObsRecorder
from .screencap import ScreencaptureRecorder

BACKENDS: dict[str, type[Recorder]] = {
    "obs": ObsRecorder,
    "screencapture": ScreencaptureRecorder,
}

# Best-labels-first. OBS is the only cross-platform route to deterministic
# Me / Remote labels, so it wins any tie.
PREFERENCE = ("obs", "screencapture")


def get(name: str) -> Recorder:
    try:
        return BACKENDS[name]()
    except KeyError as exc:
        raise RecorderError(
            f"Unknown recorder backend {name!r}. Known: {', '.join(BACKENDS)}."
        ) from exc


def pinned() -> str | None:
    return os.environ.get("LOCAL_TRANSCRIBE_RECORDER") or None


def survey() -> list[Capabilities]:
    """Every backend's honest report, in preference order."""
    results = []
    for name in PREFERENCE:
        try:
            results.append(get(name).capabilities())
        except RecorderError as exc:
            results.append(Capabilities(name=name, available=False, blockers=[str(exc)]))
    return results


def choose(*, for_a_call: bool = True) -> tuple[Recorder | None, list[Capabilities]]:
    """Pick a backend, or return None with the survey so the caller can explain.

    A pinned `LOCAL_TRANSCRIBE_RECORDER` is honoured even when it is the worse
    choice — pinning is a deliberate act. Otherwise, for a call, only a backend
    that can actually capture the far end is eligible.
    """
    reports = survey()
    by_name = {report.name: report for report in reports}

    if name := pinned():
        report = by_name.get(name)
        if report is None:
            raise RecorderError(f"LOCAL_TRANSCRIBE_RECORDER={name!r} is not a known backend.")
        return (get(name) if report.available else None), reports

    for name in PREFERENCE:
        report = by_name[name]
        if not report.available:
            continue
        if for_a_call and not report.can_record_a_call:
            continue
        return get(name), reports
    return None, reports


__all__ = [
    "BACKENDS", "Capabilities", "PREFERENCE", "Recorder", "RecorderError",
    "Recording", "choose", "get", "pinned", "survey",
]
