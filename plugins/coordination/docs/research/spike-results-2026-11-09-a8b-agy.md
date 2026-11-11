# SP2 A8b Results: User-Level Antigravity Plugin MCP Tools, 2026-11-09

Branch note: first written on the `docs/adoption-review-followups` branch, since merged as PR #19 (see the [adoption review](https://github.com/rockad/cognitive-engine/blob/main/docs/adoption-review-2026-11.md)). Spike code and logs stay in `~/scratch/a2a-spikes/` and are never merged.

Labels:
- **verified**: observed directly in a file, wire capture, transcript, or log in this session
- **reported**: stated by the helper, read in documentation, or stated by the user without direct independent re-observation
- **unverified**: not demonstrated or not tested

Run facts:
- Antigravity CLI version: **1.5.3** (verified, `agy --version`).
- Shell & OS: Linux 6.6 WSL2 x86_64 (`<workstation>`).
- Workspace: `~/scratch/a2a-spikes/sp2-agy-a8b`.
- Stub server: `http://127.0.0.1:18120/mcp`, Python 3.12 (`stub.py`).
- Stub log: `~/scratch/a2a-spikes/runlogs/a8b/stub-a8b.jsonl`.
- Candidate plugin: `~/.gemini/config/plugins/coordination` (`mcp_config.json`, server `a2a-stub-gemini`, header `X-Spike-Via: gemini`).
- Credential: `spike-token` only.
- Known environment delay: `lookup` and `recall` timed out at startup in every agy session (`MCP: 2 server(s) still connecting after 2m0s`), delaying MCP startup by ~2 minutes (verified in `cli.log`, reported out of scope by user).

---

## 1. Question & Hypotheses (H1 to H4)

**Core Question:**
Do user-level agy plugin tools run when signed in, and why did they fail on 2026-11-08 with `tool a2a_hello is not enabled for server coordination_a2a-stub-gemini`?

### Hypotheses & Verdicts

- **H1 (Sign-in warning was transient/lapsed token; warm signed-in start runs tools):**
  - **Verdict:** **Refuted as to the warning; Supported as to tools running.**
  - **Evidence:** The startup warning `Not reloading plugin MCP servers: cannot get the signed-in user: error getting token source: You are not logged into Antigravity` appeared in every single startup log (verified, 11 logs examined), occurring within the first 150 ms before keyring token hydration. It is completely benign and does not prevent MCP server connections or tool calls. Warm and cold signed-in sessions both executed tools cleanly.
- **H2 (Plugin needs explicit `config.json` entry via `agy plugin enable` or `agy plugin install`):**
  - **Verdict:** **Refuted.**
  - **Evidence:** Runs A3 and A4 ran tools successfully with zero entries in `~/.gemini/config/config.json` (verified in `stub-a8b.jsonl` and `cli-20261109_123002.log` / `cli-20261109_180127.log`). Unlisted plugins in `~/.gemini/config/plugins/` default to enabled.
- **H3 (`.mcp.json` works where native `mcp_config.json` does not, or reverse):**
  - **Verdict:** **Partially Supported (for native) / Untested (for dotmcp).**
  - **Evidence:** Native `mcp_config.json` was proven to work reliably at user level (runs A, A2, A3, A4). Variant B (`.mcp.json`) was not run because native `mcp_config.json` succeeded immediately on Run A.
- **H4 (Tools never enabled on first start/copy; require one subsequent restart):**
  - **Verdict:** **Refuted.**
  - **Evidence:** Run A4 performed a completely cold first start after wiping all caches and copying the plugin directory fresh; tools executed successfully on the first run without requiring a secondary restart.

---

## 2. Per-Run Results (Part 1, A, A2, A3, A4, Shadow)

### Part 1: Read-Only Questionnaire (No Files Placed)
- **Setup:** Fresh agy session in `~/scratch/a2a-spikes/sp2-agy-a8b` answering read-only questions from `a8b-operator-brief.md`.
- **Log lines (verified, `cli-20261108_225446.log`):**
  - `I1109 11:02:46.821682 ... token refreshed, new expiry=2026-11-09 12:02:45.821617462 +0200`
  - `I1109 11:31:43.278098 ... Full redraw completed (RerenderAll) for conversation 39d358e6-0da9-401e-aa97-53fff652c376`
  - `I1109 12:00:25.519179 ... CLI program exited, shutting down`
