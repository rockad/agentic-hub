"""The real-terminal rules of `a2a-coord` (S1-ADMIN; spec 8.3, decisions D10, D11, D19).

`key create`, `key rotate`, `review show`, `review release` and `review deny` run only when

1. standard input AND standard output are a terminal (over `docker compose exec` that means `-it`),
   so a secret or a held body is printed only to a terminal and not into a pipe or a transcript; and
2. no agent-session marker is set in the environment. A marker is a variable whose name starts with
   `CLAUDE`, `ANTIGRAVITY` or `AGY_`, or the variable `CI`, whatever its value (`CLAUDE_CODE_SESSION_ATTENDED=0`
   counts: it marks a background session). Which variables Antigravity sets is [unverified]; the
   prefixes are a guess that errs towards refusing. The check is on the environment of the
   `a2a-coord` process, and `docker compose exec` does not forward the host's environment unless it
   is asked to (`-e VAR`): this is friction, not proof (spec 8.3 says so).

The typed confirmation (`release <last 6 characters of the task id>`) is read from `/dev/tty`, not
from stdin, so a script that pipes an answer in cannot give one. There is no `--yes`, no batch form
and no option or variable that skips any of this: the functions here take no "skip" parameter.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from typing import Protocol

MARKER_PREFIXES = ("CLAUDE", "ANTIGRAVITY", "AGY_")
MARKER_EXACT = ("CI",)


class TtyRefused(Exception):
    """A TTY rule says no. The message names the rule, never a value from the environment."""


class Terminal(Protocol):
    def stdin_isatty(self) -> bool: ...

    def stdout_isatty(self) -> bool: ...

    def read_confirmation(self, prompt: str) -> str | None:
        """Show `prompt` on the controlling terminal and return the line typed there, or None if
        there is no controlling terminal to ask."""
        ...


class RealTerminal:
    def stdin_isatty(self) -> bool:
        return sys.stdin is not None and sys.stdin.isatty()

    def stdout_isatty(self) -> bool:
        return sys.stdout is not None and sys.stdout.isatty()

    def read_confirmation(self, prompt: str) -> str | None:
        try:
            fd = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY)
        except OSError:
            return None
        try:
            os.write(fd, prompt.encode("utf-8", errors="replace"))
            # Not "r+": a terminal is not seekable, which text mode in "r+" needs.
            with open(fd, encoding="utf-8", errors="replace", closefd=False) as tty:
                line = tty.readline()
        except OSError:
            return None
        finally:
            os.close(fd)
        return line.rstrip("\r\n") if line else None


def agent_markers(environ: Mapping[str, str]) -> list[str]:
    """Names (never values) of the agent-session variables that are set."""
    return sorted(
        name for name in environ if name.startswith(MARKER_PREFIXES) or name in MARKER_EXACT
    )


def require_real_terminal(terminal: Terminal, environ: Mapping[str, str], command: str) -> None:
    """Raise `TtyRefused` unless `command` may run here."""
    if not (terminal.stdin_isatty() and terminal.stdout_isatty()):
        raise TtyRefused(
            f"a2a-coord {command} needs a terminal on standard input and output; "
            "run it with docker compose exec -it, not -T and not in a pipe"
        )
    markers = agent_markers(environ)
    if markers:
        raise TtyRefused(
            f"a2a-coord {command} is refused while an agent-session variable is set ({', '.join(markers)}); "
            "run it from your own terminal"
        )


def confirm(terminal: Terminal, prompt: str, expected: str) -> bool:
    """Ask on `/dev/tty` and compare with `expected` exactly (surrounding spaces ignored).

    False for a wrong answer; `TtyRefused` when there is no controlling terminal to ask."""
    typed = terminal.read_confirmation(prompt)
    if typed is None:
        raise TtyRefused("no controlling terminal (/dev/tty) to read the confirmation from; nothing was done")
    return typed.strip() == expected
