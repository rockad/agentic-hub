"""Pure text sanitization helpers for peer-originated previews and display strings.

Peer handles, card names, status summaries, and admin review metadata can carry terminal escape
sequences, C0/C1 control bytes, or Unicode bidirectional/format controls when rendered in a CLI,
dashboard, or log-adjacent summary. `sanitize_preview` produces a single-line, length-bounded
string safe for human-facing display without modifying underlying stored A2A task payloads.
"""

from __future__ import annotations

import re
import unicodedata

DEFAULT_PREVIEW_MAX_LEN = 200

# Strip full terminal escape sequences before stripping individual control characters so CSI/OSC
# parameters and payloads (for example `[31m` or `0;title`) are not left behind as visible text.
_ANSI_ESCAPE_RE = re.compile(
    r"\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?"  # OSC, terminated by BEL or ST
    r"|\x1b[P^_X][^\x1b\n]*(?:\x1b\\)?"  # DCS, PM, APC, SOS, terminated by ST
    r"|\x1b\[[0-?]*[ -/]*[@-~]?"  # CSI: parameters, intermediates, final byte
    r"|\x1b[ -/]*[0-~]?"  # other ESC sequences (nF, Fp, Fe, Fs) or lone ESC
    r"|\x9b[0-?]*[ -/]*[@-~]?"  # 8-bit CSI
    r"|\x9d[^\x07\x9c\n]*(?:\x07|\x9c)?"  # 8-bit OSC
    r"|[\x90\x98\x9e\x9f][^\x9c\n]*\x9c?"  # 8-bit DCS, SOS, PM, APC
)


def sanitize_preview(text: str, max_len: int = DEFAULT_PREVIEW_MAX_LEN) -> str:
    """Return a single-line, display-safe preview of `text` capped at `max_len` characters.

    - Strips ANSI CSI/OSC/DCS/ESC and 8-bit C1 escape sequences.
    - Replaces ``\\r``, ``\\n``, and ``\\t`` with single spaces.
    - Strips all other C0/C1 control characters (Unicode category ``Cc``) and Unicode
      format/bidirectional control characters (Unicode category ``Cf``, including
      U+202A..U+202E, U+2066..U+2069, U+200B, U+200E, U+200F, U+FEFF).
    - Collapses repeated whitespace and trims leading/trailing whitespace.
    - Caps output length to `max_len`, appending ``"..."`` when truncated so total length
      is at most `max_len`.
    """
    if max_len <= 0 or not text:
        return ""

    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    stripped_escapes = _ANSI_ESCAPE_RE.sub("", normalized)

    cleaned_chars: list[str] = []
    for ch in stripped_escapes:
        if ch in ("\r", "\n", "\t"):
            cleaned_chars.append(" ")
            continue
        if unicodedata.category(ch) in ("Cc", "Cf"):
            continue
        cleaned_chars.append(ch)

    collapsed = " ".join("".join(cleaned_chars).split())
    if len(collapsed) <= max_len:
        return collapsed
    if max_len <= 3:
        return collapsed[:max_len]
    return f"{collapsed[: max_len - 3].rstrip()}..."
