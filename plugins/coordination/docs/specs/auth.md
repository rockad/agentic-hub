# API keys, access control and start-up checks (S1-AUTH)

Status 2026-11-15: built on branch `feat/coordination-auth`, not merged. Source: [`server-api.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/server-api.md) 1.6, 2.1, 8.1, 8.2; implementation plan section S1-AUTH.

Labels: **spec** is written in `server-api.md`. **[design]** is a choice S1-AUTH made where the spec is silent; any of it can change without reopening a decision. **[unverified]** was not run or read.

## 1. What is in the code

- `coordination/auth/keys.py`: key format, hashing, `verify_key`.
- `coordination/auth/records.py`, `store.py`: `ApiKeyRecord`, `Principal`, the `ApiKeyStore` interface, `SqlApiKeyStore` over the `api_keys` table, and an in-memory double for tests.
- `coordination/auth/scopes.py`: the scope matrix.
- `coordination/auth/middleware.py`: the check order of spec 2.1 as one ASGI middleware.
- `coordination/auth/startup.py`: the start-up checks of spec 1.6 as one function, `startup_check`.
- `coordination/app.py`: the middleware is composed behind the S1-OBS redaction middleware; `/status` gets its real authorizer; `main` calls `startup_check`.
- `coordination/config.py`: one derived field, `public_listener_enabled` (section 6).
- No migration and no table change: the `api_keys` table of migration m0001 already has every column. Migration number m0003 is unused.

## 2. Keys (spec 8.2)

- Format `a2ak_<env>_<keyid>_<secret>`: `env` is `dev` or `live`, `keyid` is 8 lower-case hex characters, `secret` is 43 base64url characters (32 bytes from `secrets.token_bytes`).
- Stored value: `sha256:<hex>`, or `hmac-sha256:<hex>` when `A2A_KEY_PEPPER` is set. **[design]** The scheme is part of the stored value, so a key issued before the pepper was set still verifies, and a key stored as HMAC is refused when the pepper is missing.
- `verify_key` hashes the presented secret and runs exactly one `hmac.compare_digest` on every path: a missing key id, a malformed token and a wrong secret all compare against a dummy hash of the same shape. A test counts the comparisons, and a timing test with a positive control checks the bound (a verifier without the dummy comparison fails it).
- The refusal reason (`Verdict`) is internal. The client always gets the same `401` body.
- `env` must equal `A2A_ENV`, both in the token and in the stored record. A dev key is refused by a live server (unit test and a test on Postgres; S2-DEPLOY repeats it on core).
- `last_used_at` is updated at most once a minute per key **[design]**.

## 3. Check order (spec 2.1)

1. Size: `Content-Length` over `A2A_MAX_BODY_BYTES`, or more bytes than that actually received, is `413`. Header bytes over 16 KiB are also `413` **[design]**: the spec says "header size limits" without a number or a code, and 16 KiB is uvicorn's own h11 default.
2. `Host` in `A2A_ALLOWED_HOSTS` (exact, case-insensitive, one `Host` header only), else `421`.
3. `Origin`, if present, in `A2A_ALLOWED_ORIGINS`, else `403`. No `Access-Control-*` header is ever sent.
4. A path outside the endpoint map is `404` with no body. **[design]** This comes after the Host and Origin checks and before the key check, so there is no unauthenticated route: a stream that mounts a router and forgets to add its path to `scopes.py` gets a `404`, not an open endpoint.
5. Bearer: missing, malformed, unknown, revoked, expired or wrong-env is `401` with `WWW-Authenticate: Bearer`.
6. Scope: wrong scope is `403` with no detail.
7. Rate limit: a `RateLimiter` hook, `429` with `Retry-After`. **No limiter is installed**: the numbers belong to S3-LIMITS (spec 8.4, plan S3-LIMITS). The step is tested with a fake limiter.
8. Tailnet identity, when `A2A_ENFORCE_TAILNET_IDENTITY=1`, for `local-harness` keys: `403` on a mismatch. The identity is read through an `IdentitySource` and only for a peer in `A2A_TRUSTED_PROXY_IPS` (addresses or CIDR ranges); a request from any other peer has no identity, whatever headers it sends. The real source is S2-TS **[unverified: how the identity reaches the server]**. **[design]** A harness key without a tailnet binding is refused while enforcement is on (spec 1.5 and 8.3).

Rules that apply to every response:

- `/healthz` is exempt from every check (spec 3.7).
- The root card `GET /.well-known/agent-card.json` skips the key steps (Host and Origin still apply, spec 3.2). Member cards need any valid key.
- Errors are `application/problem+json` with `type`, `title`, `status`, `detail`, and `Cache-Control: no-store`.
- Every non-card response carries `Cache-Control: no-store`, whatever the handler set. Card responses keep the handler's header (spec 3.2: `max-age=60`).
- A key-store error is a generic `503` with `Retry-After`; the request is never let through. Only the exception type is logged.
- A failed audit write never changes who gets in. A `401` is counted through `AuditLog.auth_failure()`, which writes one sampled row per window.
- Websockets are refused; no endpoint uses one.

## 4. Scope matrix (spec 2 and 8.1)

| path | scopes |
| --- | --- |
| `/healthz` | none, exempt |
| `/.well-known/agent-card.json` | none, public |
| `/agents/<card>/.well-known/agent-card.json` | any valid key |
| `/a2a/v1`, `/a2a/v1/...` | `local-harness`, `remote-peer` |
| `/mcp`, `/wake/...`, `/sessions/...` | `local-harness` |
| `/status` | `status-client`, and only when `A2A_STATUS_ENABLED=1` |
| anything else | `404`, no body |

Methods are not part of the matrix: the router of the stream that owns a path answers `405`, after authentication. There is no admin route and no admin scope (D15).

## 5. `/status` authorizer

With a key store, `create_app` installs `status_client_authorizer` (the S1-OBS extension point): the caller's key must have the `status-client` scope. The middleware has already refused other scopes with `403`; the route re-checks, so a route reached without the middleware still fails closed.

## 6. Start-up checks (spec 1.6)

`startup_check()` reads the configuration, runs the conditions, then calls `store.connect.check_database` and returns the `Config`. Any failure is `SystemExit("coordination: <one line>")`: status 1, one line on stderr. A subprocess test runs `python -m coordination` with a bad `A2A_ENV`.

| condition | where |
| --- | --- |
| schema newer than the code | `check_database` (S1-PG and S1-STORE), reused, not repeated |
| `s2` or `s3` and `A2A_PUBLIC_URL` not `https://` | `problems` |
| `s2` or `s3` and `A2A_TRUSTED_PROXY_IPS` empty | `problems` |
| public listener off at `s2` or `s3`, or on at `s1` | `problems` |
| public hostname in `A2A_ALLOWED_HOSTS` before `s3` | `problems` |
| `A2A_ENV` not `dev` or `live` | the config parser, caught by `startup_check` |
| `s2` or `s3` and tailnet enforcement off | `problems` |
| push enabled without `A2A_PUSH_ENC_KEY` | `problems` |
| cards file missing, invalid, or a card id not matching the pattern | `problems` |
| more than one worker | `problems` |

The configuration conditions run before the database check, so a bad configuration never waits for Postgres. A parametrised test covers every condition and asserts the database was not reached.

**[design]** choices:

- "Public listener enabled" is `Config.public_listener_enabled`. With `A2A_PUBLIC_LISTEN` unset it follows the stage (on from `s2`, spec 1.5); set to a value it is on; set to the empty string it is off. Spec 1.5 gives the variable a default and says it starts at `s2` and `s3`, not at `s1`, so the value alone cannot tell "enabled". S2-LISTEN should use the same field.
- "The public hostname" is the host of `A2A_PUBLIC_URL` when that is neither loopback nor a Tailscale name (`*.ts.net`). At `s2` the public URL is the tailnet name and `A2A_ALLOWED_HOSTS` must contain it, so only the Cloudflare hostname is refused before `s3`. The `.ts.net` suffix rule is an assumption **[unverified]**: the spec names the hostname only as a placeholder.
- The card id in the cards file is the entry's `name` (the AgentCard field of spec 8.5). The full cards schema belongs to S1-A2A and S1-ID; this check enforces only what 1.6 states.
- "More than one worker" is checked on the number `main` passes (`app.WORKERS`, which it also hands to uvicorn). No environment variable sets the worker count, so the check guards the code path, not a setting.
- `pyyaml` moved from the dev group to the runtime dependencies, because the cards file is read at start.

## 7. Evidence

- Canary scan: a created and used key's token and secret, and the pepper, are searched for in a plain-text rendering of a `pg_dump -Fc` file (`pg_restore -f -`, run inside the Postgres container), in the `audit` table, in the log stream and in the responses. Positive controls: a known string in a table is found by the same rendering; a secret written into a column is found by the same scan; the log and audit are not empty.
- The log scan runs with the S1-OBS redacting handler installed, as in production, so it shows the whole pipeline, not that the middleware alone logs nothing.

## 8. Not done here

- The production `AuditStore` over the `audit` table (S1-STATE owns it, decision Z6): the middleware accepts an `AuditLog`, and `main` passes none yet, so auth failures are not yet written to the table in the running server.
- Key creation, rotation and revocation commands, and closing parked listeners and MCP sessions on revoke (S1-ADMIN, S1-WAKE, S1-MCP). `generate_key`, `ApiKeyStore.insert` and `revoke` are the pieces they build on.
- The per-key rate-limit numbers and the per-client-IP limit (S3-LIMITS), the real Tailscale identity source (S2-TS), and the 8121 public-listener rules (S2-LISTEN).
