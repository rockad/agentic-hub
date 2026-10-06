---
name: mcp-lookup
description: >
  Archive document lookup and search. Use when the user asks to find a
  specific document, check archive statistics, or refresh the index.
  Operates on a pre-built search index over archived content.
when_to_use: The user wants to find a document by title or content,
  check how many items are in the archive, or force an index refresh.
allowed-tools: mcp(lookup/*)
metadata:
  author: agentic-hub
  source: antigravity-mcp
  registration: opencode-global-mcp
  mcp: lookup
---

# lookup (MCP bridge)

Archive search service, exposed to OpenCode.

## Server
- Registered natively in OpenCode global config (`mcp.servers`) via the antigravity bridge
- Tools: `search_archive`, `get_document`, `refresh_index`, `archive_stats`

## How to use

### Search the archive
```
mcp(lookup/search_archive) { "query": "quarterly report 2025", "limit": 10 }
```

### Get a specific document
```
mcp(lookup/get_document) { "id": "doc-12345" }
```

### Refresh the index
```
mcp(lookup/refresh_index) {}
```

### Check archive stats
```
mcp(lookup/archive_stats) {}
```

## Tips
- Search returns ranked results; `limit` caps the number returned.
- After `refresh_index`, existing cached results may be stale.
- Use `archive_stats` to confirm the index is populated before searching.
