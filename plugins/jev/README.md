# TypeSafe Jev Plugin (Jev V2 - System 1 AI Coprocessor)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bundler-bun-478636?logo=bun)](https://bun.sh/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Status](https://img.shields.io/badge/Status-Stable-v2.3.0-brightgreen)](https://github.com/rockad/agentic-hub)

**Path:** `agentic-hub/plugins/jev`  
**Version:** 2.3.0  
**Runtime:** Bun / Node (ESM)  
**Dependencies:** TypeScript, Zod, OpenRouter SDK, Agent Framework Adapters

---

## 📖 Overview

The **TypeSafe Jev Plugin** (`plugins/jev`) is the **System 1 AI Coprocessor** for the `agentic-hub` ecosystem. Named after Daniel Kahneman's "System 1" (fast, intuitive, low-effort thinking), Jev handles the high-volume, low-stakes cognitive load of an AI agent loop so your primary agent (System 2) can focus on complex reasoning.

Jev acts as three things in a single layer:
1. **Probabilistic Decision Coprocessor:** Analyzes tasks and routes work to the most cost-effective execution tier before any token spend occurs.
2. **Free-Tier Offloading Engine:** Diverts boilerplate work (summaries, linting, formatting, commits) to free-tier models (`openrouter/free`), resulting in **$0.00 cost** and **0 quota consumption** for routine operations.
3. **Quality Gate Validator:** Runs sub-second micro-evaluations (`jev_judge`) to verify output quality before it reaches the user or is committed to source control.

**Primary Value Proposition:** It protects your paid subscription quota (specifically **Google AI Pro Gemini**), preventing wasted credits on routine tasks while accelerating agent loops through parallelized, cheaper execution.

---

## ✨ Key Features

### ⚙️ Operating Modes
Control the coprocessor's behavior via a toggleable state machine, persisted across sessions in `~/.config/jev/config.json`:

| Mode | Behavior | Use Case |
| :--- | :--- | :--- |
| `OFF` *(default)* | **Disabled.** No offloading, no dispatching, zero token overhead. Direct pass-through to primary model. | Default unconfigured state; emergency high-complexity tasks. |
| `ON-DEMAND` | **Manual Trigger.** Passive coprocessor; engages only when explicitly invoked or requested. | Auditing, debugging, or selective manual control over costs. |
| `ON` | **Always Active.** Jev automatically dispatches eligible tasks, offloads free-tier work, and guards quotas. | Daily development workflows; automatic quota protection and offloading. |

> [!IMPORTANT]
> **Default OFF (Opt-In Intent):** Jev is strictly **OFF by default** when unconfigured. No background decisions or external network calls occur until explicitly enabled by the user.
>
> **Migration Notice:** `mode.json` is completely deprecated and ignored, and can be safely deleted. `~/.config/jev/config.json` is the single canonical configuration store for global defaults (`defaults.mode`) and per-harness overrides (`harnesses.<harness>.mode`).
>
> **Shell Script Retirement:** `scripts/jev-mode` is retired. Mode switching and inspection are handled directly via the `/jev` slash command / skill inside agent harnesses (`/jev on`, `/jev on-demand`, `/jev off`, `/jev status`) and the `jev_set_mode` / `jev_get_mode` MCP tools.

### 🚀 Pre-flight Dispatch (`jev_dispatch` & `jev_batch_dispatch`)
Before a task hits the primary model, `jev_dispatch` runs a calibrated inference on the task metadata. It produces a **probability distribution** over:
- **Subagents:** Which specialized helper should handle the task?
- **Execution Tiers:** `openrouter_free`, `flash_lite`, `flash`, or `pro`.
- **Session Model Ceiling Clamping:** Dynamically clamps subagent recommendations $\le$ active session model tier (`Gemini 3.8 Flash`), preventing over-eager `pro` recommendations for routine CLI porting.
- **Scaffolding Detection:** Automatically detects package/crate creation tasks and flags `scaffoldFirst: true` to trigger Tier 0 `$0.00` mechanical boilerplate generation.
- **Dynamic Semantic Batch Dispatch (`jev_batch_dispatch`):** Decomposes multi-task roadmaps or phases into parallel and sequential execution waves, enforces dependency order, and applies safety concurrency caps ($\le 10$ simultaneous free workers). Routes tasks dynamically using the OpenRouter Decisions API (`~typesafe/jev-latest`), with automatic fallback to local token and description keyword scoring if offline or timed out. Configurable via `routing.strategy` (`"router"` | `"keyword"`) in `~/.config/jev/config.json`.

