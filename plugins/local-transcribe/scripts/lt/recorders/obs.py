"""OBS Studio as a recorder backend, over obs-websocket v5.

OBS is the only cross-platform recorder that yields **deterministic speaker
labels** for the calls people actually have — Google Meet has no local recording
of its own, so a Meet call has to be captured around the browser, and only OBS's
two-track routing puts your microphone and the far end on separate streams
(input shape B). That is why it is worth supporting properly, and equally why it
stays one backend among several rather than a dependency of the plugin.

The handshake is **not** hand-rolled here: `obsws-python` is the maintained
obs-websocket v5 client and owns the hello/identify/request framing. OBS's
WebSocket is plain TCP on `127.0.0.1:4455` on every platform.

**The password is never handled by Claude and never pasted into a conversation.**
It comes from `OBS_WS_PASSWORD`, or from the OS keyring, and nothing here prints
it or includes it in an error.
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

from .base import Capabilities, Recorder, RecorderError, Recording

DEFAULT_PORT = 4455
KEYCHAIN_SERVICE = "obs-websocket"

# Where the app lives, per platform, for a "start OBS first" message that names
# something real. Config overrides it; a wrong guess must not become an error.
LAUNCH_COMMANDS = {
    "darwin": ["open", "-a", "OBS"],
    "linux": ["obs"],
    "win32": ["cmd", "/c", "start", "", "obs64.exe"],
}
APP_HINTS = {
    "darwin": ["/Applications/OBS.app"],
    "linux": ["/usr/bin/obs", "/usr/local/bin/obs", "/var/lib/flatpak/app/com.obsproject.Studio"],
}


def _running_under_wsl() -> bool:
    if sys.platform != "linux":
        return False
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except OSError:
        return False


def _wsl_host_candidates() -> list[str]:
    """Hosts to try for an OBS running on the Windows side of WSL.

    WSL2 with `networkingMode=mirrored` makes `127.0.0.1` reach the host; under
    NAT it does not, and the host is at the nameserver address in
    `/etc/resolv.conf`. Try loopback first, then that.
    """
    hosts = ["127.0.0.1"]
    try:
        for line in Path("/etc/resolv.conf").read_text().splitlines():
            if m := re.match(r"^\s*nameserver\s+(\S+)", line):
                hosts.append(m.group(1))
    except OSError:
        pass
    return hosts


def candidate_hosts() -> list[str]:
    configured = os.environ.get("OBS_WS_HOST")
    if configured:
        return [configured]
    if _running_under_wsl():
        return _wsl_host_candidates()
    return ["127.0.0.1"]


def port() -> int:
    raw = os.environ.get("OBS_WS_PORT", str(DEFAULT_PORT))
    try:
        return int(raw)
    except ValueError as exc:
        raise RecorderError(f"OBS_WS_PORT is not a number: {raw!r}") from exc


def _password() -> str | None:
    """From the environment, else the OS keyring. Never printed, never returned
    to a caller that might log it — only handed to the client."""
    if value := os.environ.get("OBS_WS_PASSWORD"):
        return value
    if sys.platform == "darwin" and shutil.which("security"):
        result = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True, check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return None


def _reachable(host: str, tcp_port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, tcp_port), timeout=timeout):
            return True
    except (OSError, socket.timeout):
        return False


def _app_present() -> bool:
    for path in APP_HINTS.get(sys.platform, []):
        if Path(path).exists():
            return True
    return shutil.which("obs") is not None


class ObsRecorder(Recorder):
    name = "obs"

    def __init__(self) -> None:
        self._client = None
        self._host: str | None = None

    # --- connection ---------------------------------------------------------

    def _connect(self):
        if self._client is not None:
            return self._client
        try:
            import obsws_python as obsws
        except ImportError as exc:
            raise RecorderError(
                "obsws-python is not installed — it is the obs-websocket client. "
                "Run this through `uv run --script`, which installs it."
            ) from exc

        tcp_port = port()
        errors: list[str] = []
        for host in candidate_hosts():
            if not _reachable(host, tcp_port):
                errors.append(f"{host}:{tcp_port} refused the connection")
                continue
            try:
                self._client = obsws.ReqClient(
                    host=host, port=tcp_port, password=_password(), timeout=5
                )
                self._host = host
                return self._client
            except Exception as exc:  # obsws raises several unrelated types
                # Never include the password, and never echo an exception that
                # might carry it — say what to check instead.
                errors.append(
                    f"{host}:{tcp_port} accepted the socket but refused the session "
                    f"({type(exc).__name__}). If OBS has authentication enabled, set "
                    "OBS_WS_PASSWORD (or store it in the OS keyring)."
                )
        raise RecorderError(self._unreachable_message(errors))

    def _unreachable_message(self, errors: list[str]) -> str:
        lines = ["Could not reach OBS's WebSocket server."]
        lines += [f"  - {e}" for e in errors]
        if not _app_present():
            lines.append(
                "OBS does not appear to be installed. Install it from obsproject.com, "
                "or set OBS_WS_HOST if it runs on another machine."
            )
        else:
            lines.append(
                "OBS looks installed but is not answering. Start it, then enable "
                "Tools → WebSocket Server Settings → Enable WebSocket server."
            )
        if _running_under_wsl():
            lines.append(
                "Under WSL, an OBS on the Windows side is reachable at 127.0.0.1 only "
                "with networkingMode=mirrored; otherwise use the /etc/resolv.conf "
                "nameserver address, or set OBS_WS_HOST."
            )
        return "\n".join(lines)

    def launch_command(self) -> list[str] | None:
        if configured := os.environ.get("OBS_LAUNCH_COMMAND"):
            return configured.split()
        return LAUNCH_COMMANDS.get(sys.platform)

    # --- interface ----------------------------------------------------------

    def detect(self) -> bool:
        return any(_reachable(host, port()) for host in candidate_hosts())

    def capabilities(self) -> Capabilities:
        caps = Capabilities(name=self.name, available=False)
        if not self.detect():
            caps.blockers.append(
                "OBS is not answering on "
                f"{','.join(candidate_hosts())}:{port()} — start it and enable its "
                "WebSocket server (Tools → WebSocket Server Settings)."
                if _app_present()
                else "OBS is not installed."
            )
            return caps

        caps.available = True
        caps.video = True
        caps.mic = True
        caps.system_audio = True
        try:
            client = self._connect()
        except RecorderError as exc:
            caps.available = False
            caps.blockers.append(str(exc))
            return caps

        tracks = self._recording_tracks(client)
        if tracks is None:
            caps.separate_tracks = False
            caps.shape = None
            caps.label_quality = "unknown until the track routing is checked"
            caps.notes.append(
                "Could not read the recording track configuration from this OBS "
                "version. Check Settings → Output → Recording: two enabled audio "
                "tracks give deterministic Me / Remote labels; one gives none."
            )
        elif tracks >= 2:
            caps.separate_tracks = True
            caps.shape = "B"
            caps.label_quality = "deterministic Me / Remote N"
            caps.notes.append(
                f"{tracks} audio tracks are enabled for recording. Each source must "
                "also be routed to its own track in Advanced Audio Properties — a "
                "profile reset silently undoes that."
            )
        else:
            caps.separate_tracks = False
            caps.shape = "D"
            caps.label_quality = "Speaker N at best, and no way to tell which is you"
            caps.notes.append(
                "Only one audio track is enabled for recording, so your microphone "
                "and the far end are mixed into one stream. Enable a second track in "
                "Settings → Output → Recording and route the mic to it."
            )

        try:
            caps.notes.append(f"Recordings go to {self.record_directory(client)}")
        except RecorderError:
            pass
        return caps

    def _recording_tracks(self, client) -> int | None:
        """How many audio tracks the recording writes, or None if unreadable.

        OBS stores this per output mode, and the parameter names differ between
        Simple and Advanced. Try both and count the bits; report None rather
        than guessing when neither answers.
        """
        for category, name in (("AdvOut", "RecTracks"), ("SimpleOutput", "RecTracks")):
            try:
                response = client.get_profile_parameter(category, name)
            except Exception:
                continue
            raw = getattr(response, "parameter_value", None)
            if raw in (None, ""):
                continue
            try:
                return bin(int(raw)).count("1")
            except ValueError:
                continue
        return None

    def record_directory(self, client=None) -> str:
        client = client or self._connect()
        try:
            return client.get_record_directory().record_directory
        except Exception as exc:
            raise RecorderError(
                "OBS did not answer GetRecordDirectory — it needs obs-websocket 5.x "
                f"(OBS 30 or newer). {type(exc).__name__}"
            ) from exc

    def start(self, *, mic_only_ok: bool = False) -> Recording:
        client = self._connect()
        status = client.get_record_status()
        if getattr(status, "output_active", False):
            raise RecorderError(
                "OBS is already recording. Stop that recording before starting "
                "another, or the two will fight over the same output."
            )
        client.start_record()
        # OBS does not report the output path until the recording stops, so the
        # directory is the most that can be said now.
        try:
            directory = self.record_directory(client)
        except RecorderError:
            directory = None
        return Recording(
            backend=self.name,
            path=None,
            active=True,
            started_at=time.time(),
            notes=[f"Writing into {directory}" if directory else "Output directory unknown"],
        )

    @staticmethod
    def _duration_seconds(status) -> float | None:
        """obs-websocket reports `outputDuration` in milliseconds; Recording
        carries seconds, so a raw pass-through reports a 16-second clip as
        16099 seconds."""
        millis = getattr(status, "output_duration", None)
        return None if millis is None else millis / 1000.0

    def stop(self) -> Recording:
        client = self._connect()
        status = client.get_record_status()
        if not getattr(status, "output_active", False):
            raise RecorderError("OBS is not recording, so there is nothing to stop.")
        response = client.stop_record()
        path = getattr(response, "output_path", None)
        return Recording(
            backend=self.name,
            path=Path(path) if path else None,
            active=False,
            duration=self._duration_seconds(status),
            bytes_written=getattr(status, "output_bytes", None),
            notes=[] if path else ["OBS did not report an output path."],
        )

    def status(self) -> Recording:
        client = self._connect()
        status = client.get_record_status()
        active = bool(getattr(status, "output_active", False))
        return Recording(
            backend=self.name,
            path=None,
            active=active,
            duration=self._duration_seconds(status),
            bytes_written=getattr(status, "output_bytes", None),
            notes=[f"timecode {getattr(status, 'output_timecode', '?')}"] if active else [],
        )
