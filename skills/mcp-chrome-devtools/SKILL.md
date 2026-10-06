---
name: mcp-chrome-devtools
description: >
  Browser automation via Chrome DevTools MCP. Use for any task involving
  navigating, inspecting, or interacting with web pages: clicking elements,
  typing into forms, taking screenshots, running Lighthouse audits, or
  reading console/network output. Covers single-page actions and full
  performance traces.
when_to_use: The user asks to open a URL, click something, fill a form,
  debug a page, capture a screenshot, audit performance, or otherwise
  drive a browser. Also when a task requires a live DOM snapshot.
allowed-tools: mcp(chrome-devtools/*)
metadata:
  author: agentic-hub
  source: antigravity-mcp
  registration: opencode-global-mcp
  mcp: chrome-devtools
---

# chrome-devtools (MCP bridge)

Browser automation through the Chrome DevTools MCP server, exposed to OpenCode.

## Server
- Registered natively in OpenCode global config (`mcp.servers`) via the antigravity bridge
- Tools: 30 tool definitions (click, navigate, screenshot, lighthouse, traces, etc.)

## How to use
Call tools directly through the MCP interface. Each tool accepts its own
JSON parameters. Common patterns:

### Open a page
```
mcp(chrome-devtools/new_page) { "url": "https://example.com" }
```

### Click an element
```
mcp(chrome-devtools/click) { "pageId": 1, "uid": "e5", "includeSnapshot": true }
```

### Take a screenshot
```
mcp(chrome-devtools/take_screenshot) { "pageId": 1 }
```

### Run a Lighthouse audit
```
mcp(chrome-devtools/lighthouse_audit) { "pageId": 1 }
```

### Capture a performance trace
```
mcp(chrome-devtools/performance_start_trace) { "pageId": 1 }
mcp(chrome-devtools/performance_stop_trace) { "pageId": 1 }
```

## Tips
- Always call `list_pages` first to discover `pageId` values.
- Use `take_snapshot` to get element `uid`s before clicking.
- For form-filling, `fill_form` accepts a `fields` object keyed by label/selector.