---
name: mcp-jev
description: >
  JEV (JetBrains External) decision and classification layer. Routes
  candidate options through the OpenRouter Decisions API (~typesafe/jev-latest),
  executing and scoring in ~800ms. Use when a non-trivial choice between
  2-8 candidates needs a quick probabilistic verdict.
when_to_use: The user presents a set of candidate options and wants a fast
  calibrated probability over them, or when a later step in a workflow
  depends on a choice. Also when toggling JEV mode or checking state.
allowed-tools: mcp(jev/*)
metadata:
  author: agentic-hub
  source: antigravity-mcp
  registration: opencode-global-mcp
  mcp: jev
---

# JEV (MCP bridge)

JetBrains External classification service, exposed to OpenCode.

## Server
- Registered natively in OpenCode global config (`mcp.servers`) via the antigravity bridge
- Tools: `jev_route`, `jev_execute_free`, `jev_agent_free`, `jev_get_mode`,
  `jev_judge`, `jev_score`, `jev_set_mode`, `jev_dispatch`

## How to use

### Route a choice
```
mcp(jev/jev_route) {
  "context": "Pick the right DB for a key-value store with TTL",
  "options": ["Redis", "Memcached", "RocksDB", "Couchbase"]
}
```

### Execute a free-form judgment
```
mcp(jev/jev_execute_free) {
  "context": "Should we refactor the auth module now or ship the feature first?",
  "instruction": "Evaluate on risk, cost, and user impact"
}
```

### Check / set mode
```
mcp(jev/jev_get_mode) {}
mcp(jev/jev_set_mode) { "mode": "on" }
```

### Judge / score
```
mcp(jev/jev_judge) { "context": "...", "options": [...] }
mcp(jev/jev_score)  { "context": "...", "options": [...] }
```

## Tips
- `jev_route` is the fastest path — use it whenever a single question
  can be framed as "pick from N options".
- `jev_execute_free` is for open-ended judgments where there is no fixed
  option set.
- Always report the calibrated probabilities, not just the winner.
