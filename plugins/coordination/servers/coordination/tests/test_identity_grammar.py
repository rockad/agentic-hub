"""S1-ID without a database: the handle grammar, the name derivation, liveness and the end hooks."""

from __future__ import annotations

import asyncio
import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from conftest import PLUGIN_DIR

from coordination.identity import (
    ACTIVE,
    ENDED,
    LISTENING,
    REGISTERED,
    SessionEndHooks,
    build_handle,
    derive_name,
    liveness_state,
    sid8_of,
    valid_session_id,
)
from coordination.identity.handles import HANDLE_RE, name_part
from coordination.service.types import CARD_RE

SPEC = PLUGIN_DIR / "docs" / "specs" / "server-api.md"
NOW = datetime(2026, 11, 18, 12, 0, tzinfo=UTC)
CARD = "claude-code@box"


def test_handle_regex_is_the_one_in_the_spec():
    """The session-part regex of spec 5.1 is quoted in `server-api.md`; ours must be it."""
    if not SPEC.is_file():
        pytest.skip("the spec file is not part of this build context")
    text = SPEC.read_text()
    quoted = re.search(r"Session part regex: `(\^\[a-z0-9\]\[a-z0-9\._-\]\{0,38\}~\[0-9a-f\]\{8\}\$)`", text)
    assert quoted, "spec 5.1 no longer quotes the session part regex"
    session_part = quoted.group(1)
    assert HANDLE_RE.pattern.endswith(session_part[1:])  # the full regex is card, `/`, then this
    card_quoted = re.search(r"regex `(\^\[a-z0-9\]\[a-z0-9-\]\{0,31\}@\[a-z0-9\]\[a-z0-9-\]\{0,31\}\$)`", text)
    assert card_quoted and card_quoted.group(1) == CARD_RE.pattern


@pytest.mark.parametrize(
    "handle",
    [
        f"{CARD}/agents-bridge-52~3f2a9c1d",
        f"{CARD}/c6-same~3f2a9c1d",
        f"{CARD}/3f2a9c1d~3f2a9c1d",  # the unnamed form built here (reading B)
        f"{CARD}/{'x' * 39}~3f2a9c1d",  # name at its limit: whole session part is 48 characters
        f"{CARD}/a.b_c-d~00000000",
    ],
)
def test_valid_handles(handle):
    assert HANDLE_RE.match(handle)


@pytest.mark.parametrize(
    "handle",
    [
        f"{CARD}/agents-bridge-52",  # no ~sid8 suffix
        f"{CARD}/agents-bridge-52#3f2a9c1d",  # the old separator
        f"{CARD}/Agents~3f2a9c1d",  # uppercase
        f"{CARD}/agents~3F2A9C1D",  # uppercase hex
        f"{CARD}/{'x' * 40}~3f2a9c1d",  # name over 39
        f"{CARD}/agents~3f2a9c1",  # 7 hex
        f"{CARD}/agents~3f2a9c1de",  # 9 hex
        f"{CARD}/-agents~3f2a9c1d",  # name starts with a symbol
        f"{CARD}/a~b~3f2a9c1d",  # the separator is outside the name charset
        f"{CARD}/~3f2a9c1d",  # empty name
        "claude-code@box~3f2a9c1d",  # no name part at all
        f"{CARD}/agents~3f2a9c1d ",
    ],
)
def test_invalid_handles(handle):
    assert not HANDLE_RE.match(handle)


def test_the_whole_session_part_is_at_most_48_characters():
    handle = build_handle(CARD, "y" * 100, str(uuid.uuid4()))
    assert len(handle.split("/", 1)[1]) == 48
    assert HANDLE_RE.match(handle)


