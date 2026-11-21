"""Migration 4: `wakes.set_hash` (S1-WAKE anti-loop, user decision 2026-11-20).

The DDL below is a frozen copy: do not edit it after release, add a new step instead.

The anti-loop rule (spec 7.4) used to keep its streak in memory. It is now derived from the
`wakes` rows, so a restart does not forget it. Each row names the pending set it woke for: the
first 16 hex characters of the SHA-256 of the sorted task ids (ids only, never content). The
column is nullable because rows written before this step have no hash; they never match a set,
so they never count toward a stop.

No new index: the check reads a handle's newest few rows, which `ix_wakes_handle_at`
(`handle`, `at`) already serves.
"""

from __future__ import annotations

import sqlalchemy as sa

VERSION = 4
NAME = "wakes set_hash"


def upgrade(conn: sa.Connection) -> None:
    conn.execute(sa.text("ALTER TABLE wakes ADD COLUMN set_hash VARCHAR(16)"))
