---
name: mcp-google-workspace
description: >
  Google Workspace operations: Gmail (search, read, send, draft, labels),
  Calendar (events, focus time, out of office, free/busy), Drive
  attachments. Use for any email, calendar, or drive task the user asks
  about.
when_to_use: The user wants to search Gmail, read/send/draft a message,
  manage labels/filters, create or query Calendar events, check free/busy,
  manage focus time or out-of-office, or download attachments.
allowed-tools: mcp(google-workspace/*)
metadata:
  author: agentic-hub
  source: antigravity-mcp
  registration: opencode-global-mcp
  mcp: google-workspace
---

# google-workspace (MCP bridge)

Google Workspace (Gmail, Calendar, Drive) operations, exposed to OpenCode.

## Server
- Registered natively in OpenCode global config (`mcp.servers`) via the antigravity bridge
- Tools: 32 tools covering Gmail, Calendar, and Drive integration.

## How to use (common patterns)

### Search Gmail
```
mcp(google-workspace/search_gmail_messages) {
  "query": "from:boss@example.com is:unread",
  "user_google_email": "user@example.com",
  "page_size": 20
}
```

### Read a thread
```
mcp(google-workspace/get_gmail_thread_content) {
  "thread_id": "192abc...",
  "user_google_email": "user@example.com",
  "include_analysis": true
}
```

### Send an email
```
mcp(google-workspace/send_gmail_message) {
  "user_google_email": "user@example.com",
  "to": "someone@example.com",
  "subject": "Hello",
  "body": "Message body",
  "body_format": "plain"
}
```

### Draft an email
```
mcp(google-workspace/draft_gmail_message) {
  "user_google_email": "user@example.com",
  "to": "someone@example.com",
  "subject": "Draft",
  "body": "Draft body"
}
```

### Calendar: list events
```
mcp(google-workspace/get_events) {
  "user_google_email": "user@example.com",
  "calendar_id": "primary",
  "time_min": "2026-09-30T00:00:00Z",
  "time_max": "2026-10-01T00:00:00Z"
}
```

### Calendar: manage event (create/update/delete/rsvp)
```
mcp(google-workspace/manage_event) {
  "user_google_email": "user@example.com",
  "action": "create",
  "calendar_id": "primary",
  "summary": "Team sync",
  "start_time": "2026-09-30T10:00:00Z",
  "end_time": "2026-09-30T11:00:00Z"
}
```

### Focus time / Out of office
```
mcp(google-workspace/manage_focus_time) { "user_google_email": "...", "action": "create", ... }
mcp(google-workspace/manage_out_of_office) { "user_google_email": "...", "action": "create", ... }
```

### Free/busy
```
mcp(google-workspace/query_freebusy) {
  "user_google_email": "user@example.com",
  "time_min": "2026-09-30T00:00:00Z",
  "time_max": "2026-10-01T00:00:00Z",
  "calendar_ids": ["primary"]
}
```

## Tips
- Every tool requires `user_google_email` (your personal account).
- `search_gmail_messages` with `include_headers: true` returns
  Subject/From/Date inline — useful for quick triage.
- For large messages, use `get_gmail_message_content` with `full: true`
  and `body_format: "raw"` to get a downloadable .eml.
- `batch_modify_gmail_message_labels` is more efficient than calling
  `modify_gmail_message_labels` in a loop.