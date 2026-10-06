"""Mounting a source's network share from inside the container, on a timer.

A source declaring `[source.volume]` lives on a network share, and a share is
not always there: `core` is only on the home LAN, so on work wifi or while
travelling its address does not resolve at all. **That must never stop lookup
starting**, and it must not need a human to fix once the share comes back.

The mount is therefore made here rather than by Docker. A Docker volume is
attached when the container is created and cannot be added to a running one,
so a volume-backed source turns every restart away from home into a container
that refuses to start, and every walk back into the flat into a manual
`docker compose up -d`. Mounting from inside costs `CAP_SYS_ADMIN` and buys
both: the container starts with whatever is reachable, and the share attaches
itself later.

Performance is unchanged. The point of the Docker volume was that the kernel
inside the VM speaks CIFS directly instead of reads crossing the host-to-VM
filesystem bridge — a walk of 3 s rather than 34 s. A mount made inside the
container is that same in-VM CIFS mount.

`reconcile()` is called at the head of every ingest pass, so the existing
`--reingest-interval` is the poll: nothing new is scheduled, and the interval
that decides how fresh the index is also decides how quickly a returning share
is picked up.

A mount is only called successful when it shows content. `mount` exits 0 for an
empty share and for the wrong share, and either leaves the root existing, which
stops the source being reported as stale and starts it being reported as present
and empty. An empty mount is therefore backed out again.

Nothing here raises. A share that cannot be mounted is reported and the source
is left absent, which the ingest pass already handles correctly — its rows stay
and it is marked stale.
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

SMB_PORT = 445
PROBE_TIMEOUT = 2.0
MOUNT_TIMEOUT = 20.0

# `mount.cifs` lives in cifs-utils. Without it `mount -t cifs` fails with
# "helper program not found", which is a build problem and not a network one,
# so it is reported differently.
#
# ⚠️ Found by location, never by a fixed path. Debian trixie installs it at
# /usr/sbin/mount.cifs, and a constant of "/sbin/mount.cifs" made every mount
# report cifs-utils as missing on an image that had it — a build problem
# announced where the real answer was a working mount.
CIFS_HELPER_NAME = "mount.cifs"
CIFS_HELPER_DIRS = ("/sbin", "/usr/sbin", "/bin", "/usr/bin")


def cifs_helper() -> str | None:
    """The path to `mount.cifs`, or None when the image lacks cifs-utils."""
    found = shutil.which(CIFS_HELPER_NAME)
    if found:
        return found
    for directory in CIFS_HELPER_DIRS:
        candidate = Path(directory) / CIFS_HELPER_NAME
        if candidate.exists():
            return str(candidate)
    return None


@dataclass
class Outcome:
    attached: list[str] = field(default_factory=list)
    detached: list[str] = field(default_factory=list)
    unreachable: list[str] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "attached": self.attached,
            "detached": self.detached,
            "unreachable": self.unreachable,
            "failed": self.failed,
        }

    @property
    def quiet(self) -> bool:
        """True when nothing changed and nothing is wrong, so nothing is logged."""
        return not (self.attached or self.detached or self.failed)


def host_of(device: str) -> str:
    """The host part of a `//host/share` address, or "" if it is not one."""
    if not device.startswith("//"):
        return ""
    return device.lstrip("/").split("/")[0]


def reachable(device: str, *, timeout: float = PROBE_TIMEOUT) -> bool:
    """Whether the SMB port answers on this address's host.

    A TCP probe rather than a mount attempt, because an unreachable host makes
    `mount` hang for its own much longer timeout, and this runs on every ingest
    pass.
    """
    host = host_of(device)
    if not host:
        return False
    try:
        with socket.create_connection((host, SMB_PORT), timeout=timeout):
            return True
    except OSError:
        return False


def mount_points() -> set[str]:
    """Every currently mounted path, read from the kernel."""
    try:
        text = Path("/proc/self/mounts").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return set()
    points = set()
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            # The kernel escapes spaces and tabs in mount fields as octal.
            points.add(re.sub(r"\\(\d{3})", lambda m: chr(int(m.group(1), 8)), parts[1]))
    return points


def is_mounted(path: Path) -> bool:
    return str(path) in mount_points()


def has_content(root: Path) -> tuple[bool, str]:
    """Whether a mounted root shows anything at all. Returns (ok, why-not).

    The cheap half of "did the mount work": one directory read, no walk. An
    empty result does not distinguish an empty share from the wrong share from
    an account that cannot read it, and it does not need to — all three mean
    the same thing to the caller, which is that this mount must not be
    presented as a working source.
    """
    try:
        if next(root.iterdir(), None) is None:
            return False, "it is empty"
    except PermissionError:
        return False, "its contents cannot be read by this account"
    except OSError as exc:
        return False, f"its contents cannot be listed: {exc}"
    return True, ""


def _expand(value: object) -> str:
    """Resolve `${VAR}` from the environment, as the manifest documents.

    Anything that is not a string becomes "", so a manifest that declares
    `device = 12345` is reported as having no device rather than taking the
    whole ingest pass down with a TypeError from deep inside this helper.
    """
    if not isinstance(value, str) or not value:
        return ""
    return os.path.expandvars(value)


def _options(spec: dict) -> str:
    """Build the `-o` string, with credentials appended from the environment."""
    parts = [p for p in (_expand(spec.get("options")) or "").split(",") if p]
    user = _expand(spec.get("username"))
    password = _expand(spec.get("password"))
    if user:
        parts.append(f"username={user}")
    # An empty password must still be passed, or mount.cifs prompts on stdin
    # and hangs forever with no terminal attached.
    parts.append(f"password={password}")
    if "ro" not in parts:
        parts.append("ro")
    return ",".join(parts)


def attach(src) -> tuple[bool, str]:
    """Mount one source's share at its declared root. Returns (ok, message)."""
    spec = src.volume or {}
    if spec.get("type") != "cifs":
        return False, f"unsupported volume type {spec.get('type')!r}"

    device = _expand(spec.get("device"))
    if not device:
        return False, "no device declared"
    if cifs_helper() is None:
        return False, (
            f"{CIFS_HELPER_NAME} is not on this system, so the kernel cannot "
            "mount cifs. cifs-utils must be installed in the image."
        )

    root = Path(src.root)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return False, f"cannot create the mount point {root}: {exc}"

    # The password never reaches the log: the command is not echoed, and the
    # failure message is mount.cifs's own stderr with the options withheld.
    args = ["mount", "-t", "cifs", device, str(root), "-o", _options(spec)]
    try:
        done = subprocess.run(
            args, capture_output=True, text=True, timeout=MOUNT_TIMEOUT
        )
    except subprocess.TimeoutExpired:
        return False, f"mount of {device} timed out after {MOUNT_TIMEOUT:.0f}s"
    except OSError as exc:
        return False, f"could not run mount: {exc}"

    if done.returncode != 0:
        detail = (done.stderr or done.stdout or "").strip().splitlines()
        return False, f"mount of {device} failed: {detail[-1] if detail else 'no output'}"

    # ⚠️ Exit 0 is not proof that the mount is usable, and this is the failure
    # worth guarding: cifs happily mounts a share that is empty, and it mounts
    # the wrong share just as willingly when the name is a typo. Either way the
    # root then EXISTS, so the source stops being reported as stale and starts
    # being reported as present-and-empty — a corpus that quietly answers
    # nothing instead of saying it is offline.
    #
    # So a successful mount has to show content. One readdir, not a walk: the
    # question is "did anything arrive", and the ingest pass does the walking.
    ok, why = has_content(root)
    if not ok:
        # Back out, so the state left behind is the honest one. Mounted-and-
        # empty makes the source look present; unmounted makes it stale, which
        # is what it actually is, and the next pass retries in five minutes.
        detach(src)
        return False, (
            f"mounted {device} but {why} — backed it out, so the source stays "
            f"stale rather than looking present and empty. Check the share name "
            f"and that the account can read it."
        )
    return True, f"mounted {device} at {root}"


