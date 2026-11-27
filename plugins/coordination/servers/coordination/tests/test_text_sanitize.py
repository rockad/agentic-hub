"""Unit and integration tests for `coordination.text_sanitize` and display-string callsites."""

from __future__ import annotations

import asyncio
import io
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import pytest
from a2a.types import a2a_pb2 as pb

from auth_helpers import FixedClock, make_config
from coordination.a2a.cards import CardBuilder, CardDefinition, CardRegistry, LiveSession
from coordination.admin.keyadmin import key_row
from coordination.admin.keystore import InMemoryKeyAdminStore
from coordination.admin.review import _summary
from coordination.admin.status import StatusAdmin
from coordination.auth import ApiKeyRecord
from coordination.cli import render
from coordination.mcp import frame as F
from coordination.store import schema
from coordination.store.task_store import IndexRow
from coordination.text_sanitize import sanitize_preview

ESC = "\x1b"


# -- pure sanitize_preview tests -------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "plain ascii message",
        "Hyvää päivää! Äiti syö jäätelöä Espoossa.",
        "Привет, мир! Проверка кириллицы ёжик.",
        "Mixed UTF-8: café naïve ✓ 漢字 — test",
    ],
)
def test_plain_utf8_preserved_intact(text: str) -> None:
    assert sanitize_preview(text) == text


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("evil_\u202egnp.exe", "evil_gnp.exe"),
        ("\u202aembedded\u202c \u202boverride\u202d", "embedded override"),
        ("a\u2066isolated\u2069b \u2067rtl\u2068fsi", "aisolatedb rtlfsi"),
        ("zero\u200bwidth\u200cjoin\u200dtext", "zerowidthjointext"),
        ("\ufeffbom\u200eltr\u200frlm", "bomltrrlm"),
        ("peer:\u202eacme\u200b/main\u2066~12345678\u2069", "peer:acme/main~12345678"),
    ],
)
def test_bidi_and_format_controls_stripped(raw: str, expected: str) -> None:
    assert sanitize_preview(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (f"{ESC}[31mred{ESC}[0m", "red"),
        (f"{ESC}[1;38;5;196mbold{ESC}[m", "bold"),
        (f"{ESC}[?25lhidden{ESC}[?25h", "hidden"),
        (f"{ESC}]0;window title\x07text", "text"),
        (f"{ESC}]8;;http://evil.example{ESC}\\link{ESC}]8;;{ESC}\\", "link"),
        (f"{ESC}Pq#0;2;0;0;0{ESC}\\after", "after"),
        (f"{ESC}_Gi=1;payload{ESC}\\after", "after"),
        ("\x9b31mred\x9b0m", "red"),
        ("trailing\x9b", "trailing"),
        ("\x9d0;title\x07body", "body"),
        ("a\x00b\x07c\x08d\x7fe\x85f", "abcdef"),
        (f"{ESC}]0;never ended\nsecond line", "second line"),
        (f"{ESC}]0;never ended\rsecond line", "second line"),
    ],
)
def test_ansi_and_c0_c1_controls_stripped(raw: str, expected: str) -> None:
    assert sanitize_preview(raw) == expected


def test_whitespace_normalization() -> None:
    raw = "  \tline one\r\n  line\ttwo\n\n\t  line   three \r  "
    assert sanitize_preview(raw) == "line one line two line three"
    assert sanitize_preview("   \n\t\r\x00\u200b   ") == ""
    assert sanitize_preview("") == ""


def test_length_capping_and_ellipsis() -> None:
    exact = "a" * 200
    assert sanitize_preview(exact) == exact
    assert len(sanitize_preview(exact)) == 200

    over = "b" * 250
    capped = sanitize_preview(over)
    assert len(capped) == 200
    assert capped == ("b" * 197) + "..."

    # Trailing space before truncation point is trimmed so we do not emit " ...".
    spaced = "hello world again"
    out = sanitize_preview(spaced, max_len=9)
    assert len(out) <= 9
    assert out == "hello..."

    assert sanitize_preview("abcdef", max_len=3) == "abc"
    assert sanitize_preview("abcdef", max_len=1) == "a"
    assert sanitize_preview("abcdef", max_len=0) == ""
    assert sanitize_preview("abcdef", max_len=-5) == ""


# -- integrated callsite tests ---------------------------------------------------------------