- **Pass / Fail:** **PASS** (baseline captured; answers provided; no files touched).

### Run A: Candidate Present + `agy plugin enable coordination`
- **Setup:** Candidate copied to `~/.gemini/config/plugins/coordination`; user ran `agy plugin enable coordination` at 12:00:39 local; `config.json` had `plugins.coordination.enabled=true`.
- **Observed behavior (verified, `stub-a8b.jsonl`, `cli-20261109_120048.log`):**
  - Connection 1 at `10:00:39.416 UTC` (12:00:39 local): `agy plugin enable` executed in shell, initialized MCP (`initialize` 200, session `31a52c55`, `tools/list` 200 via `gemini`).
  - Connection 2 at `10:01:00.098 UTC` (12:01:00 local): Interactive agy session (`cli-20261109_120048.log`, PID 1210279) initialized MCP (`initialize` 200, session `2479c5a1`, `tools/list` 200 via `gemini`).
  - Tool calls at `10:02:06 UTC`: `a2a_hello` called with handle `op-native`, bound key `10c47f73` (`conversation`), followed by `a2a_inbox` at `10:02:09 UTC` (both 200 OK via `gemini`).
- **Pass / Fail:** **PASS**.

### Run A2: Warm Restart (Candidate Present + `config.json` Entry Kept)
- **Setup:** Fresh agy started after quitting Run A.
- **Observed behavior (verified, `stub-a8b.jsonl`, `cli-20261109_121455.log`):**
  - Connect at `10:15:06.962 UTC`: `initialize` 200, session `5484d10f` via `gemini`.
  - Tool calls at `10:16:21 UTC`: `a2a_hello` called with handle `op-native2`, bound key `b8206989`, followed by `a2a_inbox` at `10:16:27 UTC` (both 200 OK via `gemini`).
- **Pass / Fail:** **PASS**.

### Run A3: `config.json` Entry Removed (Unlisted Default Enablement)
- **Setup:** `~/.gemini/config/config.json` restored to backup (no entry for `coordination`); plugin directory kept in place; fresh agy started.
- **Observed behavior (verified, `stub-a8b.jsonl`, `cli-20261109_123002.log`):**
  - Connect at `10:30:13.406 UTC`: `initialize` 200, session `2e66aa64` via `gemini`.
  - Tool calls at `10:31:01 UTC`: `a2a_hello` called with handle `op-native3`, bound key `70dd60f3`, followed by `a2a_inbox` at `10:31:03 UTC` (both 200 OK via `gemini`).
- **Pass / Fail:** **PASS** (proves explicit `config.json` enablement is not required).

### Run A4: Cold First Load (Caches Wiped, Fresh Copy, No `config.json` Entry)
- **Setup:** Plugin directory and all `~/.gemini/antigravity-cli/mcp/coordination_a2a-stub-*` caches deleted; plugin recopied fresh from staging; no `config.json` entry; fresh agy started.
- **Observed behavior (verified, `stub-a8b.jsonl`, `cli-20261109_180127.log`):**
  - Connect at `16:01:39.294 UTC`: `initialize` 200, session `3405af85` via `gemini`.
  - Tool calls at `16:03:04 UTC`: `a2a_hello` called with handle `op-native4`, bound key `f47083e6`, followed by `a2a_inbox` at `16:03:10 UTC` (both 200 OK via `gemini`).
- **Pass / Fail:** **PASS** (proves clean cold load works on first start).

