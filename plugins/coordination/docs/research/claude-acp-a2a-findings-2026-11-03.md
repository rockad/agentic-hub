# ACP and A2A findings for a symmetric live-session bridge (task C4, research only)

Author: Claude Code (macp), 2026-11-03. Research only; nothing installed or run. Evidence labels: **verified** (I read the source myself), **reported** (a search result or a peer said so; not read in full by me), **unverified** (no source found).

## 1. What ACP is for, from its own docs (verified, ~/projects/agent-client-protocol, HEAD dc011f0)

- Architecture page: "the editor boots the agent sub-process on demand, and all communication happens over stdin/stdout"; "ACP works when you're using a code editor to talk to a model you trust". A client drives an agent. It is not a peer-to-peer protocol.
- Remote transport (Streamable HTTP and WebSocket) is an RFD proposal; a Transports Working Group was just formed. Today ACP is stdio only.
- Subagent sessions (an agent exposing its own subagents) and proxy chains are RFDs, not standard.
- Protocol methods in use include `session/new`, `session/load`, `session/resume` (RFD), `session/prompt`, `session/cancel`, `session/fork` (RFD).

## 2. Per host (the three live-session candidates)

| host | ACP status | label | consequence |
| --- | --- | --- | --- |
| OpenCode | Official `opencode acp`: an ACP agent a client launches as a child process over stdio, ACP v1, serves several ACP sessions (create, list, load, resume, fork, close, cancel). It runs headless; a feature request notes the TUI's session management is not exposed over ACP. | reported (opencode.ai docs and GitHub issue 8931 via search; not read in full) | An ACP session is a different thing from the TUI session on screen. |
| Claude Code | Official docs: no native ACP server mode found. Community and Zed adapters exist (Zed's `claude-agent-acp`, Apache-2.0, built on the Agent SDK, its own sessions: new, list, resume, close, prompt, cancel, fork). One Neovim config shows a `claude --acp` flag; not confirmed by any official source. | reported / unverified (flag) | An ACP-hosted Claude session is a separate conversation, not the interactive session the user works in. |
| Antigravity (agy) | No official ACP support found; a third-party guide says agy is closed source and does not support ACP. Community adapters exist (`agy-acp`, `agy-agent-acp`, `antigravity-acp-sdk`) and Zed's ACP registry lists "Antigravity ACP". The adapters depend on `--output-format=stream-json`, which one README says is undocumented and absent from `agy --help`. | reported | Support is community-built on an undocumented output mode. |

- **Terms-of-service question (reported):** a post on Google's AI developer forum asks whether wrapping the agy CLI through local IPC or a pty for open-standard editor bridges such as ACP is compliant with Google's terms; one adapter repo carries a ToS risk warning. I found no official answer. Under the user's standing rule (skip options whose terms restrict the use), this is an open flag for any agy-over-ACP design, to be resolved by the user or by an official Google statement before any plan relies on it.

## 3. What this means for "live conversation-to-conversation"

- ACP's model is: a client starts and drives agent sessions. In all three cases the ACP session is a separate, headless session; none of the sources shows an ACP connection to the interactive session a user is typing in.
- Two peers (Claude Code and Antigravity) would each have to be both ACP agent and ACP client, or sit behind a router that is the client of both. The router is then the coordinator, which conflicts with "no master, no dependent" unless it is deliberately neutral.
- I found no source showing two interactive sessions exchanging turns over ACP (unverified, searched).

## 4. A2A (verified, ~/projects/A2A, spec 1.0.1)

- Task delegation between independent agent services over HTTP; Agent Card for discovery; task states SUBMITTED, WORKING, INPUT_REQUIRED, AUTH_REQUIRED, COMPLETED, CANCELED, FAILED, REJECTED. No concept of local resource slots or file leases.
- Fit for a single host is weak; the state vocabulary and the card idea are reusable as principles (the user's stated preference was "ACP with A2A in mind (principles)", relayed).

## 5. Recommendation to the planner (Antigravity), opinion

- Carry the A2A vocabulary and agent-card-style identity into contracts now; keep the current file channel as the transport.
- Treat ACP as a later, optional carrier. Entry conditions: (a) an official or compliant way for agy to speak ACP, with the terms question answered; (b) the remote transport RFD standardised; (c) evidence that a live interactive session, not a fresh adapter session, can take part.
- Do not plan any step that depends on an undocumented agy output mode.

## 6. Sources

- ACP docs and RFDs: ~/projects/agent-client-protocol (docs/get-started/architecture.mdx, docs/rfds/*, docs/updates.mdx).
- A2A: ~/projects/A2A (specification/a2a.proto, CHANGELOG.md).
- Zed claude-agent-acp: https://github.com/zed-industries/claude-agent-acp (read via fetch).
- ACP agents list: https://agentclientprotocol.com/overview/agents (read via fetch; Claude, Gemini CLI, OpenCode listed; Antigravity absent from that page).
- OpenCode ACP docs: https://opencode.ai/v2/docs/cli/acp/ and issue https://github.com/anomalyco/opencode/issues/8931 (seen in search results).
- agy adapters: https://github.com/shindgew/agy-acp, https://github.com/jameslunardi/agy-agent-acp, https://zed.dev/acp/agent/antigravity-acp (seen in search results).
- Terms question: https://discuss.ai.google.dev/t/clarification-request-is-local-ipc-pty-wrapping-of-agy-cli-for-open-standard-editor-bridges-e-g-acp-tos-compliant/175905 (seen in search results; not opened).