This prevents expensive models from processing routine formatting, simple search requests, or bounded ports.

### 🔍 Per-Harness Dynamic Subagent Discovery
Jev discovers candidate subagents dynamically from the filesystem without hardcoded persona assumptions:
- **Antigravity:** `<workspace>/.agents/agents/`
- **Claude Code:** `<workspace>/.claude/agents/`
- **OpenCode:** `<workspace>/.opencode/agents/`
- **Universal Shared Global:** `~/.agents/agents/` across all harnesses

Local workspace agents take precedence over universal shared agents with the same identifier, enabling clean per-project specialization while sharing common subagents across machines.

### 🆓 Free-Tier Offloading
Jev intercepts specific workload patterns and reroutes them to `openrouter/free` endpoints. This guarantees **$0.00 spend** and **0 quota usage** for:
- File/Code **Summaries**
- **Markdown** formatting and refactoring
- Standard **Git Commits** (`commit.sh`)
- Boilerplate scaffolding (`Cargo.toml`, `package.json`, CLI `clap` structs)
- Unit test generation

**Implementation:**
- `jev_execute_free`: Raw offloading wrapper with timeout handling.
- `jev_agent_free`: Specialized handler for agent-assistant interactions.
- `jev_execute_free_guarded`: Offloading wrapped in a retry + fallback policy to ensure failure never breaks the loop.

### 📝 Automated Semantic Commits
Integrates directly with the commit pipeline via `commit.sh` (or `scripts/commit.ts`):
1. `scripts/commit.ts` captures the staged diff.
2. `jev_dispatch` decides if the commit message needs an LLM.
3. `jev_agent_free` generates a conventional commit message.
4. `jev_judge` validates the message against the diff semantically.
5. Commit is finalized.

### 🛡️ Three-Tier Resilient Quality Gates (`jev_judge`)
A micro-evaluation engine designed for speed and bulletproof fault tolerance:
- **Tier 1 (Fast Bernoulli Decision):** OpenRouter Decisions API (`~typesafe/jev-latest` on `/api/alpha/decisions`, ~350ms).
- **Tier 2 (Chat Router Fallback):** OpenRouter chat completions with strict JSON Schema (`typesafe/jev-router`).
- **Tier 3 (Local Deterministic Judge):** If OpenRouter returns `404` (*"No models satisfy the decisions policy"*), network timeout, or connection failure, Jev automatically evaluates diff syntax, git merge conflict markers (`<<<<<<<`), compilation exit codes (`exit code: 1`), and non-empty assertions locally without throwing unhandled exceptions.

### 📊 Quota & Model Selection (`jev_quota`, `jev_select_model`)
Real-time telemetry tracks your subscription limits to prevent hard `429` errors:
- **5-Hour Bucket:** Tracks rolling usage for the day.
- **7-Day Bucket:** Tracks cumulative usage for the week.

`jev_select_model` automatically swaps your target model to a lower-tier alternative when thresholds are approached.

### 🔌 Dual Integration
Jev ships with native adapters for both major agent frameworks:
1. **Antigravity CLI:** Deep hooks into the Antigravity action pipeline.
2. **OpenCode V2:** Native plugin hooks into the OpenCode extension architecture. *(Note: `opencode serve` background service caches plugin modules in memory. Restart the service via `pkill -f "opencode serve"` after updating plugin source versions).*
3. **Claude Code:** A plugin with the MCP server plus hooks that advise and guard each turn. See the Claude Code section below.

---

## 📐 System 1 Decision & Execution Flows

### 1. Pre-Flight Dispatch & Reasoning Effort Governance Flow