@pytest.mark.parametrize(
    ("hint", "name"),
    [
        ("agents-bridge-52", "agents-bridge-52"),
        ("My Session!! v2", "mysessionv2"),
        ("--._lead", "lead"),  # a first character outside [a-z0-9] is stripped [design]
        ("UPPER", "upper"),
        ("x" * 100, "x" * 39),
        ("!!!", ""),
        ("", ""),
        ("é-ü", ""),  # non-ASCII drops; what is left starts with a symbol and is stripped
    ],
)
def test_derive_name(hint, name):
    assert derive_name(hint) == name


def test_build_handle_is_always_suffixed_and_deterministic():
    hsid = "3f2a9c1d-1111-4222-8333-444455556666"
    assert build_handle(CARD, "c6-same", hsid) == f"{CARD}/c6-same~3f2a9c1d"
    assert build_handle(CARD, "", hsid) == f"{CARD}/3f2a9c1d~3f2a9c1d"  # unnamed: reading B [design]
    # Two sessions with an equal name get different suffixes.
    other = "9b4e7a02-1111-4222-8333-444455556666"
    assert build_handle(CARD, "c6-same", hsid) != build_handle(CARD, "c6-same", other)


def test_sid8_of_hex_and_non_hex_ids():
    assert sid8_of("3F2A9C1D-1111-4222-8333-444455556666") == "3f2a9c1d"
    assert re.fullmatch(r"[0-9a-f]{8}", sid8_of("not hex at all, but a valid conversation id"))
    assert sid8_of("conv-1") == sid8_of("conv-1")


def test_name_part():
    assert name_part(f"{CARD}/agents-bridge-52~3f2a9c1d") == "agents-bridge-52"
    assert name_part("nonsense") is None


@pytest.mark.parametrize("value", ["", " ", "x" * 129, "a b", "../x", "-lead", 7, None, ["a"], b"x"])
def test_valid_session_id_refuses_what_cannot_be_stored(value):
    assert valid_session_id(value) is None


def test_valid_session_id_accepts_uuids_and_128_characters():
    assert valid_session_id("3f2a9c1d-1111-4222-8333-444455556666")
    assert valid_session_id("a" * 128) and not valid_session_id("a" * 129)


# liveness ------------------------------------------------------------------------------------------


def test_liveness_states():
    seen = NOW - timedelta(minutes=14, seconds=59)
    old = NOW - timedelta(minutes=15, seconds=1)
    assert liveness_state(ended=False, last_seen_at=seen, now=NOW, listening=False) == ACTIVE
    assert liveness_state(ended=False, last_seen_at=old, now=NOW, listening=False) == REGISTERED
    assert liveness_state(ended=False, last_seen_at=old, now=NOW, listening=True) == LISTENING
    assert liveness_state(ended=False, last_seen_at=seen, now=NOW, listening=True) == LISTENING  # listening wins
    # Ended wins over everything, a parked listener included.
    assert liveness_state(ended=True, last_seen_at=seen, now=NOW, listening=True) == ENDED


# end hooks -----------------------------------------------------------------------------------------


def test_end_hooks_run_sync_and_async_hooks_and_survive_a_failure():
    seen: list[str] = []

    async def slow(handle: str) -> int:
        seen.append(f"async:{handle}")
        return 2

    def broken(handle: str) -> int:
        raise RuntimeError("secret detail that must not be reported")

    def quiet(handle: str) -> None:
        seen.append(f"sync:{handle}")

    hooks = SessionEndHooks()
    hooks.register("slow", slow)
    hooks.register("broken", broken)
    hooks.register("quiet", quiet)
    assert hooks.names() == ["slow", "broken", "quiet"]
    report = asyncio.run(hooks.fire("h"))
    assert seen == ["async:h", "sync:h"]
    assert report.closed == {"slow": 2, "quiet": 0} and report.failed == ["broken"]
    assert report.total_closed == 2


def test_registering_a_hook_twice_replaces_it():
    hooks = SessionEndHooks()
    hooks.register("wake", lambda h: 1)
    hooks.register("wake", lambda h: 5)
    assert asyncio.run(hooks.fire("h")).closed == {"wake": 5}