### Run Shadow: User-Level + Same-Named Workspace Plugin
- **Setup:** User-level plugin `~/.gemini/config/plugins/coordination` (`a2a-stub-gemini`) kept; workspace plugin `.agents/plugins/coordination` (`a2a-stub-ws`) added back into `~/scratch/a2a-spikes/sp2-agy-a8b`.
- **Observed behavior (verified, `stub-a8b.jsonl`, `cli-20261109_180627.log`, transcript `2facd2be`):**
  - `gemini` connected at `16:06:38.486 UTC` (port 44253, session `e0dfecf6`).
  - `ws` connected at `16:08:27.220 UTC` (port 44253, session `51f8a5d2`).
  - Tool calls executed at `16:08:40 UTC` with handle `op-shadow`: routed to `coordination_a2a-stub-ws`, bound key `2facd2be` (`a2a_hello` 200, `a2a_inbox` 200 via `ws`).
  - Calling `coordination_a2a-stub-gemini` returned error: `tool a2a_hello is not enabled for server coordination_a2a-stub-gemini`.
- **Pass / Fail:** **PASS (Observed & Recorded)**.

---

## 3. The Shadow Run in Detail

In the shadow run, both candidate plugins shared the directory name `coordination`:
- User-level: `~/.gemini/config/plugins/coordination` (`a2a-stub-gemini`, `X-Spike-Via: gemini`)
- Workspace-level: `~/scratch/a2a-spikes/sp2-agy-a8b/.agents/plugins/coordination` (`a2a-stub-ws`, `X-Spike-Via: ws`)

### Wire & Execution Sequence (verified)
- At `16:06:38 UTC`: The user-level server (`coordination_a2a-stub-gemini`) connected to the stub, completed `initialize` (200), and fetched `tools/list` (200).
- At `16:08:27 UTC`: The workspace-level server (`coordination_a2a-stub-ws`) connected to the stub, completed `initialize` (200), and fetched `tools/list` (200). Both schema caches were written to `~/.gemini/antigravity-cli/mcp/`.
- At `16:08:40 UTC`: When the model executed tools for handle `op-shadow`:
  - `coordination_a2a-stub-ws` tools were active and callable: `a2a_hello` bound to `2facd2be` (200 OK), and `a2a_inbox` returned pending messages (200 OK).
  - `coordination_a2a-stub-gemini` tool calls failed with:
    `tool a2a_hello is not enabled for server coordination_a2a-stub-gemini`

### Comparison with 2026-11-08 (partly unexplained)
- On **2026-11-08** (SP2 Step 3, [A8](spike-results-2026-11-08-sp2-agy.md)), the user-level plugin connected (`gemini`) but its tools failed with `tool a2a_hello is not enabled for server coordination_a2a-stub-gemini`, and the workspace server (`ws`) did not appear at all (`coordination_a2a-stub-ws` not found). Neither server had callable tools.
- On **2026-11-09** (A8b shadow run), **both** servers connected over HTTP, the workspace server (`ws`) had the callable tools, and the user-level server (`gemini`) failed with the same `not enabled` error.
- **Consistent across both runs (verified):** whenever a same-named workspace plugin was present, the user-level server's tools were "not enabled". Without a workspace plugin of that name (A, A2, A3, A4) they ran.
- **Differs between runs (unexplained):** whether the workspace server loaded at all (absent on 11-08, connected 2 minutes after the user-level one and callable on 11-09). Which plugin wins is therefore not reliable. Treat precedence as unverified and never rely on it.

---

## 4. Decision Consequences for the Installer

- **User-Level Native `mcp_config.json` Works:**
  - Placing an unmanaged plugin directory with `mcp_config.json` under `~/.gemini/config/plugins/<name>/` works natively without requiring any `agy plugin enable` step, `config.json` entry, or `agy plugin install` command.
- **Unique Plugin Names Required:**
  - The coordination plugin name must be unique across user and workspace scopes because with a same-named workspace plugin present the user-level tools were "not enabled" in both observed runs (2026-11-08 and the shadow run).
- **Active Health Check Required:**
  - Checking MCP server connectivity alone is insufficient: in both disabled runs, `initialize` and `tools/list` returned 200 OK on the wire while session tools remained disabled. The installer's post-install health check must execute an actual tool call (`a2a_hello`).
- **Untested Items:**
  - `.mcp.json` at user level and `agy plugin install` remain untested.