def detach(src) -> tuple[bool, str]:
    """Unmount one source's share.

    Lazy, because a share whose server has vanished leaves reads blocked in the
    kernel and a plain unmount then fails with "target is busy" — which would
    leave the mount point permanently unusable.
    """
    root = Path(src.root)
    try:
        done = subprocess.run(
            ["umount", "-l", str(root)],
            capture_output=True, text=True, timeout=MOUNT_TIMEOUT,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        return False, f"could not unmount {root}: {exc}"
    if done.returncode != 0:
        detail = (done.stderr or "").strip().splitlines()
        return False, f"unmount of {root} failed: {detail[-1] if detail else 'no output'}"
    return True, f"unmounted {root}"


def reconcile(srcs: dict) -> Outcome:
    """Make the mounts match what is reachable, for every share-backed source.

    Four states per source, and each has exactly one right action:

        reachable, not mounted   -> mount it, so this pass indexes it
        reachable, mounted       -> leave alone
        unreachable, mounted     -> unmount, so reads fail fast instead of hanging
        unreachable, not mounted -> report it, and let the pass mark it stale
    """
    out = Outcome()
    for name, src in srcs.items():
        spec = getattr(src, "volume", None)
        # `None` means a local source, which is not this function's business.
        # An empty or device-less table is a DECLARATION that cannot be
        # honoured, and reporting it as a failure is the point: treated as
        # "not a share" it would silently become a local source whose root
        # never exists, which reads as an empty corpus rather than a typo.
        if spec is None:
            continue

        device = _expand(spec.get("device"))
        if not device:
            out.failed[name] = (
                "declares [source.volume] with no device, so there is nothing "
                "to mount"
            )
            continue

        mounted = is_mounted(Path(src.root))
        if reachable(device):
            if mounted:
                continue
            ok, message = attach(src)
            if ok:
                out.attached.append(name)
            else:
                out.failed[name] = message
        else:
            if mounted:
                ok, message = detach(src)
                if ok:
                    out.detached.append(name)
                else:
                    out.failed[name] = message
            out.unreachable.append(name)
    return out


__all__ = [
    "Outcome",
    "attach",
    "detach",
    "has_content",
    "host_of",
    "is_mounted",
    "mount_points",
    "reachable",
    "reconcile",
]
