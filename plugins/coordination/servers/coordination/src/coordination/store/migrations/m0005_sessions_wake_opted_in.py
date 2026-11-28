"""Migration 5: `sessions.wake_opted_in` (AW1, decision Z23).

The DDL below is a frozen copy: do not edit it after release, add a new step instead.

An Antigravity session that arms the opt-in idle-wake listener (`bin/a2a-agy-listen`) is marked
here on its first successful `POST /wake/listen` park, so the `PreInvocation` hook can tell a
session that was listening and no longer is from a session that never opted in. The column is a
nullable timestamp: NULL is "never opted in" (every row written before this step), a value is the
time of the first park, and `a2a_wake_off` sets it back to NULL.

No index: it is read only with the session row, by handle.
"""

from __future__ import annotations

import sqlalchemy as sa

VERSION = 5
NAME = "sessions wake_opted_in"


def upgrade(conn: sa.Connection) -> None:
    conn.execute(sa.text("ALTER TABLE sessions ADD COLUMN wake_opted_in TIMESTAMP WITH TIME ZONE"))
