"""API keys, the access-control middleware and the start-up checks (S1-AUTH).

- `keys`: key format, hashing, constant-time verification.
- `records`, `store`: the `api_keys` record, the principal, the SQL store.
- `scopes`: the scope matrix over the endpoint map (default deny).
- `middleware`: the spec 2.1 check order as one ASGI layer.
- `startup`: the spec 1.6 start-up checks as one function.
"""

from coordination.auth.keys import GeneratedKey, ParsedKey, Verdict, generate_key, hash_secret, parse_key, verify_key
from coordination.auth.middleware import (
    AccessControlMiddleware,
    IdentitySource,
    RateLimiter,
    TailnetIdentity,
    principal_from_scope,
)
from coordination.auth.records import (
    LOCAL_HARNESS,
    REMOTE_PEER,
    SCOPES,
    STATUS_CLIENT,
    ApiKeyRecord,
    Principal,
)
from coordination.auth.scopes import Access, Rule, classify
from coordination.auth.store import ApiKeyStore, InMemoryApiKeyStore, SqlApiKeyStore

__all__ = [
    "LOCAL_HARNESS",
    "REMOTE_PEER",
    "SCOPES",
    "STATUS_CLIENT",
    "Access",
    "AccessControlMiddleware",
    "ApiKeyRecord",
    "ApiKeyStore",
    "GeneratedKey",
    "IdentitySource",
    "InMemoryApiKeyStore",
    "ParsedKey",
    "Principal",
    "RateLimiter",
    "Rule",
    "SqlApiKeyStore",
    "TailnetIdentity",
    "Verdict",
    "classify",
    "generate_key",
    "hash_secret",
    "parse_key",
    "principal_from_scope",
    "verify_key",
]
