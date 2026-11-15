# AGENTS.md

This file provides guidance to Google Antigravity, Claude Code, and other AI coding assistants working in this repository.

## What this repository is

`agents-bridge` is the dedicated repository for multi-agent bridge v2 research, specifications, and planning deliverables. It serves as the single source of truth for cross-harness agent communication protocols across Google Antigravity, Claude Code, and OpenCode.

```
agents-bridge/
├── docs/
│   ├── research/   # Ecosystem audits, license assessments, transport evaluations
│   ├── specs/      # Formal protocol specifications (BuildSlot, Heartbeat)
│   └── plans/      # Master coordination tasklists, handoffs, and DDR records
├── README.md
└── AGENTS.md
```

## Architectural Conventions

- **Symmetric Agency**: All communicating agents interact as equals. Master/dependent or caller/subordinate patterns are prohibited.
- **Live Persistent Sessions**: Transports connect long-lived interactive sessions with warm context. One-shot ephemeral subprocess execution (`agy --prompt`, `claude -p`) is prohibited.
- **ACP + A2A Principles**: Local ACP serves as the session transport layer, while A2A principles govern peer-to-peer capability advertisement, task negotiation, and distributed task states (`working`, `input-required`, `completed`, `canceled`, `failed`, `rejected`).
- **Decoupled from Core Engines**: Coordination substrates remain external to `cognitive-engine` deterministic cores.
- **Tool Discipline**: Adhere to purpose-built tools (`jq`, `yq`, `mdq`, `rg`, `fd`, `sd`) before ad-hoc python glue.
