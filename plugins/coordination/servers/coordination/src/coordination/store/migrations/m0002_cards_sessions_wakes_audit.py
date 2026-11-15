"""Migration 2: `cards`, `sessions`, `wakes` and `audit`.

The DDL below is a frozen copy: do not edit it after release, add a new step instead.
`status_runs` and `status_events` are not here: they belong to LT-SRV, after S1.
"""

from __future__ import annotations

import sqlalchemy as sa

VERSION = 2
NAME = "cards, sessions, wakes, audit"


def upgrade(conn: sa.Connection) -> None:
    meta = sa.MetaData()
    sa.Table(
        "cards",
        meta,
        sa.Column("card_id", sa.String(80), primary_key=True),
        sa.Column("harness", sa.String(32), nullable=False),
        sa.Column("machine", sa.String(32), nullable=False),
        sa.Column("card_json", sa.JSON, nullable=False),
    )
    sa.Table(
        "sessions",
        meta,
        sa.Column("handle", sa.String(128), primary_key=True),
        sa.Column("card_id", sa.String(80), nullable=False),
        sa.Column("harness_session_id", sa.String(128), nullable=False),
        sa.Column("registered_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("card_id", "harness_session_id", name="uq_sessions_card_hsid"),
    )
    wakes = sa.Table(
        "wakes",
        meta,
        sa.Column("wake_id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("handle", sa.String(128), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("pending_n", sa.Integer, nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
    )
    sa.Index("ix_wakes_handle_at", wakes.c.handle, wakes.c.at)
    audit = sa.Table(
        "audit",
        meta,
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("actor", sa.String(255), nullable=False),
        sa.Column("event", sa.String(64), nullable=False),
        sa.Column("subject", sa.String(255), nullable=True),
        sa.Column("detail_json", sa.JSON, nullable=True),
    )
    sa.Index("ix_audit_at", audit.c.at)
    sa.Index("ix_audit_event_at", audit.c.event, audit.c.at)
    meta.create_all(conn, checkfirst=False)
