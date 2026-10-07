---
name: mcp-toggle
description: >-
  Inspect and toggle Model Context Protocol (MCP) server plugins (Chrome DevTools, Google Workspace, TypeSafe Jev)
  on and off to preserve context window tokens (~22,000–24,000 tokens/turn) and manage tool availability.
when_to_use: >-
  The user asks to enable or disable browser automation, Google Workspace (Gmail/Calendar), or Jev;
  when inspecting active MCP server status and context overhead; or when performing temporary tasks
  that require activating heavyweight tools followed by clean teardown.
argument-hint: "[status | browser on|off | google on|off | jev on|off]"
allowed-tools: Bash(mcp-toggle *), Bash(agy plugin *)
---

# `mcp-toggle` — MCP Plugin & Context Token Switcher

The `mcp-toggle` CLI tool manages on-demand Model Context Protocol (MCP) plugins to enforce **default-lean context hygiene** across Google Antigravity and AI coding agents.

---

## 1. Context Window Impact & Why We Toggle

In Google Antigravity, MCP tool definitions are injected into the agent's prompt on **every single turn**. Heavyweight tools consume large portions of the context window:

| Target | Tools | Token Cost / Turn | Default State | Rationale |
| :--- | :---: | :---: | :---: | :--- |
| **`chrome-devtools`** | 30 | ~12,000–14,000 | **Disabled** | Needed only for active web browsing, DOM inspection, or Lighthouse audits. |
| **`google-workspace`** | 21 | ~8,000–10,000 | **Disabled** | Needed only when explicitly reading Gmail or managing Google Calendar. |
| **Core Servers** (`jev`, `gitea`, `obsidian`, `memory`) | ~35 | ~8,000 | **Enabled** | Always active core developer capabilities (decision coprocessor, repos, vault, memory). |

Keeping heavyweight plugins disabled when not in use **saves ~22,000–24,000 tokens on every prompt turn**, accelerating inference and preventing context exhaustion.

---

## 2. CLI Usage & Syntax

```bash
mcp-toggle [target] [action]
```

Both argument orders are supported: `mcp-toggle <target> <on|off>` or `mcp-toggle <on|off> <target>`.

### Common Commands

| Command | Action | Aliases |
| :--- | :--- | :--- |
| `mcp-toggle status` | Display status table of all MCP plugins and servers. | `mcp-toggle`, `mcp-status` |
| `mcp-toggle browser on` | Enable Chrome DevTools MCP plugin. | `mcp-toggle chrome on`, `mcp-toggle chrome-devtools on` |
| `mcp-toggle browser off` | Disable Chrome DevTools plugin to reclaim ~14k tokens. | `mcp-toggle chrome off` |
| `mcp-toggle google on` | Enable Google Workspace (Gmail/Calendar) plugin. | `mcp-toggle workspace on`, `mcp-toggle google-workspace on` |
| `mcp-toggle google off` | Disable Google Workspace plugin to reclaim ~10k tokens. | `mcp-toggle workspace off` |
| `mcp-toggle jev on` | Enable aggressive TypeSafe Jev System 1 pre-flight enforcement. | `jev on`, `jev-mode on` |
| `mcp-toggle jev off` | Disable Jev System 1 coprocessor. | `jev off`, `jev-mode off` |

---

## 3. Best Practices for AI Agents

1. **Check Status Before Improvising**:
   When a user asks for browser automation or Google Workspace actions, run `mcp-toggle status` to check if the corresponding plugin is currently disabled.
2. **Just-in-Time Activation**:
   If a task requires browser tools (`mcp(chrome-devtools/*)`) or Gmail/Calendar tools (`mcp(google-workspace/*)`), activate the plugin immediately:
   ```bash
   mcp-toggle browser on
   ```
3. **Clean Teardown Hygiene**:
   Once the browser navigation, scraping, or email drafting task is finished, disable the plugin:
   ```bash
   mcp-toggle browser off
   ```
   This ensures subsequent turns (e.g. coding, file edits, git commits) do not carry the unnecessary 14,000–24,000 token burden.