def test_admin_review_summary_sanitizes_display_fields_without_mutating_payload() -> None:
    raw_body = "Raw \x1b[31mA2A\x1b[0m payload\nwith\tnewlines\u202e!"
    task = pb.Task(id="0f1e2d3c-4b5a-4968-8776-655443abcdef", context_id="c1")
    task.status.state = pb.TaskState.TASK_STATE_INPUT_REQUIRED
    task.history.add(message_id="m1", role=pb.Role.ROLE_USER).parts.add(text=raw_body)
    task.metadata.update({"coord": {"origin": "remote", "from": "peer:acme", "createdAt": "2026-11-16T10:00:00Z"}})

    now = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    index = IndexRow(
        task_id=task.id,
        from_principal=f"peer:\u202e{ESC}[31macme\u200b",
        origin="remote",
        to_card=f"claude-code@box{ESC}[0m\n",
        to_handle=f"claude-code@box/one~aaaaaaa1\x07\u2066",
        addressing="handle",
        hold="quarantine",
        offer_count=0,
        last_offered_at=None,
        next_offer_at=None,
        expires_at=now + timedelta(hours=24),
        released_at=None,
    )

    summary = _summary(task, index)
    assert summary["peer"] == "peer:acme"
    assert summary["card"] == "claude-code@box"
    assert summary["to_handle"] == "claude-code@box/one~aaaaaaa1"
    # Raw stored task body must never be mutated.
    assert task.history[0].parts[0].text == raw_body


def test_key_row_sanitizes_display_fields() -> None:
    now = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    rec = ApiKeyRecord(
        key_id="0a1b2c3d",
        env="dev",
        name=f"owner\u202e{ESC}[31mname\u200b",
        scope="remote-peer",
        secret_hash="sha256:deadbeef",
        created_at=now,
        expires_at=now + timedelta(days=30),
        peer_id=f"peer-a\x00{ESC}[1m",
        cards_allowed=(f"claude-code@box\u200e{ESC}[0m",),
        tailnet_node=f"mac\tmini\u2066",
    )
    row = key_row(rec, now)
    assert row["owner"] == "peer-a"
    assert row["cards_allowed"] == ["claude-code@box"]
    assert row["tailnet_node"] == "mac mini"


def test_mcp_frame_sanitizes_origin_and_metadata_without_mutating_task() -> None:
    raw_body = "Keep\nline\tbreaks in body"
    task = pb.Task(id="t1", context_id="c1")
    task.status.state = pb.TaskState.TASK_STATE_SUBMITTED
    msg = task.history.add(message_id=f"m1{ESC}[31m\u200b", role=pb.Role.ROLE_USER)
    part = msg.parts.add(text=raw_body, filename=f"report_\u202egnp.exe{ESC}[0m")
    assert part.filename.startswith("report_")
    art = task.artifacts.add(artifact_id=f"a1\x07", name=f"artifact\t\nname\u2066{ESC}[32m\u2069")
    art.parts.add(text="ok")
    task.metadata.update({"coord": {"origin": "remote", "from": f"peer:\u202e{ESC}[31macme\u200b\n"}})

    framed = F.build_frame([F.task_to_dict(task, artifacts=True)])
    assert framed["origin"]["from"] == "peer:acme"
    assert framed["tasks"][0]["messages"][0]["message_id"] == "m1"
    assert framed["tasks"][0]["messages"][0]["parts"][0]["filename"] == "report_gnp.exe"
    assert framed["tasks"][0]["messages"][0]["parts"][0]["text"] == raw_body
    assert framed["tasks"][0]["artifacts"][0]["artifact_id"] == "a1"
    assert framed["tasks"][0]["artifacts"][0]["name"] == "artifact name"
    # Raw protobuf Task remains untouched.
    assert task.history[0].parts[0].text == raw_body
    assert "\u202e" in task.history[0].parts[0].filename


def test_cli_clean_block_strips_cf_format_controls() -> None:
    raw = f"line1\u200b\t\ufeffok\nline2\u061c\u200e{ESC}[31m"
    assert render.clean_block(raw) == "line1\tok\nline2"