```mermaid
flowchart TD
    A["👤 User Request / Task Prompt"] --> B["⚡ Jev Pre-Flight Dispatch (jev_dispatch)"]
    
    B --> C{"🔍 Subagent & Intent Evaluator"}
    C -->|Mechanical / Formatting| D["🟢 Low Effort (low)\n(formatter, syntax_checker, git_scribe)\n-30% Tokens, Min Latency"]
    C -->|Standard Work / Code| E["🔵 Medium Effort (medium)\n(code_engineer, research, general_developer)\nBalanced Reasoning Depth"]
    C -->|Complex Architecture| F["🟣 High Effort (high)\n(system_architect, security_auditor)\nMaximum CoT Depth"]
    
    D --> G{"📊 Quota Strategy Governor (readQuotaView)"}
    E --> G
    F --> G
    
    G -->|Strategy: normal| H["✅ Execute Calibrated Effort"]
    G -->|Strategy: conserve| I["⚠️ Cap High Effort -> medium"]
    G -->|Strategy: free_only (Free Model)| J["🆓 Retain medium / high on openrouter/free"]
    G -->|Strategy: free_only (Quota Model)| K["🔒 Force low Effort on Paid Quota Models"]
    
    H --> L["🤖 Subagent Execution"]
    I --> L
    J --> L
    K --> L

    style D fill:#1b4332,color:#fff,stroke:#2d6a4f,stroke-width:2px
    style E fill:#1e3a8a,color:#fff,stroke:#3b82f6,stroke-width:2px
    style F fill:#4c1d95,color:#fff,stroke:#8b5cf6,stroke-width:2px
    style G fill:#0f172a,color:#fff,stroke:#f59e0b,stroke-width:2px
```

### 2. Free-Tier Offloading & Micro-Evaluation Quality Gate

```mermaid
flowchart LR
    subgraph Input["📥 Workload Capture"]
        A["Formatting / Scaffolding / Summaries"]
        B["Git Commit Messages (commit.sh)"]
        C["Boilerplate Code Scaffolding"]
    end

    subgraph FreeEngine["⚡ Free-Tier Engine ($0.00 Cost)"]
        D["jev_execute_free"] --> E["openrouter/free\n(200k Context Window)"]
    end

    subgraph Gate["🛡️ Sub-second Quality Gate (~350ms)"]
        F["jev_judge (Decisions API)"]
        F --> G{"Passed? (noul >= 0.5)"}
        G -->|Yes| H["✅ Output Validated & Returned"]
        G -->|No| I["🔄 Retried via Guarded Policy / Escalated"]
    end

    A --> D
    B --> D
    C --> D
    E --> F

    style FreeEngine fill:#15803d,color:#fff,stroke:#22c55e,stroke-width:2px
    style Gate fill:#1e1b4b,color:#fff,stroke:#6366f1,stroke-width:2px
```

### 3. Multi-Bucket Quota Preservation Architecture

```mermaid
flowchart TD
    subgraph Drivers["🎮 Drivers / Interfaces"]
        A["CLI (jev on / jev status)"]
        B["Antigravity IDE & CLI"]
        C["OpenCode V2 Plugin (plugin.ts)"]
    end

    subgraph State["💾 Multi-Bucket Quota State (~/.gemini/.../quota-state.json)"]
        D["gemini-5h (Rolling Daily)"]
        D1["gemini-weekly (7-Day Cumulative)"]
        D2["3p-5h (Third-Party Models)"]
        D3["3p-weekly (Third-Party Cumulative)"]
    end

    subgraph Policy["⚖️ Dynamic Model Selector (selectModel)"]
        E["normal (Full Tier Choice)"]
        F["conserve (Cap Pro -> Flash)"]
        G["free_only (Force openrouter/free)"]
    end

    A --> State
    B --> State
    C --> State
    State --> Policy

    style State fill:#111827,color:#fff,stroke:#9ca3af,stroke-width:2px
    style Policy fill:#451a03,color:#fff,stroke:#f97316,stroke-width:2px
```

---

## 💰 Token & Cost Savings Comparison Matrix

| Workload Category | Monolithic Execution (No Jev) | TypeSafe Jev Coprocessor Engine | Paid Token Savings | Gemini Quota Burn | Latency Impact |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Mechanical Formatting & Scaffolding** | Paid Tier (`Gemini Pro` / `Flash`) @ high effort | Offloaded to `openrouter/free` via `jev_execute_free` @ `low` effort | **100% Paid Savings** | **0% Quota Burn ($0.00)** | ~600ms (Fast) |
| **Git Commit Generation (`commit.sh`)** | Primary Session Model (~2k tokens) | `jev_agent_free` + `jev_judge` validation (~350ms) | **100% Paid Savings** | **0% Quota Burn ($0.00)** | ~350ms (Sub-second) |
| **Documentation & Research (`research` / `docs_engineer`)** | High CoT reasoning budget | Calibrated `medium` effort + quota governor throttling | **~30% Token Savings** | **60% Reduced Burn** | ~1.2s |
| **Standard Feature Engineering (`code_engineer`)** | Unbounded reasoning tokens | Pre-flight `jev_dispatch` + `medium` effort governance | **~25% Token Savings** | **Optimal Quota Preservation** | ~2.5s |
| **Security Audits & RFC Architecture** | Uniform static reasoning budget | Dynamic `high` effort + `jev_judge` diff integrity check | Deepest CoT Reasoning Depth | Calibrated & Guarded | Extended CoT Depth |
| **Overall Monthly Benchmark** | High risk of 5-Hour / 7-Day Quota Exhaustion (`429`) | Guaranteed continuous operation under quota safety caps | **~45% Overall Token & Cost Savings** | **Quota Lifetime Extended 3x** | **Up to 4x Faster Turn Completion** |

