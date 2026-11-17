"""Text sanitising for peer-originated strings (spec 4.1, decision D10).

Everything a peer wrote reaches a model through a tool result. Before it does, this module removes
what a terminal or a renderer would act on, and cuts it to a byte budget:

- terminal escape sequences, whole (CSI, OSC, the string-type DCS, PM, APC and SOS, the other
  ESC-introduced sequences, and the 8-bit C1 forms of CSI and OSC), not only the ESC byte, so a
  sequence leaves no printable remainder such as `[31m`;
- control characters: C0 except line feed and tab, DEL and C1. A carriage return is removed (a bare
  one overwrites a terminal line) and `\\r\\n` becomes `\\n`;
- bidirectional override and isolate characters (U+202A to U+202E, U+2066 to U+2069) [design]: they
  can make text display differently from what it says. Not a terminal control, but the same kind of
  spoofing, and nothing legitimate in a task body needs them.

Newline and tab stay: they are whitespace in ordinary text. Truncation is by UTF-8 bytes and never
cuts a character in half.
"""

from __future__ import annotations

import re
from typing import Any

# Escape sequences first, so the payload of a sequence goes with it. An unterminated string-type
# sequence (OSC, DCS and so on) ends at a newline or at the end of the text instead of swallowing
# the rest of the body.
_ESCAPE = re.compile(
    r"\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?"  # OSC, ended by BEL or ST
    r"|\x1b[P^_X][^\x1b\n]*(?:\x1b\\)?"  # DCS, PM, APC, SOS, ended by ST
    r"|\x1b\[[0-?]*[ -/]*[@-~]?"  # CSI: parameters, intermediates, final byte
    r"|\x1b[ -/]*[0-~]?"  # any other ESC sequence (nF, Fp, Fe, Fs) or a lone ESC
    r"|\x9b[0-?]*[ -/]*[@-~]?"  # 8-bit CSI
    r"|\x9d[^\x07\x9c\n]*(?:\x07|\x9c)?"  # 8-bit OSC
    r"|[\x90\x98\x9e\x9f][^\x9c\n]*\x9c?"  # 8-bit DCS, SOS, PM, APC
)
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]")


def strip_controls(text: str) -> str:
    """`text` without escape sequences, control characters and bidirectional overrides."""
    text = text.replace("\r\n", "\n")
    text = _ESCAPE.sub("", text)
    return _CONTROL.sub("", text)


def truncate_utf8(text: str, max_bytes: int) -> tuple[str, bool]:
    """`text` cut to at most `max_bytes` UTF-8 bytes on a character boundary, and whether it was cut."""
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text, False
    return raw[:max_bytes].decode("utf-8", errors="ignore"), True


def clean_text(text: str, max_bytes: int) -> tuple[str, bool]:
    """Strip, then truncate. The order matters: the budget counts what is delivered."""
    return truncate_utf8(strip_controls(text), max_bytes)


def clean_json(value: Any, *, depth: int = 0, max_depth: int = 16) -> Any:
    """A JSON value with every string and key stripped. Nesting deeper than `max_depth` becomes
    None, so a hostile document cannot be used to exhaust the stack."""
    if depth > max_depth:
        return None
    if isinstance(value, str):
        return strip_controls(value)
    if isinstance(value, dict):
        return {strip_controls(str(k)): clean_json(v, depth=depth + 1, max_depth=max_depth) for k, v in value.items()}
    if isinstance(value, list):
        return [clean_json(v, depth=depth + 1, max_depth=max_depth) for v in value]
    return value
