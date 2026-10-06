"""Copying a finished recording somewhere else — local first, always.

**Record locally, then copy — never record straight to a network share.** A
network blip mid-call cannot be re-recorded, whereas a failed copy costs
nothing because the local file is still there. So the local file stays put
until someone deletes it by hand, and a copy failure is a warning that names
the local path rather than an error that loses the recording.

There is **no default destination.** Unset means keep the local file and say so,
which is the safe answer — a colleague's recording must never be copied to
somebody else's machine because a default pointed there.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass
class CopyResult:
    copied: bool
    destination: Path | None
    message: str


def archive_dir() -> Path | None:
    configured = os.environ.get("LOCAL_TRANSCRIBE_ARCHIVE_DIR")
    return Path(configured).expanduser() if configured else None


def copy_recording(source: Path, destination_dir: Path | None = None) -> CopyResult:
    destination_dir = destination_dir or archive_dir()
    if destination_dir is None:
        return CopyResult(
            False, None,
            f"No archive directory is set, so the recording stays at {source}. "
            "Set LOCAL_TRANSCRIBE_ARCHIVE_DIR to copy finished recordings somewhere.",
        )
    if not source.exists():
        return CopyResult(False, None, f"Nothing to copy: {source} does not exist.")

    try:
        destination_dir.mkdir(parents=True, exist_ok=True)
        destination = destination_dir / source.name
        shutil.copy2(source, destination)
        copied_size = destination.stat().st_size
        source_size = source.stat().st_size
        if copied_size != source_size:
            return CopyResult(
                False, destination,
                f"The copy is {copied_size} bytes but the original is {source_size}. "
                f"Treat the copy as bad; the recording is safe at {source}.",
            )
    except OSError as exc:
        return CopyResult(
            False, None,
            f"Could not copy to {destination_dir}: {exc}. "
            f"The recording is safe at {source} — copy it across when the "
            "destination is back.",
        )

    return CopyResult(
        True, destination,
        f"Copied to {destination}. The local file is still at {source} and is not "
        "deleted automatically.",
    )
