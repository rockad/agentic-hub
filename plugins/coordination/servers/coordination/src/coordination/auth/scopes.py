"""The scope matrix over the endpoint map (spec 2 and 8.1, S1-AUTH).

`classify(path)` says what a request to `path` needs:

- `Access.EXEMPT`: `/healthz`. No Host check, no key (spec 3.7).
- `Access.PUBLIC`: the root front-desk card. Host and Origin still apply, no key (spec 3.2).
- `Access.ANY_KEY`: member cards. Any valid key of any scope (spec 3.2, D32).
- `Access.SCOPED`: the key's scope must be in `Rule.scopes`.
- None: not an endpoint of ours. The caller answers `404` with no body (spec 2).

Default deny: a path that is not in the table is never routed, so a later stream that mounts a
router without adding its path here gets a 404, not an unauthenticated endpoint.

Methods are not part of the matrix: the spec fixes the scope per path, and the router of the
stream that owns the path answers `405` for a wrong method, after authentication.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

from coordination.auth.records import LOCAL_HARNESS, REMOTE_PEER, STATUS_CLIENT

ROOT_CARD = "/.well-known/agent-card.json"
_MEMBER_CARD = re.compile(r"^/agents/[^/]+/\.well-known/agent-card\.json$")


class Access(Enum):
    EXEMPT = "exempt"
    PUBLIC = "public"
    ANY_KEY = "any-key"
    SCOPED = "scoped"


@dataclass(frozen=True)
class Rule:
    access: Access
    scopes: frozenset[str] = frozenset()
    card: bool = False  # an Agent Card: its own Cache-Control (max-age=60), not no-store


EXEMPT = Rule(Access.EXEMPT)
ROOT_CARD_RULE = Rule(Access.PUBLIC, card=True)
MEMBER_CARD_RULE = Rule(Access.ANY_KEY, card=True)

# (prefix, scopes). A prefix matches the path itself and everything below `prefix/`.
_PREFIXES: tuple[tuple[str, frozenset[str]], ...] = (
    ("/a2a/v1", frozenset({LOCAL_HARNESS, REMOTE_PEER})),
    ("/mcp", frozenset({LOCAL_HARNESS})),
    ("/wake", frozenset({LOCAL_HARNESS})),
    ("/sessions", frozenset({LOCAL_HARNESS})),
)
_STATUS = Rule(Access.SCOPED, frozenset({STATUS_CLIENT}))


def classify(path: str, *, status_enabled: bool = True) -> Rule | None:
    """The rule for `path`, or None if it is not one of our endpoints.

    `/status` is an endpoint only when `A2A_STATUS_ENABLED=1` (spec 3.6); off, it is unknown.
    """
    if path == "/healthz":
        return EXEMPT
    if path == ROOT_CARD:
        return ROOT_CARD_RULE
    if _MEMBER_CARD.match(path):
        return MEMBER_CARD_RULE
    if path == "/status":
        return _STATUS if status_enabled else None
    for prefix, scopes in _PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            return Rule(Access.SCOPED, scopes)
    return None