---

## 5. Sign-in Findings

- **Benign Startup Warning:**
  - The warning `W... rpcs_plugin_auth.go:105] Not reloading plugin MCP servers: cannot get the signed-in user: error getting token source: You are not logged into Antigravity` is harmless. It is logged during the first 150 ms of every agy session before keyring token hydration.
- **Keyring Token Expiry:**
  - In each run, `cli.log` recorded `keyringAuth: loaded token, expiry=...` with an expiration timestamp approximately one hour ahead of launch time (verified).
- **Dependency on Live Sign-in:**
  - **Unverified**. All successful tool calls occurred while authenticated via keyring OAuth (`samrockad@gmail.com`). Whether unauthenticated or offline sessions can execute local/loopback MCP tools was not tested in this run.

---

## 6. Corrections to Earlier Answers (Retractions)

In accordance with empirical evidence across runs A3, A4, and Shadow, the following earlier assertions are retracted:

- **Retraction 1 (Need for `config.json` enablement):**
  - *Previous assertion:* Tools were disabled because the plugin was not explicitly registered via `agy plugin enable` or in `config.json`.
  - *Correction:* **Refuted**. Runs A3 and A4 proved that an unlisted plugin in `~/.gemini/config/plugins/` is enabled by default and executes tools without any entry in `config.json`.
- **Retraction 2 (Attribution of Shadow failure):**
  - *Previous assertion:* In the shadow run, `coordination_a2a-stub-gemini` tools failed due to missing enablement in `config.json`.
  - *Correction:* **Refuted**. The failure was caused by the presence of the colliding same-named workspace plugin, not `config.json`.
- **Retraction 3 (User-level always shadows workspace):**
  - *Previous assertion:* User-level plugins always shadow and hide workspace plugins.
  - *Correction:* **Retracted**. In the shadow run, the workspace plugin won the tool execution rights while the user-level plugin tools were disabled. Which scope wins is **unverified**: on 2026-11-08 neither had callable tools and the workspace server did not load.
- **Retraction 4 (Exclusivity of `mcp_config.json`):**
  - *Previous assertion:* Runtime plugin discovery strictly expects `mcp_config.json`.
  - *Correction:* Native `mcp_config.json` is confirmed working at user level, but `.mcp.json` remains untested.
- **Retraction 5 (`coordination_a2a-stub-ws` schema cache listing):**
  - *Previous assertion:* `coordination_a2a-stub-ws` was not listed in `~/.gemini/antigravity-cli/mcp/`.
  - *Correction:* Both `coordination_a2a-stub-gemini` and `coordination_a2a-stub-ws` schema directories were present on disk.

---

## 7. Touched Files & Restore Check

- **Checksum verification against `sha256.before` (verified):**
  - `~/.gemini/config/config.json`: `85e401bb...` (matches `sha256.before`)
  - `~/.gemini/config/hooks.json`: `fe75d19e...` (matches `sha256.before`)
  - `~/.gemini/config/mcp_config.json`: `9ec82f01...` (matches `sha256.before`)
- **Plugin removals (verified):**
  - `~/.gemini/config/plugins/coordination` removed.
  - Workspace `.agents/plugins/coordination` in `sp2-agy-a8b` removed.
  - Schema caches `~/.gemini/antigravity-cli/mcp/coordination_a2a-stub-*` removed.
- **Stub status (verified):**
  - Stub process stopped (port `:18120` closed).
- **Host settings note:**
  - `~/scratch/a2a-spikes/sp2-agy-a8b` remains in `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json` (left for user cleanup).

---

## 8. Cleanup Confirmation

- No candidate plugin files remain in `~/.gemini/config/plugins/` or `~/.agents/`.
- `config.json` is byte-identical to pre-test baseline.
- `chezmoi diff`: empty when the helper ran it on 2026-11-09 after the runs (verified). The SP2 baseline `runlogs/chezmoi-diff.baseline` held a 211-line diff, so the drift it recorded has since been resolved by someone other than this spike; it is not "unchanged".
- Stub daemon is terminated.
