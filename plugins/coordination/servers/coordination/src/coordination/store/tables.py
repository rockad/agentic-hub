"""Our tables, as SQLAlchemy Core objects (spec 1.3).

This is the schema at the head of our migration stream (`coordination.store.migrations`). The
migrations carry their own frozen copies of the DDL, so editing a table here never rewrites
history; `tests/test_store_migrations.py` fails if the two disagree at head.

Rules (spec 1.2, S1-STORE):
- SQLAlchemy Core only. No ORM models, no dialect-specific column types or SQL.
- Task content (messages, artifacts, history) lives only in the SDK's `tasks` table; nothing
  here stores a message body.
- Timestamps are timezone-aware (`DateTime(timezone=True)`), always UTC.

`task_index` has no foreign key to the SDK's `tasks` table: the two live in two migration
streams, and `CoordTaskStore.create` writes both rows in one transaction. `check_integrity`
reports an index row without a task and the reverse.
"""

from __future__ import annotations

import sqlalchemy as sa

metadata = sa.MetaData()

#: One row, `id = 1`. Written by the migration runner only.
coord_schema_version = sa.Table(
    "coord_schema_version",
    metadata,
    sa.Column("id", sa.Integer, primary_key=True, autoincrement=False),
    sa.Column("version", sa.Integer, nullable=False),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("id = 1", name="ck_coord_schema_version_single_row"),
)

#: Service-issued API keys, hashed (spec 8.2, D24). `key_id` is the `<keyid>` of
#: `a2ak_<env>_<keyid>_<secret>`: 8 hex characters, stored in clear. The secret is never stored,
#: only `secret_hash` (SHA-256 or HMAC-SHA-256 of it).
api_keys = sa.Table(
    "api_keys",
    metadata,
    sa.Column("key_id", sa.String(16), primary_key=True),
    sa.Column("env", sa.String(8), nullable=False),
    sa.Column("name", sa.String(128), nullable=False),
    sa.Column("scope", sa.String(32), nullable=False),
    sa.Column("card_id", sa.String(80), nullable=True),  # owner card (local-harness)
    sa.Column("peer_id", sa.String(128), nullable=True),  # remote-peer
    sa.Column("cards_allowed", sa.JSON, nullable=True),  # remote-peer allowlist entry (D18)
    sa.Column("tailnet_node", sa.String(255), nullable=True),  # D17, D23
    sa.Column("tailnet_login", sa.String(255), nullable=True),
    sa.Column("secret_hash", sa.String(128), nullable=False),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
)
sa.Index("ix_api_keys_card_id", api_keys.c.card_id)

#: Routing and visibility per task (spec 1.3, 3.3.3, 6.3). One row per task, written in the same
#: transaction as the task and its version row. Quarantine lives in `hold` (plus `coord.hold` in
#: the task metadata). `addressing` is `handle` or `card` [design: the values are not fixed by the
#: spec; the column is free text until S1-STATE settles them].
task_index = sa.Table(
    "task_index",
    metadata,
    sa.Column("task_id", sa.String(36), primary_key=True),
    sa.Column("from_principal", sa.String(255), nullable=False),
    sa.Column("origin", sa.String(16), nullable=False),  # local | remote (| import: no row)
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

#: Card registry, loaded from the cards file at start (spec 1.3, `config/cards.yaml`).
cards = sa.Table(
    "cards",
    metadata,
    sa.Column("card_id", sa.String(80), primary_key=True),
    sa.Column("harness", sa.String(32), nullable=False),
    sa.Column("machine", sa.String(32), nullable=False),
    sa.Column("card_json", sa.JSON, nullable=False),
)

#: Registered sessions (spec 3.5, 5.1). `handle` is `<card-id>/<name>~<sid8>`; a handle is never
#: reused for a different `harness_session_id`.
sessions = sa.Table(
    "sessions",
    metadata,
    sa.Column("handle", sa.String(128), primary_key=True),
    sa.Column("card_id", sa.String(80), nullable=False),
    sa.Column("harness_session_id", sa.String(128), nullable=False),
    sa.Column("registered_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
    sa.UniqueConstraint("card_id", "harness_session_id", name="uq_sessions_card_hsid"),
)

#: A name a later `SessionStart` supplied for a session that already had a handle (spec 5.4.1, D30;
#: S1-ID). The handle never changes; the alias is a second name for it. At most 8 per handle (the
#: registry enforces it). Not a routing key: several sessions may carry the same alias.
session_aliases = sa.Table(
    "session_aliases",
    metadata,
    sa.Column("handle", sa.String(128), nullable=False),
    sa.Column("alias", sa.String(48), nullable=False),
    sa.Column("card_id", sa.String(80), nullable=False),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint("handle", "alias", name="pk_session_aliases"),
)
sa.Index("ix_session_aliases_card_alias", session_aliases.c.card_id, session_aliases.c.alias)

#: An agy sub-invocation conversation (a subagent or a background invocation) grouped under its
#: root's handle, with the root and parent ids the client reported, for provenance (spec 5.4.1;
#: S1-ID). The ids are client-supplied assertions of a `local-harness` key holder and are matched
#: only within the key's own card.
session_conversations = sa.Table(
    "session_conversations",
    metadata,
    sa.Column("card_id", sa.String(80), nullable=False),
    sa.Column("conversation_id", sa.String(128), nullable=False),
    sa.Column("handle", sa.String(128), nullable=False),
    sa.Column("root_conversation_id", sa.String(128), nullable=True),
    sa.Column("parent_conversation_id", sa.String(128), nullable=True),
    sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint("card_id", "conversation_id", name="pk_session_conversations"),
)
sa.Index("ix_session_conversations_handle", session_conversations.c.handle)

#: Wake budget and wake confirmation (spec 7.3, 7.5). Carries counts, never task content.
wakes = sa.Table(
    "wakes",
    metadata,
    sa.Column("wake_id", sa.Integer, primary_key=True, autoincrement=True),
    sa.Column("handle", sa.String(128), nullable=False),
    sa.Column("at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("pending_n", sa.Integer, nullable=False),
    sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
)
sa.Index("ix_wakes_handle_at", wakes.c.handle, wakes.c.at)

#: Append-only security log (spec 1.3). Never stores message bodies, API keys or key secrets.
#: Not pruned by retention: it is kept until the user prunes it.
audit = sa.Table(
    "audit",
    metadata,
    sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
    sa.Column("at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("actor", sa.String(255), nullable=False),
    sa.Column("event", sa.String(64), nullable=False),
    sa.Column("subject", sa.String(255), nullable=True),
    sa.Column("detail_json", sa.JSON, nullable=True),
)
sa.Index("ix_audit_at", audit.c.at)
sa.Index("ix_audit_event_at", audit.c.event, audit.c.at)
