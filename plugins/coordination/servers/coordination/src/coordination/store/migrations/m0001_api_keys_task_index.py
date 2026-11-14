"""Migration 1: `api_keys` and `task_index`.

These two come first because S1-AUTH (API keys) and S1-STATE (routing and visibility) depend on
them. The DDL below is a frozen copy: do not edit it after release, add a new step instead.
"""

from __future__ import annotations

import sqlalchemy as sa

VERSION = 1
NAME = "api_keys, task_index"


def upgrade(conn: sa.Connection) -> None:
    meta = sa.MetaData()
    api_keys = sa.Table(
        "api_keys",
        meta,
        sa.Column("key_id", sa.String(16), primary_key=True),
        sa.Column("env", sa.String(8), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("scope", sa.String(32), nullable=False),
        sa.Column("card_id", sa.String(80), nullable=True),
        sa.Column("peer_id", sa.String(128), nullable=True),
        sa.Column("cards_allowed", sa.JSON, nullable=True),
        sa.Column("tailnet_node", sa.String(255), nullable=True),
        sa.Column("tailnet_login", sa.String(255), nullable=True),
        sa.Column("secret_hash", sa.String(128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    sa.Index("ix_api_keys_card_id", api_keys.c.card_id)

    task_index = sa.Table(
        "task_index",
        meta,
        sa.Column("task_id", sa.String(36), primary_key=True),
        sa.Column("from_principal", sa.String(255), nullable=False),
        sa.Column("origin", sa.String(16), nullable=False),
        sa.Column("to_card", sa.String(80), nullable=True),
        sa.Column("to_handle", sa.String(128), nullable=True),
        sa.Column("addressing", sa.String(16), nullable=True),
        sa.Column("hold", sa.String(32), nullable=True),
        sa.Column("offer_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_offered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_offer_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
    )
    sa.Index("ix_task_index_to_handle", task_index.c.to_handle)
    sa.Index("ix_task_index_from_principal", task_index.c.from_principal)
    sa.Index("ix_task_index_to_card", task_index.c.to_card)

    # checkfirst=False: a table that already exists without a version record is a corrupt
    # state, and it should fail loudly rather than be adopted silently.
    meta.create_all(conn, checkfirst=False)