---

## 🏗️ Architecture & Component Structure

```text
plugins/jev
├── src/
│   ├── core/                # Core engines (client, config, cache, discovery, egress, heuristics, graph)
│   ├── tools/               # MCP tool handlers (dispatch, execute-free, judge, mode, quota, route, score)
│   ├── audit/               # Compliance and drift detection (drift-detector.ts)
│   ├── index.ts             # Main MCP server entrypoint
│   ├── shared.ts            # Shared types and helpers across harnesses
│   └── tracing.ts           # OpenTelemetry and span logging
├── opencode/                # OpenCode V2 plugin adapters
├── claude/                  # Claude Code hook adapter (hook.ts entry, logic.ts decisions)
├── hooks/hooks.json         # Claude Code hook registration
├── scripts/
│   ├── commit.ts            # Semantic commit generation pipeline
│   ├── commit.sh            # Shell wrapper for commit.ts
│   └── audit-agentic-gaps.ts# Agentic hub gap auditor
├── skills/
│   └── jev/                 # In-chat slash command skill
├── tests/                   # Bun unit test suite (config, cache, audit, egress, jev, etc.)
├── .env.example             # Template configuration
├── package.json
└── tsconfig.json
```

---

## ⚙️ Configuration

Create a `.env` file in the plugin root (`.env` is ignored by git via `.gitignore`).

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `JEV_OPENROUTER_API_KEY` | **Required.** API key for OpenRouter to access free-tier and decision endpoints. | *(None)* |
| `JEV_MODE` | Initial operating mode (`ON`, `ON-DEMAND`, `OFF`). Overridden by `config.json`. | `OFF` |
| `JEV_EGRESS_DENY` | Optional. Extra directories (separated by `:`) from which nothing may be sent. It can only add restrictions. | *(None)* |
| `JEV_ZDR` | Optional. Zero Data Retention enforcement mode (`off`, `on`, `strict`). Overridden by configuration files. | `off` |

### Canonical Configuration Store (`~/.config/jev/config.json`)

`~/.config/jev/config.json` is the **single canonical source of truth** for Jev settings across all harnesses (Antigravity, Claude Code, OpenCode). Legacy `mode.json` is completely deprecated and ignored.

Example configuration:

```json
{
  "defaults": {
    "mode": "off"
  },
  "harnesses": {
    "antigravity": {
      "mode": "on"
    },
    "claude-code": {
      "mode": "on"
    },
    "opencode": {
      "mode": "on-demand"
    }
  },
  "routing": {
    "strategy": "router"
  },
  "privacy": {
    "zdr": "off"
  }
}
```

#### Precedence & Scoping Rules

1. **Per-Harness Override:** `harnesses.<harness>.mode` takes precedence when running inside that harness (e.g. enabling a specific harness even if `defaults.mode` is `"off"`).
2. **Global Default:** Falls back to `defaults.mode` if no harness-specific override exists.
3. **Fallback Default:** If unconfigured, mode strictly defaults to **`off`** (Opt-In Intent).
4. **Routing Strategy:** `routing.strategy` selects between `"router"` (OpenRouter Decisions API `~typesafe/jev-latest` with local keyword fallback) and `"keyword"` (offline local description scoring only).

#### Harness Model Configuration

Jev maps execution tiers across supported agent harnesses to their native or configured models:

