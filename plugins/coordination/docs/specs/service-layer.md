# Service layer as built (S1-STATE)

Status 2026-11-15: built on branch `feat/coordination-state` from `main` `2d9dd83`; not on `main` until the user merges it. Source: [`server-api.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/server-api.md) 3.3.2, 3.3.3, 5.2, 6 (6.1 to 6.4), 7.4; implementation plan section S1-STATE; decisions D6, D10, D19, D22, D29, D38, Z6.

Labels: **spec** is written in `server-api.md`. **[design]** is a choice made where the spec is silent or contradicts itself; any of it can change without reopening a decision. Nothing here is wired into `app.py`: `/a2a/v1` and `/mcp` do not exist yet, and both are meant to call `CoordinationService` unchanged.

## 1. What is in the code

- `coordination/service/service.py`: `CoordinationService`, the plain async API (below).
- `coordination/service/states.py`: the transition table of spec 6.2 as data (`TRANSITIONS`), the logical states (the seven A2A states we produce plus `QUARANTINED`), and `logical_state(task)`.
- `coordination/service/types.py`: `Caller` (built by the bindings from the API key, never from the body), `ServiceSettings` (the TTL and offer variables of spec 1.5), `InboxItem`, `InboxResult`, `SweepResult`, the handle and card regexes (spec 5.1) and `derive_task_id`.
- `coordination/service/errors.py`: `ServiceError` subclasses with a constant `code` and, where A2A numbers one, the `rpc_code` (-32001 TaskNotFound, -32002 TaskNotCancelable, -32004 UnsupportedOperation, -32005 ContentTypeNotSupported).
- `coordination/service/offers.py`, `quotas.py`, `directory.py`, `ports.py`, `coord.py`: the re-offer arithmetic, the remote-peer limiter, the `sessions` and `cards` reads (and the idle-session end), the `ListenerView` port (the parked-listener table belongs to WAKE; `NoListeners` stands in), and the `coord` metadata block.
- `coordination/store/task_store.py`: `CoordTaskStore.transition` and `create` write the state change, the `task_index` change and the audit rows in one transaction (decision Z6; see [audit-events.md](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/audit-events.md) section 2 and `server-api.md` 1.3), plus the queries the service needs.
- `coordination/audit/sql.py`: `insert_audit(tx, row)`, `SqlAuditStore` (own transaction, and `append_audit_in` to join one).

No table and no migration changed. Migration number `m0004` is unused.

## 2. The API

Every method that acts for a caller takes a `Caller`. `CoordinationService` satisfies `service.protocol.TaskService` (the whole API) and `ServiceLayer` (`pending_count` only, what WAKE needs).

| method | what it is | notes |
| --- | --- | --- |
| `send_message(caller, tenant, message, metadata=None)` | `SendMessage`, `a2a_send` | new task, or a follow-up when `message.task_id` is set (6.4) |
| `get_task`, `list_tasks` | `GetTask`, `ListTasks`, `a2a_get` | visibility in SQL; a task the caller cannot see is `TaskNotFound` |
| `cancel_task(caller, task_id, reason=None)` | `CancelTask`, `a2a_cancel` | originator only; allowed on a held task |
| `inbox(caller, limit, include_followups)` | `a2a_inbox` | records offers; claims queued card tasks |
| `claim(caller, task_id)` | the atomic claim of a card task | `AlreadyClaimed` for the loser |
| `respond(caller, task_id, state, text, artifacts)` | `a2a_respond` | `working` on `SUBMITTED` is the confirmation |
| `pending_count(handle)`, `has_wake_pending(handle)` | spec 7.5 and 7.4 | no bodies; the wake budget and anti-loop rule are WAKE's |
| `release_hold(task_id, actor)`, `deny_hold(task_id, actor)`, `held_tasks(card)` | the admin socket's hooks | `actor` is the human; the only way out of a hold |
| `sweep()`, `run_forever(interval)` | the TTL rules | each step is its own compare-and-swap |

## 3. Behaviour, and where the spec was silent or inconsistent

Held (spec, D10, D19):

- A remote-peer key to a card in its `cards_allowed` creates a held task: stored as `INPUT_REQUIRED` with `coord.hold = "quarantine"` and `task_index.hold`, and a constant status message. The audit log names the state `QUARANTINED`.
- The recipient side never sees a held task: not in `get_task`, `list_tasks` or `inbox` (which only counts them as `held_for_review`). The originator sees `INPUT_REQUIRED` plus the marker.
- Only `release_hold` (admin) moves a held task to `SUBMITTED`. The TTL sweep sends an unreleased one to `REJECTED` (`quarantine_expired`). No read, rule or timer releases one. A denied, expired or cancelled held task keeps `task_index.hold`, so it stays invisible to the recipient side.
- `interrupted_task_timeout` [verified by reading the installed SDK]: in `a2a-sdk` 1.3.0 it is a setting of the SDK's `DefaultRequestHandlerV2` and `ActiveTask` that releases the in-memory `ActiveTask` of a task idle in input-required, default off. Our requests never go through that handler (BP16), so none of it runs; a test pins that nothing under `src/` imports it.

Where the spec is inconsistent, and what was built:

- **Remote key plus `coord.to`.** The plan's S1-STATE acceptance says "Remote key plus `coord.to` gives InvalidParams". Decision D38 (2026-11-09) and spec 5.2 let a remote peer address a handle inside a card in its `cards_allowed`. Built: D38. A well-formed handle in an allowed card gives a held task; an unknown, ended or out-of-card handle gives the one constant REJECTED task; a `coord.to` that is not a handle (including a bare card id) is `InvalidParams`. The acceptance bullet is stale and is not tested as written.
- **Card outside `cards_allowed`.** The plan says "REJECTED"; spec 3.3 and decision X3 (2026-11-10) say `403 CardNotAllowed`, the same for "unknown" and "not allowed", not counted by the guess counter. Built: X3 (`CardNotAllowed`, no task stored, no audit row).
- **Who claims a card task.** D29 says the first `a2a_inbox` caller claims; spec 4.9 says `a2a_respond` claims. Built: both use the same compare-and-set on `task_index.to_handle` (`inbox` claims when it lists, `respond` claims in the same transaction as its state change, `claim` is the plain call).
- **Visibility is card level.** A local-harness task's `from_principal` is the key's card, not the session handle, so the sessions of one card (mutually trusted, spec 5.1) see and may cancel each other's tasks, and a `/clear` does not strand a session's own tasks. A remote peer's is `peer:<peer_id>`. `coord.from` shows the handle.

Routing [design, from D29 and the schedule of 6.3]:

- A handle goes to that session only. A handle of an ended session is accepted and the task is orphaned (offered to nobody, never redirected; `coord.orphaned` in the view); it leaves by TTL or cancel. An unknown handle from a local key is `InvalidParams`.
- A card goes to the newest `listening` session (the `ListenerView`), then the newest registered `active` session (a call within 15 minutes), else to the card queue. The sender's own handle is never the target.
- A routed card task keeps `task_index.addressing = "card"` and `to_handle = <session>`, with `next_offer_at` set to the end of the first offer window. When that passes unconfirmed, the sweep clears `to_handle` and the task is a queue entry: the first session whose `inbox` lists it claims it.
- Idempotency: a new task's id is `uuid5(sender principal, tenant, context_id, message_id)`, so a repeat hits the primary key and returns the first task, with no lookup, no race and no quota cost. A follow-up is checked against the task's own history. A `context_id` that already belongs to another (sender, card) pair is `TaskNotFound`.
- Follow-ups (6.4): only the originator may send one (spec 5.2 says "a sender may continue a task it can see"; the recipient answers with `respond`). `SUBMITTED` stays `SUBMITTED`; `WORKING` gets an unread counter (`coord.unread`) that `respond` clears; a real `INPUT_REQUIRED` goes back to `SUBMITTED` and the offer count resets. A held or finished task gives -32004.

Offers (6.3): `inbox` records one offer per task it lists: `offer_count` goes up (capped at `A2A_REOFFER_MAX`), `last_offered_at` is now, and `next_offer_at = last_offered_at + A2A_REOFFER_AFTER_S * 3^(n-1)`. After the cap, `has_wake_pending` is false for that task; it stays in `inbox` and in `pending_count`. After the cap the window keeps its last length, so a claimed card task can still fall back to the queue.

Quotas (3.3.2): 20 held tasks per peer (from the database, `Retry-After` 60 [design]) and 10 `SendMessage` per minute per peer (in memory, sliding window). Both give `QuotaExceeded` (429). A repeat of a `message_id` costs none.

TTL sweeps (1.5, 6.2): an unconfirmed `SUBMITTED` task past `expires_at` goes to `REJECTED` (`expired`); a held one to `REJECTED` (`quarantine_expired`); a `WORKING` task whose session ended more than `A2A_WORKING_TTL_H` ago to `FAILED`; a session with no call for `A2A_SESSION_IDLE_TTL_H` is marked ended. A real `INPUT_REQUIRED` question has no expiry [design]. A release restarts the `SUBMITTED` TTL from the release time [design].

## 4. Not built here

- The handle-guess counter (spec 5.2, R1, R10, X3): built with S2-LISTEN. The constant "not available" refusal it will count is the `_admit_remote` path in `service.py`.
- The blocking wait of `SendMessage` (D22) and `a2a_wait`: bindings over `get_task`; they need a change notifier that does not exist yet.
- Session registration, binding and `/sessions` (S1-ID), the listener table and the wake endpoint (S1-WAKE), the cards-file load (S1-AUTH), the per-client-IP limit (the public listener), and push.

## 5. Tests

`tests/test_service_states.py` (the table, all 256 triples against the real state machine), `test_service_send.py`, `test_service_flow.py`, `test_service_sweeps.py`, `test_service_property.py` (random sequences with a fake clock), and the atomic-audit tests in `tests/test_audit.py`. All run against the pinned Postgres image.
