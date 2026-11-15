"""Scrubbing of credentials from text, and the `Credential` wrapper (S1-OBS).

Two layers, both in this module so the rules live in one place:

- `redact(text)` removes anything that looks like a service API key (`a2ak_<env>_<keyid>_<secret>`,
  spec 8.2), a `Bearer` or `Basic` value, or the value after an `Authorization` header name, in
  any of the shapes it takes in a log line, a repr of a header dict or a repr of ASGI header
  tuples. It is the last line of defence for log output; it is not how the server hides the
  credential from its own code (that is `Credential`, below).
- `Credential` holds the `Authorization` header value after the redaction middleware has taken
  it out of the ASGI scope. Its `repr`, `str` and `format` are `[REDACTED]`, it refuses to be
  pickled or copied, and the raw value is only reachable through `reveal()`.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

REDACTED = "[REDACTED]"

# `a2ak_` then the rest of the key; `_` and `-` are part of the class because they are part of
# the key (separators and base64url-like secret characters).
_API_KEY = re.compile(r"a2ak_[A-Za-z0-9_\-]+")
# `Authorization: Bearer x`, `'authorization': 'Bearer x'`, `(b'authorization', b'Bearer x')`,
# `authorization=x`. The value after the name is replaced as a whole.
_AUTH_HEADER = re.compile(
    r"""(?ix)
    (authorization["']?\s*[:=,]\s*(?:b(?=["']))?["']?)  # name, separator, bytes-repr prefix
    (?:(?:bearer|basic)\s+)?                  # optional scheme, swallowed with the value
    [^\s"',;})]+                              # the value
    """
)
_SCHEME_VALUE = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]+")


def redact(text: str, secrets: Iterable[str] = ()) -> str:
    """`text` with credentials replaced by `[REDACTED]`.

    `secrets` are exact values to remove as well (for example the configured key pepper). Values
    shorter than 8 characters are ignored: replacing a short string everywhere would damage the
    log more than it protects it.
    """
    for secret in secrets:
        if secret and len(secret) >= 8:
            text = text.replace(secret, REDACTED)
    text = _AUTH_HEADER.sub(lambda m: m.group(1) + REDACTED, text)
    text = _SCHEME_VALUE.sub(lambda m: f"{m.group(1)} {REDACTED}", text)
    return _API_KEY.sub(REDACTED, text)


def contains_secret(text: str) -> bool:
    """True if `redact` would change `text`. Used by the audit writer to refuse such a row."""
    return redact(text) != text


class Credential:
    """The `Authorization` header value of one request, kept out of every repr and log.

    `reveal()` is the only way to the raw value. `bearer()` returns the token of a
    `Bearer <token>` value, or None for any other shape.
    """

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value

    def bearer(self) -> str | None:
        scheme, sep, token = self._value.partition(" ")
        if sep and scheme.lower() == "bearer" and token and " " not in token:
            return token
        return None

    def __repr__(self) -> str:
        return f"Credential({REDACTED})"

    def __str__(self) -> str:
        return REDACTED

    def __format__(self, spec: str) -> str:
        return REDACTED

    def __reduce__(self):  # pickle, copy.copy and copy.deepcopy all go through this
        raise TypeError("Credential cannot be pickled or copied")
