"""Migration 3: `session_aliases` and `session_conversations` (S1-ID).

The DDL below is a frozen copy: do not edit it after release, add a new step instead.

- `session_aliases`: a name a later `SessionStart` supplied for a session that already had a handle
  (spec 5.4.1, D30). The handle never changes; the alias is a second name for it.
- `session_conversations`: one row per agy sub-invocation conversation (a subagent or a background
  invocation) that was grouped under its root's handle, with the `root_conversation_id` and
  `parent_conversation_id` the client reported, for provenance (spec 5.4.1). The values are
  client-supplied assertions of a `local-harness` key holder; they are stored, never trusted for
  anything but this record.

Neither table holds a message body, a path or a working directory.
"""

from __future__ import annotations

import sqlalchemy as sa

VERSION = 3
NAME = "session aliases and conversation links"


def upgrade(conn: sa.Connection) -> None:
    meta = sa.MetaData()
    aliases = sa.Table(
        "session_aliases",
        meta,
        sa.Column("handle", sa.String(128), nullable=False),
        sa.Column("alias", sa.String(48), nullable=False),
        sa.Column("card_id", sa.String(80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("handle", "alias", name="pk_session_aliases"),
    )
    sa.Index("ix_session_aliases_card_alias", aliases.c.card_id, aliases.c.alias)
    links = sa.Table(
        "session_conversations",
        meta,
        sa.Column("card_id", sa.String(80), nullable=False),
        sa.Column("conversation_id", sa.String(128), nullable=False),
        sa.Column("handle", sa.String(128), nullable=False),
        sa.Column("root_conversation_id", sa.String(128), nullable=True),
        sa.Column("parent_conversation_id", sa.String(128), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("card_id", "conversation_id", name="pk_session_conversations"),
    )
    sa.Index("ix_session_conversations_handle", links.c.handle)
    meta.create_all(conn, checkfirst=False)
