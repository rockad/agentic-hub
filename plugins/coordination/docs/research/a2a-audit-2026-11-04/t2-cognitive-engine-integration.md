# T2: cognitive-engine session reply (2026-11-04), read-only, from origin refs, PR #13 not read

Verdict: fit as an EXTERNAL peer, never inside core.

1. Touch points
- harness2 sweep lifecycle maps to A2A states: plan=submitted; awaiting typed approval=input-required; sessions=working; sweep ok/fail=completed/failed; approval gate refusal=rejected; human Ctrl-C=canceled (teardown non-interruptible). Refs: packages/harness2/README.md ~468 (ExecutionGrant), session_runner.py, sbx_session.py (SweepBudget hard gate), audit.jsonl + report.json.
- Jev dispatch (packages/jev/src/tools/dispatch.ts): stateless routing, no task states; a server could call it as a tool.
- Do NOT map slot table, approval gate, sbx policy (enforcement, not coordination).
- Agent cards belong to the long-lived harness sessions (Claude Code, Antigravity), not cognitive-engine's contained short-lived sessions.

2. Role: client only, one-way status publisher
- After each sweep, stage1 posts task state + pointer to report.json (path + run id; never prompts or model text). Never receives tasks.
- Not a provider: `stage1 run` requires a human typing an approval phrase on a controlling terminal; gate refuses pipes/scripts/agent envs. A remote "submit sweep" tool would bypass that. Do not add one.
- Location: separate optional adapter package on the existing adapter seam (like adapters/claude, adapters/antigravity); core stays free of network clients. Unverified: whether deterministic-core rule is written beyond RFC 001; check before naming a path.

3. Overlaps
- Reuse, do not duplicate: audit.jsonl (run_scope ids) as source of truth, approval flow, SweepBudget / channel-profile caps / ExecutionGrant. Server must not become a second approval path.
- No message bus or session registry in the repo; only ~/.agents (channel file, session-registry.json, tracker) -> what bridge v2 replaces. RFC 004/006, checks/experiments plans define no ledger/bus/registry.
- R-18: sessions_summary.denied_requests counts path denials only; model-pin denials in results/*/metrics.json. Never show "denied = 0" from that field.

4. Deployment
- No compose stack in cognitive-engine (only packages/harness2/containers/proposer/Dockerfile). agentic-hub compose unverified from there.
- Ports taken/reserved: 8100 (legacy Lookup, native Lookup cutover), 8101 (native Lookup staging), 8105 (Memory staging), 8110 (Recall), 11434 (Ollama). Pick outside 8100-8110 and 11434.
- No volume convention; stage-1 state at ~/.local/state/cognitive-engine/harness2-stage1; SQLite volume would be new.
- sbx: sandboxes reach exactly one host:port via sandbox-scoped allow rule; the coordination server must NOT be on that allow list. Sessions never reach it.

5. Security (public exposure)
- Never expose: anything that starts a sweep or grants approval; credentials (OpenRouter key, RFC 006 proxy credential route, Claude/agy tokens); run dirs (prompts, model text), transcripts; Jev config tools (jev_set_mode).
- Model-written code must never reach it (internal-only network + filtering proxy).
- If tokens ever sit behind it: proxy-class surface; header smuggling, request splitting, SSRF (RFC 006 section 3); fuzz it.
- Wake via Stop hook OK for status; must never carry an approval or a command.
- Attribution: check transcript message.model before naming a reviewer model; Fable reportedly not in subscription (launch with model fable silently served by Sonnet).
