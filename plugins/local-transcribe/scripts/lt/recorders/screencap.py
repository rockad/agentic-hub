"""The macOS built-in screen recorder, `screencapture -v`.

⚠️ **It cannot capture system audio.** Verified on macOS 26.6.2: `screencapture`
offers exactly three relevant flags — `-v` (record video), `-g` (*"captures
audio during a video recording using default **input**"*) and `-G<id>` (a
specified audio **input** id). There is no system-audio flag.

So a bare `screencapture -v -g` of a call records **your voice only** and the
other participants are silent — and you find out afterwards, when the recording
is worthless for the reason you made it. This backend therefore **refuses to
record a call** on the mic-only path unless told explicitly that mic-only is
what was wanted.

The fix is a virtual loopback (BlackHole is the free one) combined with the
built-in microphone into a macOS **Aggregate Device**, made the default input.
That yields one multi-channel stream — input shape C — whose channels can be
split back into mic and far end, recovering deterministic labels with a much
lighter install than OBS.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from .base import (
    Capabilities,
    Recorder,
    RecorderError,
    Recording,
    clear_state,
    read_state,
    write_state,
)

STATE = "screencapture"

# Virtual loopback drivers, matched by name because CoreAudio does not label
# them as a class. Aggregate and virtual transports are matched separately.
LOOPBACK_NAMES = ("blackhole", "loopback", "soundflower", "vb-cable", "vb-audio", "existential")


def _devices() -> list[dict]:
    """Audio devices as CoreAudio reports them, or [] if unreadable."""
    if not shutil.which("system_profiler"):
        return []
    result = subprocess.run(
        ["system_profiler", "SPAudioDataType", "-json"],
        capture_output=True, text=True, check=False, timeout=30,
    )
    if result.returncode != 0:
        return []
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return []
    items: list[dict] = []
    for section in data.get("SPAudioDataType", []):
        items.extend(section.get("_items", []))
    return items


def loopback_devices() -> list[str]:
    """Inputs that could carry system audio: a loopback driver, or an aggregate."""
    found = []
    for device in _devices():
        name = str(device.get("_name", ""))
        transport = str(device.get("coreaudio_device_transport", "")).lower()
        inputs = device.get("coreaudio_device_input") or 0
        if not inputs:
            continue
        if any(hint in name.lower() for hint in LOOPBACK_NAMES) or "aggregate" in transport or "virtual" in transport:
            found.append(name)
    return found


def input_devices() -> list[str]:
    return [
        str(d.get("_name", "?"))
        for d in _devices()
        if (d.get("coreaudio_device_input") or 0)
    ]


def record_dir() -> Path:
    configured = os.environ.get("LOCAL_TRANSCRIBE_RECORD_DIR")
    base = Path(configured).expanduser() if configured else Path.home() / "Movies"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class ScreencaptureRecorder(Recorder):
    name = "screencapture"

    def detect(self) -> bool:
        return sys.platform == "darwin" and shutil.which("screencapture") is not None

    def capabilities(self) -> Capabilities:
        caps = Capabilities(name=self.name, available=False)
        if sys.platform != "darwin":
            caps.blockers.append("screencapture is macOS only.")
            return caps
        if not shutil.which("screencapture"):
            caps.blockers.append("screencapture is not on PATH, which is unusual on macOS.")
            return caps

        caps.available = True
        caps.video = True
        caps.mic = True

        loopbacks = loopback_devices()
        if loopbacks:
            caps.system_audio = True
            caps.separate_tracks = False
            caps.shape = "C"
            caps.label_quality = (
                "deterministic once the channel map is known — the transcriber "
                "cannot split channels yet, so unlabelled for now"
            )
            caps.notes.append(
                f"Loopback or aggregate input found: {', '.join(loopbacks)}. "
                "Make it the system's default input (System Settings → Sound) so "
                "-g picks it up, and confirm it mixes the microphone as well as "
                "system output — a loopback alone captures the far end and not you."
            )
        else:
            caps.system_audio = False
            caps.shape = "D"
            caps.label_quality = "none — microphone only, so the far end is silent"
            # Not a blocker: the backend works, and a mic-only recording is a
            # legitimate thing to want. `can_record_a_call` carries the refusal.
            caps.notes.append(
                "⚠️ No loopback or aggregate input device is installed, so this "
                "backend cannot capture the other participants at all: it records "
                "your microphone and nothing else."
            )
            caps.notes.append(
                "To fix it: install BlackHole (free), then in Audio MIDI Setup create "
                "an Aggregate Device combining BlackHole with the built-in microphone "
                "and make it the default input. That gives one multi-channel stream "
                "(input shape C) instead of a mic-only recording."
            )
            caps.notes.append(
                f"Inputs currently visible: {', '.join(input_devices()) or 'none'}."
            )

        caps.notes.append(
            "Needs Screen Recording permission in System Settings → Privacy & "
            "Security the first time; without it the file is created and stays empty."
        )
        return caps

    def start(self, *, mic_only_ok: bool = False) -> Recording:
        existing = self.status()
        if existing.active:
            raise RecorderError(
                f"A screencapture recording is already running (pid "
                f"{read_state(STATE).get('pid')}), writing to {existing.path}."
            )

        caps = self.capabilities()
        if not caps.system_audio and not mic_only_ok:
            raise RecorderError(
                "Refusing to record: this backend would capture your microphone only, "
                "so everyone else on the call would be silent — and you would not find "
                "out until you played the file back.\n"
                + "\n".join(f"  {note}" for note in caps.notes[:2])
                + "\nPass --mic-only if a microphone-only recording is genuinely what "
                "you want (dictation, a talk-through, your half of a conversation)."
            )

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        destination = record_dir() / f"local-transcribe-{stamp}.mov"
        args = ["screencapture", "-v"]
        if device := os.environ.get("LOCAL_TRANSCRIBE_AUDIO_DEVICE"):
            args.append(f"-G{device}")
        else:
            args.append("-g")
        args.append(str(destination))

        process = subprocess.Popen(
            args, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        time.sleep(1.5)  # long enough for an immediate failure to surface
        if process.poll() is not None:
            stderr = (process.stderr.read() or b"").decode(errors="replace").strip()
            raise RecorderError(
                f"screencapture exited immediately: {stderr or 'no message'}\n"
                "The usual cause is missing Screen Recording permission in System "
                "Settings → Privacy & Security."
            )

        write_state(STATE, {
            "pid": process.pid,
            "path": str(destination),
            "started_at": time.time(),
            "mic_only": not caps.system_audio,
        })
        notes = [f"Writing to {destination}"]
        if not caps.system_audio:
            notes.append("⚠️ Microphone only — the far end is not being recorded.")
        return Recording(
            backend=self.name, path=destination, active=True,
            started_at=time.time(), notes=notes,
        )

    def stop(self) -> Recording:
        state = read_state(STATE)
        if not state:
            raise RecorderError("No screencapture recording was started by this plugin.")
        pid, path = state.get("pid"), Path(state.get("path", ""))
        if not pid or not _pid_alive(int(pid)):
            clear_state(STATE)
            raise RecorderError(
                f"The recording process (pid {pid}) is no longer running. "
                f"If the file exists it is at {path}."
            )

        # screencapture finalises the file on SIGINT; SIGKILL loses it.
        os.kill(int(pid), signal.SIGINT)
        for _ in range(40):  # up to ~10s for the container to be written
            if not _pid_alive(int(pid)):
                break
            time.sleep(0.25)
        clear_state(STATE)

        duration = time.time() - float(state.get("started_at") or time.time())
        size = path.stat().st_size if path.exists() else None
        notes = []
        if size == 0:
            notes.append(
                "⚠️ The file is empty. That is what a missing Screen Recording "
                "permission looks like — grant it in System Settings → Privacy & "
                "Security and record again."
            )
        if state.get("mic_only"):
            notes.append("This recording is microphone only; the far end is silent.")
        return Recording(
            backend=self.name, path=path if path.exists() else None,
            active=False, duration=duration, bytes_written=size, notes=notes,
        )

    def status(self) -> Recording:
        state = read_state(STATE)
        if not state:
            return Recording(backend=self.name, path=None, active=False)
        pid = state.get("pid")
        alive = bool(pid) and _pid_alive(int(pid))
        path = Path(state["path"]) if state.get("path") else None
        if not alive:
            return Recording(
                backend=self.name, path=path, active=False,
                notes=["A previous recording's process is gone; state is stale."],
            )
        return Recording(
            backend=self.name, path=path, active=True,
            started_at=state.get("started_at"),
            duration=time.time() - float(state.get("started_at") or time.time()),
            bytes_written=path.stat().st_size if path and path.exists() else None,
        )
