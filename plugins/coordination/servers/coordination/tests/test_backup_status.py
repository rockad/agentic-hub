from datetime import UTC, datetime, timedelta, timezone

import pytest

from coordination.backup_status import STALE_AFTER_H, dump_age_h, is_stale, read_last_ok

NOW = datetime(2026, 11, 12, 14, 0, 0, tzinfo=UTC)


def last_ok(tmp_path, text):
    p = tmp_path / "last_ok"
    p.write_text(text)
    return p


def test_none_before_the_first_dump(tmp_path):
    assert dump_age_h(tmp_path / "last_ok", NOW) is None


def test_none_when_the_path_is_a_directory(tmp_path):
    # what Docker makes of a single-file bind mount whose source does not exist
    (tmp_path / "last_ok").mkdir()
    assert dump_age_h(tmp_path / "last_ok", NOW) is None


@pytest.mark.parametrize("text", ["", "\n", "  \n\n", "not a time\n", "2026-13-45T99:00:00Z\n", "yesterday"])
def test_none_when_empty_or_unparsable(tmp_path, text):
    assert dump_age_h(last_ok(tmp_path, text), NOW) is None


def test_none_when_not_utf8(tmp_path):
    p = tmp_path / "last_ok"
    p.write_bytes(b"\xff\xfe\x00junk")
    assert dump_age_h(p, NOW) is None


def test_none_without_a_utc_offset(tmp_path):
    assert dump_age_h(last_ok(tmp_path, "2026-11-12T02:00:00\n"), NOW) is None


def test_age_in_hours_two_decimals(tmp_path):
    p = last_ok(tmp_path, "2026-11-12T02:00:00Z\n")
    assert dump_age_h(p, NOW) == 12.0
    assert dump_age_h(p, NOW + timedelta(minutes=10)) == 12.17  # 12 h 10 min = 12.1666...
    assert dump_age_h(p, NOW + timedelta(seconds=1)) == 12.0
    assert isinstance(dump_age_h(p, NOW), float)


def test_offset_timestamps_are_converted(tmp_path):
    p = last_ok(tmp_path, "2026-11-12T04:00:00+02:00\n")  # = 02:00Z
    assert dump_age_h(p, NOW) == 12.0
    assert read_last_ok(p) == datetime(2026, 11, 12, 2, 0, tzinfo=UTC)
    assert read_last_ok(p).utcoffset() == timedelta(0)
    assert dump_age_h(p, NOW.astimezone(timezone(timedelta(hours=5)))) == 12.0


def test_first_line_only_and_no_trailing_newline_needed(tmp_path):
    assert dump_age_h(last_ok(tmp_path, "2026-11-12T02:00:00Z"), NOW) == 12.0
    assert dump_age_h(last_ok(tmp_path, "2026-11-12T02:00:00Z\nextra\n"), NOW) == 12.0


def test_future_timestamp_is_age_zero(tmp_path):
    assert dump_age_h(last_ok(tmp_path, "2026-11-13T02:00:00Z\n"), NOW) == 0.0


def test_now_must_be_aware(tmp_path):
    with pytest.raises(ValueError):
        dump_age_h(last_ok(tmp_path, "2026-11-12T02:00:00Z\n"), datetime(2026, 11, 12, 14, 0))


def test_stale_boundary_is_strictly_over_36_hours():
    assert STALE_AFTER_H == 36.0
    assert is_stale(36.0) is False
    assert is_stale(36.01) is True
    assert is_stale(0.0) is False
    assert is_stale(1000.0) is True


def test_unknown_is_not_stale(tmp_path):
    assert is_stale(None) is False
    assert is_stale(dump_age_h(tmp_path / "missing", NOW)) is False


def test_end_to_end_stale_after_36h(tmp_path):
    p = last_ok(tmp_path, "2026-11-10T22:00:00Z\n")  # 40 h before NOW
    age = dump_age_h(p, NOW)
    assert age == 40.0 and is_stale(age)
    p = last_ok(tmp_path, "2026-11-11T02:00:00Z\n")  # 36 h exactly
    assert dump_age_h(p, NOW) == 36.0 and not is_stale(dump_age_h(p, NOW))
