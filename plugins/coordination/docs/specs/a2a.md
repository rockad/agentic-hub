# `/a2a/v1` and the Agent Cards as built (S1-A2A)

Status 2026-11-16: built on branch `feat/coordination-a2a`, stacked on `feat/coordination-mcp`, which sits on `main` plus S1-AUTH (PR #65) and S1-STATE (PR #67); not on `main` until the user merges it. Source: [`server-api.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/server-api.md) 3.2, 3.3 (3.3.1 to 3.3.4), 8.5, 10; plan section S1-A2A; decisions D5, D22, D31 to D33, D35, Z13.

Labels: **spec** is written in `server-api.md`. **[design]** is a choice made where the spec is silent or contradicts itself; any of it can change without reopening a decision. **[verified]** was run and read in this stream's tests. **[unverified]** was not run.

## 1. What is in the code

- `coordination/a2a/cards.py`: the cards file (`config/cards.yaml`) parser and `CardRegistry`, `sync_cards` (writes the file into the `cards` table), `SessionLister` (live sessions for the extended card) and `CardBuilder` (member card, extended card, front-desk card).
- `coordination/a2a/operations.py`: the 11 operations over `CoordinationService`, transport-free. No task logic is here: visibility, trust by origin, the state machine, `message_id` idempotency and the limits of 3.3 (8 parts, 32 KiB per text part, 200 history messages) are the service's, identical to `/mcp`.
- `coordination/a2a/jsonrpc.py` and `rest.py`: the two bindings. They parse, call one operation and render.
- `coordination/a2a/context.py`: the `A2A-Version` check (D33) and the caller, built from the principal the access-control middleware left in the request scope.
- `coordination/a2a/errors.py`: `A2AProblem` and the mapping from service errors.
- `coordination/a2a/push.py`: push configuration and delivery, present and off.
- `coordination/app.py`: `create_app(..., a2a=endpoint)` adds the routes behind the shared redaction and access-control middleware; `build_server_app` builds the endpoint and writes the cards file into the `cards` table in the lifespan start.

No table and no migration changed. Migration numbers m0003 and m0004 are still unused, m0005 is not taken.

## 2. Routes

| route | access | what |
| --- | --- | --- |
| `GET /.well-known/agent-card.json` | public | front-desk card (Z13) |
| `GET /agents/<card>/.well-known/agent-card.json` | any valid API key | member card, `404` for a card that is not defined |
| `POST /a2a/v1` | `local-harness`, `remote-peer` | JSON-RPC 2.0 |
| REST under `/a2a/v1` and `/a2a/v1/{tenant}` | same | the HTTP+JSON binding |

Access is decided by the S1-AUTH middleware before any handler runs; this stream adds no access rule of its own. A `status-client` key gets `403` on `/a2a/v1`; a request with no key gets `401`.

REST paths (as the SDK 1.3.0 routes them), each in a plain and a tenant-prefixed form:

- `POST /message:send`, `POST /message:stream` (-32004, HTTP 400)
- `GET /tasks/{id}`, `GET /tasks`, `POST /tasks/{id}:cancel`
- `GET` or `POST /tasks/{id}:subscribe` (-32004, HTTP 400)
- `POST` and `GET /tasks/{id}/pushNotificationConfigs`, `GET` and `DELETE /tasks/{id}/pushNotificationConfigs/{push_id}`
- `GET /extendedAgentCard`

Success bodies are ProtoJSON with `application/a2a+json`, as the SDK serves them. REST errors are `{"error": {"code": <http>, "status": ..., "message": ..., "details": [ErrorInfo]}}` and use `application/a2a+json` as well: A2A 1.0.1 section 11.1 (SHOULD, for requests and responses) and the 11.6 error example win over the two older `application/problem+json` examples (decision of the TCK allowlist review, 2026-11-16). The server's own gates in front of the binding (the access-control middleware, the Agent Card routes) keep RFC 9457 `application/problem+json`, as does `/status`. JSON-RPC errors carry the same `ErrorInfo` in `data`.

## 3. The cards (spec 3.2, 8.5; D31 to D33, D35, Z13)

- Wire form is ProtoJSON camelCase (`MessageToDict`), no v0.3 compatibility fields, `streaming: false` and `pushNotifications: false` printed, not implied. All eight required fields are present for every card; a card without skills gets one default skill so `skills` is never empty.
- Interface URLs are `A2A_PUBLIC_URL` plus `/a2a/v1`, never the listen address, one entry per binding (`JSONRPC`, `HTTP+JSON`), `protocolVersion` `1.0`. `tenant` equals the card id.
- `securitySchemes` has the bearer scheme, `securityRequirements` requires it. The extension URI is `urn:agentic-hub:coordination:v1`, `required: false`.
- Every description carries the D22 deviation sentence with the configured cap (`A2A_SEND_BLOCK_MAX_S`, not a hard-coded 60).
- A card therefore cannot claim more than the server does: the interface, tenant, security, flags, modes and extension come from the server; the cards file contributes name, description, version and skills.
- `cards.yaml` schema (S1-AUTH's start-up check enforces only `name`) [design]: `cards[].name` (the card id), optional `description`, `version`, `skills[]` (`id`, optional `name`, `description`, `tags`, `examples`).
- Cache: `Cache-Control: max-age=60` on every card. Errors and API responses are `no-store`.
- The front-desk card (decision Z13, 2026-11-15) is public and generic: name, description, bearer auth declared, one skill that says it takes no tasks, no member name and no tenant. The member-listing extension field and routing by `metadata.target` are not built; the `?agent=` selector and the `300` reply are dropped. A `SendMessage` with no tenant, JSON-RPC or REST, is refused as `InvalidParams` (-32602) whose message and `data.memberCardPath` point at `/agents/{card-id}/.well-known/agent-card.json`. [verified] by `test_a2a_cards.py`, `test_a2a_jsonrpc.py`, `test_a2a_rest.py`: `metadata.target` is not a routing input.
- Member cards need any valid key of any scope; the same `401` for a card that exists and one that does not (no oracle without a key); `404` for an unknown card once a key is presented.
- The extended card (`GetExtendedAgentCard`): the member card; for a `local-harness` key the extension `params` also lists the card's live sessions (`handle`, `liveness` as `listening`, `active` or `registered`); never for a `remote-peer` key (D-H).
- [design] "Each card's interface URL points at its own path" (3.2) is met through the tenant: every member card's interfaces carry the one `/a2a/v1` URL and `tenant` equal to its own card id, which is what 8.5 shows. A per-card URL such as `/a2a/v1/<card>` would also work on the REST binding, but not on JSON-RPC, which has one `POST /a2a/v1`. If the user reads 3.2 as a per-card URL, it is a one-line change in `CardBuilder._interfaces`.
- [design] A card removed from the cards file is not deleted from the `cards` table: keys, sessions and tasks may still name it.

## 4. Operations (spec 3.3.1)

- All eleven are served. `SendMessage`, `GetTask`, `ListTasks`, `CancelTask` and `GetExtendedAgentCard` work; `SendStreamingMessage` and `SubscribeToTask` answer -32004; the four push operations answer -32003 while `A2A_PUSH_ENABLED=0`, before they look at the task (so they are no oracle for task ids).
- The JSON-RPC method set is closed to the 11 names. There is no raw-RPC escape hatch and the SDK v0.3 compatibility layer is not used.
- Order of checks on JSON-RPC: JSON body (-32700), a JSON-RPC 2.0 object, no batch (-32600), then the version (-32009), then the method (-32601), then the caller, then the params (-32602), then the operation. The version check is before the method lookup so a v0.3 client, whose method names differ, is told about the version. On REST the version is checked before the body is read.
- `A2A-Version`: `1.0` and `1.0.<patch>` are served; a missing header, `0.3` and anything else is -32009 with a message that says to send `1.0` and `data.received` (first 32 characters), `data.supported`. [design] `1.0.x` is accepted because the card says `1.0` and a patch level is not a different protocol; `1.1` is not.
- Content types of message parts `text/plain` and `application/json`; anything else is -32005. Limits are the service's: 8 parts, 32 KiB per text part, 200 history messages.
- Tenant rules: an empty tenant is the front desk (above). A non-empty tenant must be a defined card. For a `remote-peer` key a tenant outside `cards_allowed` and a tenant that is not defined are the same answer, `CardNotAllowed` (-32010, HTTP 403, X3). For a local key an unknown card is `InvalidParams`. A tenant in the REST path and a different one in the body is `InvalidParams`. The tenant is checked on reads and cancel too, as well as on `SendMessage`.
- Caller: from the principal, never from the body. `local-harness` is the key's card plus a handle only when `X-Coord-Handle` names exactly one live, registered session of that same card [design: any other value is ignored, not an error, because the handle is a hint and a stale one from a hook script should not break a call]. `remote-peer` is `peer:<peer_id>` and its `cards_allowed`; the header is not read.
- `ListTasks`: `pageSize` 1 to 100 (default 50), `historyLength` not negative, artifacts omitted unless `includeArtifacts`; the envelope fields are always present. Paging, filters and visibility are the service's over `task_index`.
- Idempotency: the same `messageId` returns the existing task (the service's rule). [verified] on both bindings.

### 4.1 Blocking `SendMessage` (D22)

- Without `returnImmediately` the call waits for a terminal or interrupted state, at most `A2A_SEND_BLOCK_MAX_S` (default 60), then returns the current `SUBMITTED` or `WORKING` task. With `returnImmediately` it returns at once. A held task is already `INPUT_REQUIRED` on the wire, so it returns at once.
- [design] The wait polls `get_task` every 0.5 s: the service has no change notifier (service-layer.md section 4). A task that vanishes or stops being visible during the wait returns the last view.
- [verified] by tests: with the cap at 2 s a blocking send on a parked task returns `SUBMITTED` after about 2 s of real time (`test_a_blocking_send_with_a_real_clock_returns_after_about_two_seconds`); the 60 s default is exact in virtual time; the wait ends early when the recipient finishes; `returnImmediately` does not wait.

### 4.2 Errors

The A2A errors use the SDK's own tables (`a2a.utils.errors`), so a client built on the SDK reads them back as the same exception classes [verified with the SDK 1.3.0 client in `test_a2a_e2e.py`: `TaskNotCancelableError` and `PushNotificationNotSupportedError`]. Three errors are ours and have no A2A number [design], in the implementation-defined range:

| code | name | HTTP | when |
| --- | --- | --- | --- |
| -32010 | `CARD_NOT_ALLOWED` | 403 | a peer's tenant is outside `cards_allowed` or not defined |
| -32011 | `QUOTA_EXCEEDED` | 429, `Retry-After` | the remote-peer quotas of 3.3.2 |
| -32012 | `FORBIDDEN` | 403 | the caller can see the task but the action is not theirs |

JSON-RPC answers HTTP 200 for its errors except these 403 and 429, which 3.3 and 3.3.2 give a status. An unexpected exception is the constant `InternalError` with nothing of the cause; the class name goes to the log, never the message. A task that is missing and a task the caller may not see are the same `TaskNotFound`.

## 5. Push (code present, off; spec 3.3.4)

- With `A2A_PUSH_ENABLED=0` no push store and no sender is built and the card says `pushNotifications: false`. With it on (and `A2A_PUSH_ENC_KEY` set, else building refuses) the card says `true`.
- Store: the SDK's `DatabasePushNotificationConfigStore` over the table S1-STORE migrated (`create_table=False`), with the Fernet key. [verified] the URL, token and credentials are not in the table in clear.
- Screen (`screen_push_url`), run at config time and again at send time: `https` only, no userinfo, port 443 unless an allow-list entry names another, every resolved address must be public (not loopback, link-local, private, unique-local, multicast, reserved, unspecified, the metadata address or `100.64.0.0/10`; an IPv4-mapped IPv6 address is judged as the IPv4 address), an unresolvable name fails closed, and the SDK's `validate_push_notification_url` is always asked.
- [design] An exact name in `A2A_PUSH_ALLOW_HOSTS` skips the address rules and the SDK validator (and only those), because the SDK validator would refuse exactly the private and tailnet targets the allow-list exists to permit; the scheme, userinfo and port rules still apply.
- Pin: the sender connects to the address the screen approved (the URL carries the address; `Host` and the TLS server name carry the name), follows no redirect (a 3xx is a recorded failure), ignores proxy environment variables, has 5 s connect and read timeouts and reads at most 4 KiB of the response. A name that was public at config time and private at send time is refused at send time because the screen runs again.
- Originator only (a task the caller cannot see and one it did not originate are the same `TaskNotFound`), at most 3 configs per task (an existing id can still be updated), `url` at most 2048 bytes, `token` 256, `credentials` 1024 [design: the size caps].
- The pushed payload is the Task without the internal `coord` metadata. A push failure never raises and never changes task state.
- **Not built: the trigger.** Nothing calls `PushSender.send` when a task changes state: the service layer has no event hook other than the wake notifier. S1-STATE would have to publish one, or S2-STREAM (optional, unscheduled) build the event fan-out. The configs are stored and screened; delivery is tested by calling the sender directly. This does not matter at S1, where push is off, and it must be settled before the flag is turned on.
- [unverified] Delivery to a real public host over TLS: the tests use a fake resolver and transport, and the SNI pin is asserted on the request the transport receives, not on a TLS handshake.

## 6. Evidence

- `tests/test_a2a_cards.py`: the builder (eight required fields, camelCase, tenant, public URL, flags, bearer scheme, deviation sentence, front desk, extended card), the cards file parser, the repository `config/cards.yaml`, and over the real middleware: root card public, member cards `401` without a key and `200` with a key of any scope, one path per member, Host checks, `sync_cards`, extended card for local and peer.
- `tests/test_a2a_jsonrpc.py` and `test_a2a_rest.py`: every operation on both bindings against the real app, a real Postgres and the real access-control middleware over the SQL key store: version, envelope, scope, send (local, peer held, card not allowed, front desk, `metadata.target` inert, planted `coord` dropped, handle header), limits, history, follow-up on a finished task, quota, blocking cap (virtual and real time), get, list, cancel, terminal states, tenant rules, streaming and push answers, errors that are constant and never cached.
- `tests/test_a2a_push.py`: the screen table, the SDK validator, the allow-list, store round trips on both bindings, the cap of 3, originator only, encryption at rest, the pinned delivery, redirects, send-time re-screen, failure handling, proxy variables.
- `tests/test_a2a_e2e.py`: a real uvicorn server serving `build_server_app` over a socket, driven by the A2A SDK 1.3.0 client on JSON-RPC and on REST: it reads the member card from its own path with a key, follows the interface URL and tenant, sends, reads, lists, cancels, reads the extended card, and gets the SDK's own exception classes for -32002 and -32003. It also checks the public root card, `401` and `-32009` over real HTTP and that the cards file reached the `cards` table at start-up.

## 7. What could not be checked, and what is open

- **The spec text.** The clone of `a2aproject/A2A` at `4735f48` was deleted (`docs/research` says so); this stream had no copy of `specification.md` and did not re-fetch it. Wire shapes (field names, enum names, method and REST path names, error codes) are those of the SDK 1.3.0 (`a2a.types.a2a_pb2`, `a2a.utils.errors`), which the repository pins and which implements 1.0.x. "Against the pinned commit" is therefore **[unverified] against the spec text**; it is [verified] against the SDK's generated types and its own client. The `.proto` shipped in the SDK was not diffed against `4735f48`.
- **The TCK runs in CI as `.github/workflows/coordination-tck.yml`** (pull requests and pushes to `main` that touch `plugins/coordination/**`, and by hand). See section 8 for what runs and its result. [unverified] The workflow has not run on GitHub yet: nothing is pushed, and the cold build of the TCK environment (grpcio from source on Python 3.15) in a hosted runner has not been timed. The allowlist (`tests/tck/allowlist.yaml`) was reviewed by the user on 2026-11-16: all 13 entries are `review: reviewed`, including `HTTP_JSON-ERR-001` (section 8), added after the next run and reviewed the same day; two entries of the first run were fixed (REST error media type) or made obsolete (camelCase `metadata.coord` keys, Z16) and removed.
- **The `?agent=` selector, the member listing and `metadata.target`** are not built (Z13).
- **Streaming** is not built (D35); the card says so.
- **Push delivery** has no trigger (section 5).
- **Rate limits and the handle-guess counter** are the service layer's (S2-LISTEN, S3-LIMITS); the binding adds none, and a quota failure is mapped to -32011 with `Retry-After`.
- **`SessionLister`** reads the `sessions` table directly, as S1-MCP's `SessionRegistry` does for `a2a_peers`; the service layer has no list-sessions call. S1-ID owns `/sessions` and may merge the two. `ListenerView` is empty until WAKE, so `listening` never appears yet.
- **Lifespan work not started here:** the service's TTL sweep loop. Started by the app lifespan since Z18 (identity.md section 6).

## 8. The A2A TCK gate

What it is: the SDK's TCK (`a2aproject/a2a-tck`, pinned at `104a7b4`, which ships the spec text at `a2aproject/A2A` v1.0.1, commit `3303592`) run against the real server, with a failure that is not on a reviewed allowlist blocking. Files, all under `servers/coordination/tests/`:

- `test_a2a_tck.py`: starts the real app (`build_server_app`, a real Postgres, the real middleware) in a uvicorn thread behind a test-only front, runs the TCK as a subprocess (`uv run --python 3.15 ./run_tck.py --sut-host ...`, working directory the TCK checkout), reads its JUnit report and applies the gate. Skipped unless `A2A_TCK_DIR` names a checkout; `A2A_TCK_REQUIRE=1` makes the skip a failure (CI sets it).
- `tck_support.py`: the allowlist parser and the gate. A failed test that is not listed blocks; a listed test that did not fail is stale and also blocks; a report with no test cases blocks; a malformed allowlist is refused.
- `test_a2a_tck_gate.py`: the gate and the allowlist file tested offline (no TCK, no database).
- `tck/allowlist.yaml`: the deviations, one exact test id each, with the decision it rests on and a reason.
- `.github/workflows/coordination-tck.yml` (repository root): the GitHub workflow (clone the TCK at the pinned commit, `uv sync --python 3.15`, run the two test files with `A2A_TCK_REQUIRE=1`). `test_a2a_tck_gate.py` checks that it pins `TCK_COMMIT`, sets `A2A_TCK_REQUIRE=1` on the gate step, and has the triggers and `permissions: contents: read`.

Why a front, and what it hides [verified by reading the TCK source and by the first run]:

- The TCK reads `{sut-host}/.well-known/agent-card.json`, sends no API key (it has no option for one) and sends no tenant. Here the root card is the public front desk, which takes no tasks (Z13), so without help every send is refused as `InvalidParams` ("front desk"). `TckFront` serves one member card at the root path, adds the bearer key of a local-harness card and adds the tenant the card names (`params.tenant` on JSON-RPC, a `/<tenant>` path segment on REST). Nothing in `src/` changes for the TCK.
- That is what a client that follows the card does, but it means the TCK does not test the card discovery path, the `401` without a key, or the `A2A-Version` strictness from the client side. The first two are covered by `test_a2a_cards.py` and `test_a2a_e2e.py`. The TCK sends `A2A-Version: 1.0` and one test sends `99.0`; neither exercises a missing header (D33).
- The blocking cap is set to 2 s for the run (production 60 s, D22). With 60 s every TCK blocking send waits out the cap and the run did not finish in 5 minutes. The 60 s value itself is covered by `test_a2a_jsonrpc.py`.

Result of the run on 2026-11-16 (TCK `104a7b4`, Python 3.15.0b4, JSON-RPC and HTTP+JSON, all requirement levels) [verified, ran it and read the report]:

- First run: 263 test cases: 96 passed, 14 failed (all on the allowlist then), 153 skipped, 0 blocking, 0 stale.
- Run after the allowlist review and its fixes (the REST media type, the camelCase coord keys, and `Z`-suffixed `createdAt` and `expiresAt`): gate line `TCK gate: 263 test cases, 13 allowed deviations failed, 0 blocking, 0 stale allowlist entries`; 97 passed, 13 failed, 153 skipped. All 13 are `reviewed`.
- The one real gap the first run found, a missing `ETag` on the Agent Card (A2A 1.0.1 section 8.6, SHOULD), was fixed in this stream: member and front-desk cards now carry an `ETag` (a hash of the card body) and answer a matching `If-None-Match` with `304` (`test_a2a_cards.py`).
- The 12 reviewed failures that remain, by cause:
  - 10, artifacts and a direct `Message` reply (`DM-ART-001`, `DM-MSG-001`): tasks are parked and never executed, so no task carries artifacts and `SendMessage` always returns the Task (AGENTS.md security invariants, server-api.md 3.3.2).
  - 2, `CORE-SEND-003`: a defect in the TCK at this commit. The requirement's definition sets no `expected_error`, so `_validate_response` treats any error as a failure, including the `ContentTypeNotSupportedError` the requirement asks for [verified by reading `tck/requirements/core_operations.py` and `tests/compatibility/core_operations/test_requirements.py`; the main session confirmed it on 2026-11-16 at `104a7b4`, which was also upstream HEAD that day].
- 1 more, reviewed by the user on 2026-11-16 (Z16) as a TCK defect: `HTTP_JSON-ERR-001` (MUST), `test_error_uses_aip193_format`. It checks `"application/json" in content-type`, which `application/a2a+json` can never satisfy, while `HTTP_JSON-SVC-001` (SHOULD) requires `application/a2a+json` for the same response. The two TCK tests contradict each other at `104a7b4`; no response passes both. It showed only after the media type change [verified by reading `tests/compatibility/core_operations/test_error_handling.py` and by the run]. The user kept `application/a2a+json` (spec 11.1 and 11.6) instead of serving `application/json` and allowing `HTTP_JSON-SVC-001`.
- The two other failures of the first run were fixed, not allowed (decisions of the allowlist review, 2026-11-16):
  - `HTTP_JSON-SVC-001` (SHOULD): REST errors are now `application/a2a+json` (A2A 1.0.1 section 11.1 and the 11.6 error example win over the older `application/problem+json` examples).
  - `DM-SERIAL-001`: the keys of `Task.metadata.coord` are camelCase (`createdAt`, `recipientListening`, `expiresAt`; Z16). MCP tool output keeps its own snake_case contract. With that fixed, `DM-SERIAL-003` (timestamps are ISO 8601 UTC with `Z`) failed on `createdAt`, which the first failure had hidden; `createdAt` and `expiresAt` are now written with a `Z` suffix (`coord.iso_z`).
- 153 skipped, so not tested [verified, from the report's skip messages]: gRPC not served (53), push not supported (30), streaming not supported (35), tests whose precondition is a task in `COMPLETED` (8) or `INPUT_REQUIRED` (16) that a parked task never reaches, an extended-card precondition (2), an empty level (3), and 6 others (a required TCK test extension the card does not declare, no `Last-Modified`, a custom-binding and an extended-card precondition, and one test that skipped itself because the server did not reject a wrong request `Content-Type`; that last one may be a real gap and is not yet looked at). **A skip is a coverage gap, not a pass.** The plan's initial candidate entries (the 60 s cap, `A2A-Version` strictness, `QUARANTINED` shown as `INPUT_REQUIRED`, card access, tenant rules) mostly do not show up as failures here: the 60 s cap and the parked states appear as skips, and the others are hidden by the front.
- The first run with an empty allowlist exited 1 with 15 blocking failures [verified]: the gate blocks.

Running it by hand:

- Python 3.15 is needed (the TCK requires `>=3.15`). Its lock has no 3.15 wheel for `grpcio`, so `uv sync --python 3.15` in the TCK checkout builds it from source (about 10 minutes on a 16-thread workstation, much longer in a constrained CI runner, so the workflow caches the environment) [verified on the workstation].
- `A2A_TCK_DIR=<checkout> A2A_TCK_REQUIRE=1 A2A_TEST_REQUIRE_DOCKER=1 uv run pytest tests/test_a2a_tck.py -s` in `servers/coordination`. The run takes about two minutes.
- [unverified] The GitHub workflow itself was not run on GitHub (nothing was pushed). Its YAML was parsed with `yq` and checked by `test_a2a_tck_gate.py`; the same commands it runs were run by hand (above).
