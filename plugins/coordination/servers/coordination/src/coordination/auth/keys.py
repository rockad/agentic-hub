"""API key format, hashing and verification (S1-AUTH; spec 8.2, D24).

A key is `a2ak_<env>_<keyid>_<secret>`:

- `<env>` is `dev` or `live` and must equal `A2A_ENV`, so a dev key never works on production;
- `<keyid>` is 8 hex characters, stored in clear and indexed (`api_keys.key_id`);
- `<secret>` is 43 characters of base64url, 256 bits from `secrets.token_bytes`.

Only `secret_hash` is stored. It is SHA-256 of the secret, or HMAC-SHA-256 keyed with
`A2A_KEY_PEPPER` when one is set. A fast hash is adequate because the secret is 256 bits of
randomness, not a password (spec 8.2).

[design] The stored value names its scheme, `sha256:<hex>` or `hmac-sha256:<hex>`, so a key
issued before the pepper was set (or after it was removed) is verified with the scheme it was
issued under. A key stored as `hmac-sha256` cannot be verified without the pepper: it is
refused, never accepted on a weaker check.

Verification (`verify_key`) looks the key up by id and compares hashes with
`hmac.compare_digest`. Every attempt, whether the id exists or not, whether the token is well
formed or not, hashes the presented secret and runs exactly one comparison, so timing does not
reveal valid key ids. The reason for a refusal is internal (`Verdict`); the HTTP answer is the
same `401` for every one of them.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum

from coordination.auth.records import ApiKeyRecord

KEY_PREFIX = "a2ak"
KEY_ID_LEN = 8
SECRET_LEN = 43  # base64url of 32 bytes without padding

_KEY_RE = re.compile(
    rf"{KEY_PREFIX}_(?P<env>[a-z]{{1,8}})_(?P<key_id>[0-9a-f]{{{KEY_ID_LEN}}})_(?P<secret>[A-Za-z0-9_-]{{{SECRET_LEN}}})"
)

SHA256 = "sha256"
HMAC_SHA256 = "hmac-sha256"


@dataclass(frozen=True)
class ParsedKey:
    """A well-formed key split into its parts. `secret` stays out of every repr."""

    env: str
    key_id: str
    secret: str = field(repr=False)


def parse_key(token: str) -> ParsedKey | None:
    """Split `token`, or None if it is not shaped like an API key. Never raises."""
    match = _KEY_RE.fullmatch(token)  # fullmatch: `$` would let a trailing newline through
    if match is None:
        return None
    return ParsedKey(match["env"], match["key_id"], match["secret"])


def hash_secret(secret: str, pepper: str | None, *, scheme: str | None = None) -> str:
    """The value stored in `api_keys.secret_hash`.

    `scheme` defaults to HMAC-SHA-256 when a pepper is set and SHA-256 otherwise. Naming it is
    for verification, which must use the scheme the key was issued under.
    """
    chosen = scheme or (HMAC_SHA256 if pepper else SHA256)
    data = secret.encode("ascii", "replace")
    if chosen == SHA256:
        return f"{SHA256}:{hashlib.sha256(data).hexdigest()}"
    if chosen == HMAC_SHA256:
        if not pepper:
            raise ValueError("HMAC-SHA-256 needs A2A_KEY_PEPPER")
        return f"{HMAC_SHA256}:{hmac.new(pepper.encode(), data, hashlib.sha256).hexdigest()}"
    raise ValueError(f"unknown hash scheme {chosen!r}")


def _scheme_of(stored: str) -> str | None:
    scheme, sep, _ = stored.partition(":")
    return scheme if sep and scheme in (SHA256, HMAC_SHA256) else None


@dataclass(frozen=True)
class GeneratedKey:
    """A new key. `token` is shown once, to a terminal, and never stored."""

    token: str = field(repr=False)
    key_id: str
    secret_hash: str = field(repr=False)


def generate_key(env: str, pepper: str | None = None) -> GeneratedKey:
    """Make a key for `env`. The caller stores `key_id` and `secret_hash` and shows `token`."""
    if env not in ("dev", "live"):
        raise ValueError(f"env must be dev or live, got {env!r}")
    key_id = secrets.token_hex(KEY_ID_LEN // 2)
    secret = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")
    assert len(secret) == SECRET_LEN
    return GeneratedKey(
        token=f"{KEY_PREFIX}_{env}_{key_id}_{secret}",
        key_id=key_id,
        secret_hash=hash_secret(secret, pepper),
    )


class Verdict(StrEnum):
    """Why a key was or was not accepted. Internal: the client always gets the same 401."""

    OK = "ok"
    MALFORMED = "malformed"
    WRONG_ENV = "wrong_env"
    UNKNOWN = "unknown"
    BAD_SECRET = "bad_secret"
    EXPIRED = "expired"
    REVOKED = "revoked"


# A fixed throwaway hash per process: the comparison target when the key id does not exist.
_DUMMY_SECRET = secrets.token_urlsafe(32)


def _dummy_hash(pepper: str | None) -> str:
    return hash_secret(_DUMMY_SECRET, pepper)


def verify_key(
    token: str | None,
    record: ApiKeyRecord | None,
    *,
    env: str,
    pepper: str | None,
    now: datetime,
) -> Verdict:
    """Decide whether `token` is the key stored in `record`.

    `record` is what the caller found by `parse_key(token).key_id` (None when there is none, or
    when the token did not parse). One hash and one `compare_digest` run on every path.
    """
    parsed = parse_key(token) if token is not None else None
    secret = parsed.secret if parsed is not None else _DUMMY_SECRET
    stored = record.secret_hash if record is not None else _dummy_hash(pepper)
    scheme = _scheme_of(stored)
    try:
        candidate = hash_secret(secret, pepper, scheme=scheme or (HMAC_SHA256 if pepper else SHA256))
    except ValueError:  # stored as hmac-sha256 but no pepper is configured
        candidate = hash_secret(_DUMMY_SECRET, None)
        scheme = None
    equal = hmac.compare_digest(candidate.encode(), stored.encode())

    if parsed is None:
        return Verdict.MALFORMED
    if parsed.env != env:
        return Verdict.WRONG_ENV
    if record is None:
        return Verdict.UNKNOWN
    if scheme is None or not equal or record.key_id != parsed.key_id:
        return Verdict.BAD_SECRET
    if record.env != env:
        return Verdict.WRONG_ENV
    if record.revoked_at is not None:
        return Verdict.REVOKED
    if record.expires_at <= now:
        return Verdict.EXPIRED
    return Verdict.OK
