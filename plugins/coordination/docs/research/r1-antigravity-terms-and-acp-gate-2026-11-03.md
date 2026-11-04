# R1: Antigravity terms, third-party wrapping, and the Phase 4 ACP gate

Author: Claude Code (macp), 2026-11-03. Read-only research. Labels: **official** (text of a Google page, read via a fetch tool that summarises pages, so quotes are as returned by the tool), **forum** (Google AI Developers Forum posts; authorship and staff status not shown on the pages), **third-party** (blogs, news), **unverified**.

## 1. Bottom line

- Google's own FAQ says third-party software, **naming Claude Code**, may not be used with an Antigravity login, and says wrapping `agy` inside third-party coding agents is not supported under consumer plans. That is official text, not a forum opinion.
- Phase 4 condition 1 (a terms-compliant way for Antigravity to speak ACP) is therefore **not met and not close** for a consumer plan. The only "yes" answers are forum replies that conflict with the FAQ.
- This also touches the user's standing rule (skip options whose terms restrict Claude Code) and the bridge as it runs today. See section 5.

## 2. Official text (read from antigravity.google)

- Additional Terms, item 6 (no heading of its own): "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement." Penalty: "Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts." The page carries no last-updated date. Headless use and subscription quota are not mentioned there.
- FAQ (antigravity.google/docs/faq), entry 1, "Why can't I use third-party software (such as Claude Code, OpenClaw, or OpenCode) with my Antigravity login?": "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service." It adds that this can lead to suspension or termination and recommends "a Gemini Enterprise or Google AI Studio API key" for third-party coding agents with Gemini.
- FAQ, entry 2, "Can I use Antigravity CLI headless mode in third-party coding agents or automate account switching?": "Antigravity CLI headless mode (`agy -p`) is intended for direct scripting and CI workflows". "Wrapping `agy` inside third-party coding agents or applications" is not supported under consumer plans; automating account rotation is also unsupported. The entry covers consumer plans only; enterprise and API-key setups are not addressed.
- Not read: the full FAQ page beyond the entries above (the tool returned selected entries), and any enterprise terms.

## 3. Forum replies (all unverified as official; no staff badge shown on any page)

- 2026-07-23, the author of the `agy-acp` bridge asked whether launching the user's own `agy` in a PTY for ACP editors is compliant. Reply 2026-09-16 (Rebbanpalli_Naveen): "Yes, your described pattern is compliant" if the unmodified binary runs as a single-user child process and tokens are not extracted or forwarded; it also says "Connecting directly to the official ACP server binary is the officially supported path". I found no link to such an official ACP server in the pages I read (unverified).
- 2026-09-28 headless script launched by another AI tool: reply (Ambati_Rajendra) says running `agy` locally, even headless, under your own account is compliant.
- 2026-09-29 Claude Code launching `agy.exe`: reply (chunduriv) says yes under conditions (own login, no token extraction, individual use). The follow-up asking whether that is Google's official reading, noting that the FAQ names Claude Code, has no answer (2026-10-01).
- 2026-09-24 local Codex MCP bridge to Antigravity (Ambati_Rajendra): says bridges using subscription credentials fall under item 6, Sidecars cannot be external bridges, Pro allowances cannot be used for custom programmatic orchestration, and polling local transcripts is restricted.
- 2026-07-20 and 2026-10-16 thread on invoking `agy --print` from a developer tool: replies are community opinions; the question about launching the official CLI from another program has no official answer on the page.
- Same posters answer opposite ways on neighbouring questions, so the forum cannot settle the point.

## 4. Third-party reporting (not official)

- Reports of account restrictions for people using third-party tools with Antigravity OAuth (OpenClaw, omp, Pi agent users); one report says affected accounts were later unbanned. Enforcement against a launcher of the official CLI is not shown in anything I read.

## 5. Consequences for the bridge plan (opinion, for the planner and the user)

- **Phase 4 condition 1 is blocked by Google's own FAQ** for a consumer plan. Use an API-key or enterprise path (the FAQ's own suggestion) or do not plan an agy-over-ACP carrier. Community adapters (`agy-acp`, `agy-agent-acp`) are the "wrapping" the FAQ calls unsupported.
- **The current file channel does not invoke agy from Claude Code.** Each tool runs in its own session on the user's own login and exchanges text files. Nothing I read says that two separate products exchanging files breaks item 6, but the FAQ's first entry names Claude Code, so the user should decide whether he is comfortable running both against one Google login. I cannot rule on it.
- **Anything that makes Claude Code launch or drive `agy`** (phone-a-friend style relays, an ACP wrapper, a router that spawns `agy -p`) sits on the FAQ's "not supported" line for consumer plans. That supports the earlier decision to drop phone-a-friend and the "no one-shot spawns" requirement, but now with an official reason.
- **User rule check:** the standing rule says to skip options whose terms restrict Anthropic or Claude Code. This restriction is on using Claude Code with an Antigravity *login*, which applies to Antigravity as a service. Whether the rule should also cover "Antigravity itself" is a decision for the user.
- Recommended wording for the plan: Phase 4 condition 1 becomes "an official, written, terms-compliant path exists (API key or enterprise), quoted from Google". Remove community adapters from consideration.

## 6. Not done / limits

- I did not read Google's plans documentation, enterprise terms, or the "Antigravity ACP Server" the forum reply mentions (no link found).
- Page dates: the forum posts are dated September to October 2026; the FAQ and terms pages show no date. Terms may have changed since, so re-read the live pages before any decision.

## 7. Sources

- https://antigravity.google/terms?hl=en
- https://antigravity.google/docs/faq
- https://discuss.ai.google.dev/t/clarification-request-is-local-ipc-pty-wrapping-of-agy-cli-for-open-standard-editor-bridges-e-g-acp-tos-compliant/175905
- https://discuss.ai.google.dev/t/is-invoking-the-official-antigravity-cli-agy-print-from-a-third-party-developer-tool-an-acceptable-use/175462
- https://discuss.ai.google.dev/t/tos-clarification-may-a-local-codex-mcp-bridge-use-agentapi-with-antigravity/184590
- https://discuss.ai.google.dev/t/headless-agy-runs-launched-by-a-script-from-another-ai-coding-tool-within-the-additional-terms/185494
- https://discuss.ai.google.dev/t/is-invoking-the-official-agy-cli-from-a-local-ai-coding-assistant-allowed-on-an-individual-google-ai-account/185992