| Harness | Free Tier (`free`) | Cheap Tier (`cheap`) | Standard Tier (`standard`) | Deep Tier (`deep`) |
| :--- | :--- | :--- | :--- | :--- |
| **Antigravity** | `openrouter/free` | `flash_lite` | `flash` | `pro` |
| **Claude Code** | `openrouter/free` | `haiku` | `sonnet` | `opus` |
| **OpenCode** | `openrouter/free` | `~anthropic/claude-haiku-latest` | `~anthropic/claude-sonnet-latest` | `~anthropic/claude-opus-latest` |
| **CLI** | `openrouter/free` | `google/gemma-4-31b-it:free` | `typesafe/jev-router` | `typesafe/jev-router` |

### Outbound Data Control & Privacy (optional)

By default jev sends requests exactly as before. To keep some of your work away from OpenRouter, create `~/.config/jev/egress.json`. jev reads this file but never writes it:

```json
{
  "allowPaths": ["~/Work/public-repo", "~/Work/agentic-hub"],
  "denyPaths": ["~/Work/public-repo/private-notes"],
  "zdr": "on"
}
```

- With `allowPaths`, every outbound request is blocked unless the session directory lies under one of the listed paths. Without it, only `denyPaths` applies.
- The session directory is checked three ways: the hook's `cwd`, `CLAUDE_PROJECT_DIR`, and the process working directory. All three must pass.
- Paths are compared after resolving `~`, symlinks, and (on macOS) letter case.
- If `egress.json` is not valid JSON or has the wrong shape, everything is blocked. A broken policy never fails open.
- Blocked requests fail before any data leaves the machine. Hooks stay silent; MCP tools return an error.
- Requests to `localhost` / `127.0.0.1` (the local memory server) are not affected.
- While a policy is active, each sent and blocked request is logged to `~/.config/jev/egress-log.jsonl` with host, model, byte count, and ZDR audit markers (`zdr_policy`, `zdr_applied`). Request bodies are never logged.

**Limits.** The policy looks at *where the session runs*, not at *what the data is*. Text from a blocked directory that you paste into a prompt, or a file read by absolute path from an allowed session, is not detected.

> [!NOTE]
> **Batch Dispatch Outbound Data Notice:** When `routing.strategy` is set to `"router"` (the default), `jev_batch_dispatch` routes task descriptions and criteria to the OpenRouter Decisions API (`~typesafe/jev-latest`). These requests are strictly governed by your egress directory rules and Zero Data Retention (ZDR) policy. If an egress policy blocks the working directory, or if `zdr: "strict"` is active and ZDR is unavailable, dispatch automatically falls back to offline local keyword matching without leaking data.

#### 🔒 Zero Data Retention (ZDR) & Provider Data Policies

OpenRouter allows clients to enforce data privacy guardrails via provider routing constraints (`provider.zdr: true` and `provider.data_collection: "deny"`). When enabled, OpenRouter routes exclusively to upstream model providers with signed Zero Data Retention agreements that contractually commit to not retaining prompts or completions, and never training on customer data.

Jev provides first-class governance for ZDR across all coprocessor workflows:

##### Operational ZDR Policy Modes

| Mode | Behavior | Decisions API (`~typesafe/jev-latest`) | Free Offloading (`openrouter/free`) | Use Case |
| :--- | :--- | :--- | :--- | :--- |
| `off` *(default)* | Standard routing without ZDR or data collection restrictions. | Standard routing | Allowed (standard routing) | Development, public open-source code, or non-sensitive environments. |
| `on` *(recommended)* | Pragmatic privacy balance. Enforces ZDR and `data_collection: "deny"` on all System 1 Decisions API calls, leaving zero prompt retention footprint. Free generative offloading proceeds without ZDR headers but records audit markers. | Enforced ZDR (`zdr_applied: true`) | Allowed with audit marker (`zdr_applied: false`) | Recommended default for mixed development workflows needing quota protection and private decision routing. |
| `strict` | Zero-trust enforcement. Requires ZDR across 100% of outbound calls. Any request to endpoints lacking ZDR agreements is blocked locally before network transmission. | Enforced ZDR (`zdr_applied: true`) | Blocked locally (`JEV_ZDR_UNAVAILABLE`) | High-compliance, proprietary enterprise, or zero-trust environments where uncontracted data handling is prohibited. |

##### Configuration & Precedence

ZDR policy can be defined in multiple locations. Jev resolves the active policy using a strict precedence hierarchy (highest to lowest):

1. **`~/.config/jev/egress.json`** (Highest precedence):
   ```json
   {
     "zdr": "on"
   }
   ```
