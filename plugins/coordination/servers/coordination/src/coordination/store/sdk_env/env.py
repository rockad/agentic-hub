"""Alembic environment for the SDK migration stream.

The SDK ships its own `env.py`, but that one reads `DATABASE_URL` (a URL with the password in it)
and builds its own engine, which `A2A_DB_URL` and the secret-file rule forbid. This one takes the
connection our engine already holds (`config.attributes["connection"]`) and uses the SDK's
revision files unchanged, from `version_locations`. The version table is the SDK's own,
`a2a_alembic_version`, so a database an operator already migrated with `a2a-db` is recognised.
"""

from alembic import context

from a2a.server.models import Base

VERSION_TABLE = "a2a_alembic_version"  # same as a2a/migrations/env.py

connection = context.config.attributes["connection"]
context.configure(connection=connection, target_metadata=Base.metadata, version_table=VERSION_TABLE)
with context.begin_transaction():
    context.run_migrations()