def test_cli_render_strips_ansi_sequences_and_bidi_controls() -> None:
    out = io.StringIO()
    render.review_list(
        out,
        {
            "held": [
                {
                    "task_id": "t1",
                    "peer": f"peer:\u202e{ESC}[31macme{ESC}[0m\u200b",
                    "card": f"claude-code@box\x9b31m\n",
                    "received_at": "2026-11-16T10:00:00+00:00",
                    "size_bytes": 42,
                }
            ]
        },
    )
    rendered = out.getvalue()
    assert "peer:acme" in rendered
    assert "claude-code@box" in rendered
    assert "[31m" not in rendered
    assert "\x1b" not in rendered
    assert "\x9b" not in rendered
    assert "\u202e" not in rendered
    assert "\u200b" not in rendered


def test_status_admin_sanitizes_card_and_handle_display_strings(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Result:
        def __init__(self, *, one=None, all_rows=None, scalar=None) -> None:
            self._one = one
            self._all = all_rows or []
            self._scalar = scalar

        def one(self):
            return self._one

        def all(self):
            return self._all

        def scalar_one(self):
            return self._scalar

    class _Conn:
        def __init__(self, responses: list[_Result]) -> None:
            self._responses = iter(responses)

        async def execute(self, _stmt):
            return next(self._responses)

    class _Engine:
        def __init__(self, responses: list[_Result]) -> None:
            self._responses = responses

        @asynccontextmanager
        async def connect(self):
            yield _Conn(self._responses)

    async def fake_versions(_engine):
        return schema.Versions(sdk_revision="abc", coord_schema_version=4)

    monkeypatch.setattr(schema, "versions", fake_versions)

    now = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    clock = FixedClock(now)
    config = make_config()
    registry = CardRegistry({"claude-code@box": CardDefinition("claude-code@box")})
    keys = InMemoryKeyAdminStore()
    keys.records["k1"] = ApiKeyRecord(
        key_id=f"k1{ESC}[31m",
        env="dev",
        name="peer",
        scope=f"remote-peer\u200b",
        secret_hash="sha256:x",
        created_at=now,
        expires_at=now + timedelta(days=30),
        cards_allowed=(f"claude-code@ghost\u202e{ESC}[31m",),
    )

    status_responses = [
        _Result(one=(1, 0, 0, 0)),  # pending counts
        _Result(all_rows=[(f"claude-code@box{ESC}[31m\n", 1)]),  # pending by_card
        _Result(all_rows=[("t1", f"claude-code@box\u202e", 5, now)]),  # stale_rows
        _Result(scalar=1),  # stale_total
        _Result(all_rows=[(f"claude-code@box\u200b", 1, 1)]),  # session_rows
        _Result(scalar=0),  # ended
        _Result(all_rows=[(f"claude-code@box/one~aaaaaaa1\u2066{ESC}[0m", 2)]),  # wake_rows
    ]
    admin = StatusAdmin(config, clock, _Engine(status_responses), keys, registry)  # type: ignore[arg-type]
    status_out = asyncio.run(admin.status())
    assert status_out["sessions"]["by_card"] == [{"card": "claude-code@box", "registered": 1, "active": 1}]
    assert status_out["pending"]["by_card"] == [{"card": "claude-code@box", "submitted": 1}]
    assert status_out["budgets"]["used"] == [{"handle": "claude-code@box/one~aaaaaaa1", "wakes": 2, "remaining": 18}]
    assert status_out["stale_offers"]["tasks"][0]["card"] == "claude-code@box"

    check_responses = [
        _Result(all_rows=[("claude-code@box",), (f"extra@node\u202e{ESC}[31m",)]),  # cards in table
        _Result(all_rows=[]),  # live sessions
    ]
    check_admin = StatusAdmin(config, clock, _Engine(check_responses), keys, registry)  # type: ignore[arg-type]
    check_out = asyncio.run(check_admin.card_check())
    assert check_out["ok"] is False
    assert any("extra@node: in the cards table" in n for n in check_out["notes"])
    assert any("key k1 (remote-peer) names the undefined card claude-code@ghost" in p for p in check_out["problems"])
    assert "\x1b" not in repr(check_out) and "\u202e" not in repr(check_out) and "\u200b" not in repr(check_out)


def test_card_builder_extended_sanitizes_session_handles() -> None:
    builder = CardBuilder(make_config())
    definition = CardDefinition("claude-code@box")
    card = builder.extended(definition, [LiveSession(f"claude-code@box/one~aaaaaaa1\u202e{ESC}[31m", "active")])
    ext = card.capabilities.extensions[0]
    assert list(ext.params["sessions"]) == [{"handle": "claude-code@box/one~aaaaaaa1", "liveness": "active"}]