2. **`~/.config/jev/config.json`** (`privacy.zdr`):
   ```json
   {
     "privacy": {
       "zdr": "on"
     }
   }
   ```
3. **Environment Variable (`JEV_ZDR`)**:
   ```bash
   export JEV_ZDR=on      # Accepted values: "on" ("1", "true"), "strict", "off" ("0", "false")
   ```
4. **Default**: Falls back to `off` when unset.

##### The Free-Tier Trade-off: Pragmatic vs Zero-Trust

Free community models on OpenRouter (e.g. `openrouter/free`, `google/gemma-4-31b-it:free`) are hosted across diverse open endpoints that do not provide commercial Zero Data Retention contracts or signed enterprise data protection agreements.

- In **`on` mode**, Jev protects your proprietary codebase and system reasoning by enforcing ZDR on decision routing (`jev_dispatch`, `jev_judge`, `jev_route`) while still permitting $0.00 mechanical offloading (scaffolding, formatting, commits) to free endpoints. Each outbound offload records `"zdr_policy": "on"` and `"zdr_applied": false` in `~/.config/jev/egress-log.jsonl` for compliance auditing.
- In **`strict` mode**, Jev adopts a zero-trust posture: any attempt to route to an endpoint without verified ZDR compliance fails closed with a typed `JEV_ZDR_UNAVAILABLE` error (`EGRESS_ZDR_UNAVAILABLE_CODE`). No tokens leave the machine to unverified endpoints.

---

## 🤖 Claude Code

Install from this repository's Claude Code marketplace (`.claude-plugin/marketplace.json` at the repo root):

```
/plugin marketplace add rockad/agentic-hub
/plugin install jev@agentic-hub
```

Put the key where the hooks and the MCP server both find it: `~/.config/jev/env` with
`JEV_OPENROUTER_API_KEY=...`. `bun` must be on `PATH`.

The plugin brings the `jev_*` MCP tools and four hooks (`hooks/hooks.json` → `claude/hook.ts`).
The hooks act only in mode `on`. In `on-demand` and `off` they stay silent, and the MCP tools
remain callable on request.

| Event | What Jev does |
| :--- | :--- |
| `SessionStart`, `PostModelSwitch` | Remembers the session model in `~/.config/jev/claude-sessions/`. It is the ceiling for delegations. |
| `UserPromptSubmit` | Asks Jev (1.5 s budget) for a Claude subagent (`Explore`, `general-purpose`, `Plan`, `self`), a model (`openrouter_free`/`flash_lite` → `haiku`, `flash` → `sonnet`, `pro` → `opus`) and an effort, and adds them to the turn as context. |
| `PreToolUse` on `Agent` | Asks the user before a subagent runs on a stronger model than the session's. When Jev is reachable, it also asks when Jev rates the delegated task `pro`. |

What the hooks do **not** do:

- They never change the model of a delegation. Cheaper models are advised, not forced.
- They never block a turn. Any failure (no key, Jev down, malformed input) prints nothing and exits 0.
- They do not track Claude subscription limits. Claude Code exposes `rate_limits` only to the status
  line, not to hooks, so the quota strategy is whatever `readQuotaView` reports (usually `unknown`).

Decisions are logged to `~/.config/jev/claude_decisions.jsonl`.

---

## 📟 Slash Commands & Tool Interfaces

Operating modes and status are managed via the in-chat `/jev` slash command / skill inside agent harnesses and the `jev_set_mode` / `jev_get_mode` MCP tools. The legacy shell script (`scripts/jev-mode`) is retired.

| Interface | Command / Call | Description |
| :--- | :--- | :--- |
| **Slash Command** | `/jev` or `/jev status` | Inspects current quota and active mode from `~/.config/jev/config.json`. |
| **Slash Command** | `/jev on` | Sets active mode to `ON` (Always Active). |
| **Slash Command** | `/jev on-demand` | Sets active mode to `ON-DEMAND` (Passive Coprocessor). |
| **Slash Command** | `/jev off` | Sets active mode to `OFF` (Zero Overhead / Pass-through). |
| **MCP Tool** | `jev_get_mode()` | Programmatically queries active mode, resolved harness mode, and configuration. |
| **MCP Tool** | `jev_set_mode({ mode })` | Programmatically updates mode directly in `~/.config/jev/config.json`. |

---

## 🛠️ Development & Testing

```bash
# Install dependencies
bun install

# Run the test suite
bun test
```
