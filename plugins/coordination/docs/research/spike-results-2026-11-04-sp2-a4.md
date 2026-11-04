# Spike Results: SP2 Step A4 (Antigravity Session Identity & Mcp-Session-Id Verification)

- **Date**: 2026-11-04
- **Author**: Antigravity Orchestrator (`agy` version 1.5.0)
- **Target Spike**: `spikes.md` Spike SP2, Step A4 (Antigravity session identity, `_meta` conversation keys, process lifecycle)
- **Stub Execution**: Local loopback port `18126` (`http://127.0.0.1:18126/mcp`)
- **CLI Configuration**:
  - Command: `agy mcp add --header "Authorization: Bearer spike-token" a2a-stub http://127.0.0.1:18126/mcp`
  - Canonical storage entry in `~/.gemini/config/mcp_config.json`:
    ```json
    {
      "disabled": false,
      "headers": {
        "Authorization": "Bearer spike-token"
      },
      "serverUrl": "http://127.0.0.1:18126/mcp"
    }
    ```

---

## 1. Executive Summary & Core Evaluation Answers

| Test / Dimension | Observed Wire Finding | Verdict |
| :--- | :--- | :--- |
| **T1: Same process, two conversations: same PID?** | Process 1 executed both conversation X and conversation Y on PID `863339`. | **[VERIFIED - OBSERVED ON WIRE]** |
| **T1: Same process, two conversations: same `Mcp-Session-Id`?** | Both conversations X and Y inside PID `863339` shared identical `Mcp-Session-Id: 1be9c46c-fc43-4a63-95b2-0d3fd21a3172` over the persistent connection (port `43769`). | **[VERIFIED - OBSERVED ON WIRE]** |
| **T1: Same process, two conversations: distinct `conversation_id`?** | Conversation X carried `68681258-2a80-4d31-81e3-0bd436e3658d`, Conversation Y carried `95477319-a4f3-4649-94c8-964789ba8df2`. | **[VERIFIED - OBSERVED ON WIRE]** |
| **T2: Two separate agy processes: different PID?** | Process 1 ran as PID `863339`; Process 2 ran as PID `901400`. | **[VERIFIED - OBSERVED ON WIRE]** |
| **T2: Two separate agy processes: different `Mcp-Session-Id`?** | Process 1 held `1be9c46c-fc43-4a63-95b2-0d3fd21a3172`; Process 2 held `3012c346-9c75-46c7-ad67-92d7f80b1db5`. | **[VERIFIED - OBSERVED ON WIRE]** |
| **T2: Two separate agy processes: different `conversation_id`?** | Process 1 held `68681258-...` and `95477319-...`; Process 2 held `1ce0a972-2e71-4ca1-a0ec-20633765e43c`. | **[VERIFIED - OBSERVED ON WIRE]** |
| **T3: Restart & resume: identical `conversation_id`?** | `conversation_id` was identical (`68681258-2a80-4d31-81e3-0bd436e3658d`) before shutdown and after resume. | **[VERIFIED - OBSERVED ON WIRE]** |
| **T3: Restart & resume: identical `root_conversation_id`?** | `root_conversation_id` was identical (`68681258-2a80-4d31-81e3-0bd436e3658d`) across restart and resume. | **[VERIFIED - OBSERVED ON WIRE]** |
| **T3: Restart & resume: new `Mcp-Session-Id`?** | Fresh random UUID (`1be9c46c-fc43-4a63-95b2-0d3fd21a3172`) issued on new `initialize` replacing old (`ff89a6ce-...`). | **[VERIFIED - OBSERVED ON WIRE]** |
| **T3: Restart & resume: new PID?** | Resumed under new OS process PID `863339` (previously PID `684782`). | **[VERIFIED - OBSERVED ON WIRE]** |
| **T4: Subagent correlation: `root_conversation_id` vs `conversation_id`?** | `root_conversation_id` equals root parent conversation X; `conversation_id` is the subagent's distinct ID. | **[VERIFIED - OBSERVED ON WIRE]** |
| **T4: Subagent `parent_conversation_id`?** | `params._meta` explicitly carries `parent_conversation_id` matching conversation X. | **[VERIFIED - OBSERVED ON WIRE]** |

---

## 2. Test Execution Details & Wire Evidence

### T1: Same Process, Two Conversations

- **Methodology**:
  - Resumed Conversation X inside `agy` PID `863339`.
  - Executed two calls (`handle="call-x1"`, `handle="call-x2"`).
  - User invoked the agy TUI `/clear` command, which clears active trajectory history and initiates Conversation Y inside the identical OS process.
  - In Conversation Y, executed two calls (`handle="call-1"`, `handle="call-2"`).

#### T1 Results Table

| Conversation | agy PID | Source Port(s) | `Mcp-Session-Id` | `conversation_id` | `root_conversation_id` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| X (Call 1) | 863339 | 43769 | `1be9c46c-fc43-4a63-95b2-0d3fd21a3172` | `68681258-2a80-4d31-81e3-0bd436e3658d` | `68681258-2a80-4d31-81e3-0bd436e3658d` |
| X (Call 2) | 863339 | 43769 | `1be9c46c-fc43-4a63-95b2-0d3fd21a3172` | `68681258-2a80-4d31-81e3-0bd436e3658d` | `68681258-2a80-4d31-81e3-0bd436e3658d` |
| Y (Call 1) | 863339 | 43769 | `1be9c46c-fc43-4a63-95b2-0d3fd21a3172` | `95477319-a4f3-4649-94c8-964789ba8df2` | `95477319-a4f3-4649-94c8-964789ba8df2` |
| Y (Call 2) | 863339 | 43769 | `1be9c46c-fc43-4a63-95b2-0d3fd21a3172` | `95477319-a4f3-4649-94c8-964789ba8df2` | `95477319-a4f3-4649-94c8-964789ba8df2` |

#### Raw NDJSON Excerpts (T1)

```json
{"timestamp": "2026-11-04T21:14:38.288455+00:00", "client_source_port": 43769, "agy_pid": 863339, "http_method": "POST", "jsonrpc_method": "tools/call", "mcp_session_id": "1be9c46c-fc43-4a63-95b2-0d3fd21a3172", "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": {"antigravity.google/artifacts_dir": "/home/rockad/.gemini/antigravity-cli/brain/68681258-2a80-4d31-81e3-0bd436e3658d", "antigravity.google/conversation_id": "68681258-2a80-4d31-81e3-0bd436e3658d", "antigravity.google/root_conversation_id": "68681258-2a80-4d31-81e3-0bd436e3658d", "progressToken": "1cb92301-0303-4763-a1be-8a38989338c7:434"}}
{"timestamp": "2026-11-04T21:14:42.554247+00:00", "client_source_port": 43769, "agy_pid": 863339, "http_method": "POST", "jsonrpc_method": "tools/call", "mcp_session_id": "1be9c46c-fc43-4a63-95b2-0d3fd21a3172", "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": {"antigravity.google/artifacts_dir": "/home/rockad/.gemini/antigravity-cli/brain/68681258-2a80-4d31-81e3-0bd436e3658d", "antigravity.google/conversation_id": "68681258-2a80-4d31-81e3-0bd436e3658d", "antigravity.google/root_conversation_id": "68681258-2a80-4d31-81e3-0bd436e3658d", "progressToken": "1cb92301-0303-4763-a1be-8a38989338c7:437"}}
{"timestamp": "2026-11-04T21:16:03.677518+00:00", "client_source_port": 43769, "agy_pid": 863339, "http_method": "POST", "jsonrpc_method": "tools/call", "mcp_session_id": "1be9c46c-fc43-4a63-95b2-0d3fd21a3172", "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": {"antigravity.google/artifacts_dir": "/home/rockad/.gemini/antigravity-cli/brain/95477319-a4f3-4649-94c8-964789ba8df2", "antigravity.google/conversation_id": "95477319-a4f3-4649-94c8-964789ba8df2", "antigravity.google/root_conversation_id": "95477319-a4f3-4649-94c8-964789ba8df2", "progressToken": "cc587fb8-6334-403c-b3a7-5ea4194b638d:10"}}
{"timestamp": "2026-11-04T21:16:03.715187+00:00", "client_source_port": 43769, "agy_pid": 863339, "http_method": "POST", "jsonrpc_method": "tools/call", "mcp_session_id": "1be9c46c-fc43-4a63-95b2-0d3fd21a3172", "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": {"antigravity.google/artifacts_dir": "/home/rockad/.gemini/antigravity-cli/brain/95477319-a4f3-4649-94c8-964789ba8df2", "antigravity.google/conversation_id": "95477319-a4f3-4649-94c8-964789ba8df2", "antigravity.google/root_conversation_id": "95477319-a4f3-4649-94c8-964789ba8df2", "progressToken": "cc587fb8-6334-403c-b3a7-5ea4194b638d:11"}}
```

- **Verdict on T1**:
  - **Same PID?** **[VERIFIED - OBSERVED ON WIRE]**: YES (PID `863339`).
  - **Same `Mcp-Session-Id`?** **[VERIFIED - OBSERVED ON WIRE]**: YES (`1be9c46c-fc43-4a63-95b2-0d3fd21a3172`).
  - **Distinct `conversation_id`?** **[VERIFIED - OBSERVED ON WIRE]**: YES (`68681258-2a80-4d31-81e3-0bd436e3658d` vs `95477319-a4f3-4649-94c8-964789ba8df2`).

---

### T2: Two Separate agy Processes

- **Methodology**:
  - User launched a completely independent second `agy` terminal session (`PID 901400`).
  - Second session performed independent `server/discover` and `initialize` handshake, receiving its own fresh random UUID as `Mcp-Session-Id`.
  - Executed tool call with `handle="call-proc2"`.

#### T2 Results Table

| Conversation / Process | agy PID | Source Port(s) | `Mcp-Session-Id` | `conversation_id` | `root_conversation_id` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Process 1 (Conv X) | 863339 | 43769 | `1be9c46c-fc43-4a63-95b2-0d3fd21a3172` | `68681258-2a80-4d31-81e3-0bd436e3658d` | `68681258-2a80-4d31-81e3-0bd436e3658d` |
| Process 1 (Conv Y) | 863339 | 43769 | `1be9c46c-fc43-4a63-95b2-0d3fd21a3172` | `95477319-a4f3-4649-94c8-964789ba8df2` | `95477319-a4f3-4649-94c8-964789ba8df2` |
| Process 2 (Conv Z) | 901400 | 40817 | `3012c346-9c75-46c7-ad67-92d7f80b1db5` | `1ce0a972-2e71-4ca1-a0ec-20633765e43c` | `1ce0a972-2e71-4ca1-a0ec-20633765e43c` |

#### Raw NDJSON Excerpts (T2 Process 2 Handshake & Tool Call)

```json
{"timestamp": "2026-11-04T21:19:06.878825+00:00", "client_source_port": 40801, "agy_pid": 901400, "http_method": "POST", "jsonrpc_method": "server/discover", "mcp_session_id": null, "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": {"io.modelcontextprotocol/clientCapabilities": {"elicitation": {"form": {}, "url": {}}, "roots": {"listChanged": true}}, "io.modelcontextprotocol/clientInfo": {"name": "antigravity-client", "version": "v1.0.0"}, "io.modelcontextprotocol/protocolVersion": "2026-07-28"}}
{"timestamp": "2026-11-04T21:19:06.892103+00:00", "client_source_port": 40801, "agy_pid": 901400, "http_method": "POST", "jsonrpc_method": "initialize", "mcp_session_id": "3012c346-9c75-46c7-ad67-92d7f80b1db5", "incoming_mcp_session_id": null, "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": null}
{"timestamp": "2026-11-04T21:20:02.709031+00:00", "client_source_port": 40817, "agy_pid": 901400, "http_method": "POST", "jsonrpc_method": "tools/call", "mcp_session_id": "3012c346-9c75-46c7-ad67-92d7f80b1db5", "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": {"antigravity.google/artifacts_dir": "/home/rockad/.gemini/antigravity-cli/brain/1ce0a972-2e71-4ca1-a0ec-20633765e43c", "antigravity.google/conversation_id": "1ce0a972-2e71-4ca1-a0ec-20633765e43c", "antigravity.google/root_conversation_id": "1ce0a972-2e71-4ca1-a0ec-20633765e43c", "progressToken": "4f85927c-738a-4a28-ad77-059a31c65378:6"}}
```

- **Verdict on T2**:
  - **Different PID?** **[VERIFIED - OBSERVED ON WIRE]**: YES (PID `863339` vs PID `901400`).
  - **Different `Mcp-Session-Id`?** **[VERIFIED - OBSERVED ON WIRE]**: YES (`1be9c46c-fc43-4a63-95b2-0d3fd21a3172` vs `3012c346-9c75-46c7-ad67-92d7f80b1db5`).
  - **Different `conversation_id`?** **[VERIFIED - OBSERVED ON WIRE]**: YES (`1ce0a972-2e71-4ca1-a0ec-20633765e43c` vs `68681258-...` / `95477319-...`).

---

### T3: Restart and Resume

- **Methodology**:
  - Initial run executed under PID `684782` in Conversation X (`68681258-2a80-4d31-81e3-0bd436e3658d`).
  - User fully exited `agy`. Stub recorded HTTP `DELETE /mcp` from PID `684782` at `2026-11-04T21:12:21Z`.
  - Confirmed via `ss -tnp` and process table that no PID `684782` process remained.
  - User restarted and resumed via:
    ```bash
    agy --project doppelganger --conversation 68681258-2a80-4d31-81e3-0bd436e3658d
    ```
  - New process started under PID `863339`.
  - Stub issued fresh UUID `1be9c46c-fc43-4a63-95b2-0d3fd21a3172` on new `initialize`.
  - Executed two successive tool calls in resumed Conversation X.

#### T3 Results Table

| Phase | agy PID | Source Port(s) | `Mcp-Session-Id` | `conversation_id` | `root_conversation_id` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Pre-Restart (Conv X) | 684782 | 41173 (subagent) | `ff89a6ce-ebec-4f85-b9f7-ceca88d6e26a` | `68681258-2a80-4d31-81e3-0bd436e3658d` (root) | `68681258-2a80-4d31-81e3-0bd436e3658d` |
| Post-Resume (Call 1) | 863339 | 43769 | `1be9c46c-fc43-4a63-95b2-0d3fd21a3172` | `68681258-2a80-4d31-81e3-0bd436e3658d` | `68681258-2a80-4d31-81e3-0bd436e3658d` |
| Post-Resume (Call 2) | 863339 | 43769 | `1be9c46c-fc43-4a63-95b2-0d3fd21a3172` | `68681258-2a80-4d31-81e3-0bd436e3658d` | `68681258-2a80-4d31-81e3-0bd436e3658d` |

#### Raw NDJSON Excerpts (T3 Clean Shutdown & Resumed Invocations)

```json
{"timestamp": "2026-11-04T21:12:21.257914+00:00", "client_source_port": 43995, "agy_pid": 684782, "http_method": "DELETE", "jsonrpc_method": null, "mcp_session_id": "ff89a6ce-ebec-4f85-b9f7-ceca88d6e26a", "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": null}
{"timestamp": "2026-11-04T21:14:14.684993+00:00", "client_source_port": 42937, "agy_pid": 863339, "http_method": "POST", "jsonrpc_method": "initialize", "mcp_session_id": "1be9c46c-fc43-4a63-95b2-0d3fd21a3172", "incoming_mcp_session_id": null, "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": null}
{"timestamp": "2026-11-04T21:14:38.288455+00:00", "client_source_port": 43769, "agy_pid": 863339, "http_method": "POST", "jsonrpc_method": "tools/call", "mcp_session_id": "1be9c46c-fc43-4a63-95b2-0d3fd21a3172", "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": {"antigravity.google/artifacts_dir": "/home/rockad/.gemini/antigravity-cli/brain/68681258-2a80-4d31-81e3-0bd436e3658d", "antigravity.google/conversation_id": "68681258-2a80-4d31-81e3-0bd436e3658d", "antigravity.google/root_conversation_id": "68681258-2a80-4d31-81e3-0bd436e3658d", "progressToken": "1cb92301-0303-4763-a1be-8a38989338c7:434"}}
{"timestamp": "2026-11-04T21:14:42.554247+00:00", "client_source_port": 43769, "agy_pid": 863339, "http_method": "POST", "jsonrpc_method": "tools/call", "mcp_session_id": "1be9c46c-fc43-4a63-95b2-0d3fd21a3172", "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": {"antigravity.google/artifacts_dir": "/home/rockad/.gemini/antigravity-cli/brain/68681258-2a80-4d31-81e3-0bd436e3658d", "antigravity.google/conversation_id": "68681258-2a80-4d31-81e3-0bd436e3658d", "antigravity.google/root_conversation_id": "68681258-2a80-4d31-81e3-0bd436e3658d", "progressToken": "1cb92301-0303-4763-a1be-8a38989338c7:437"}}
```

- **Verdict on T3**:
  - **Identical `conversation_id`?** **[VERIFIED - OBSERVED ON WIRE]**: YES (`68681258-2a80-4d31-81e3-0bd436e3658d`).
  - **Identical `root_conversation_id`?** **[VERIFIED - OBSERVED ON WIRE]**: YES (`68681258-2a80-4d31-81e3-0bd436e3658d`).
  - **New `Mcp-Session-Id`?** **[VERIFIED - OBSERVED ON WIRE]**: YES (`1be9c46c-fc43-4a63-95b2-0d3fd21a3172` vs `ff89a6ce-...`).
  - **New PID?** **[VERIFIED - OBSERVED ON WIRE]**: YES (PID `863339` vs `684782`).

---

### T4: Sub-Invocations

- **Methodology**:
  - Spawned child subagent (`1d67c7e0-40c0-4804-bded-7ddc91e33376`) from parent conversation X (`68681258-2a80-4d31-81e3-0bd436e3658d`) inside PID `684782`.
  - Subagent executed two consecutive tool calls (`handle="subagent-test"`, `handle="subagent-call-2"`).

#### T4 Results Table

| Call | Method | Client Port | agy PID | `Mcp-Session-Id` | `conversation_id` | `root_conversation_id` | `parent_conversation_id` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Call 1 | `tools/call` (`a2a_hello`) | 41173 | 684782 | `ff89a6ce-ebec-4f85-b9f7-ceca88d6e26a` | `1d67c7e0-40c0-4804-bded-7ddc91e33376` | `68681258-2a80-4d31-81e3-0bd436e3658d` | `68681258-2a80-4d31-81e3-0bd436e3658d` |
| Call 2 | `tools/call` (`a2a_hello`) | 41173 | 684782 | `ff89a6ce-ebec-4f85-b9f7-ceca88d6e26a` | `1d67c7e0-40c0-4804-bded-7ddc91e33376` | `68681258-2a80-4d31-81e3-0bd436e3658d` | `68681258-2a80-4d31-81e3-0bd436e3658d` |

#### Raw NDJSON Excerpts (T4)

```json
{"timestamp": "2026-11-04T21:06:12.133361+00:00", "client_source_port": 41173, "agy_pid": 684782, "http_method": "POST", "jsonrpc_method": "tools/call", "mcp_session_id": "ff89a6ce-ebec-4f85-b9f7-ceca88d6e26a", "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": {"antigravity.google/artifacts_dir": "/home/rockad/.gemini/antigravity-cli/brain/1d67c7e0-40c0-4804-bded-7ddc91e33376", "antigravity.google/conversation_id": "1d67c7e0-40c0-4804-bded-7ddc91e33376", "antigravity.google/parent_conversation_id": "68681258-2a80-4d31-81e3-0bd436e3658d", "antigravity.google/root_conversation_id": "68681258-2a80-4d31-81e3-0bd436e3658d", "progressToken": "0f341f39-3970-49b9-8996-d0400b21a344:3"}}
{"timestamp": "2026-11-04T21:07:38.163254+00:00", "client_source_port": 41173, "agy_pid": 684782, "http_method": "POST", "jsonrpc_method": "tools/call", "mcp_session_id": "ff89a6ce-ebec-4f85-b9f7-ceca88d6e26a", "user_agent": "Go-http-client/1.1", "authorization_present": "yes", "params_meta": {"antigravity.google/artifacts_dir": "/home/rockad/.gemini/antigravity-cli/brain/1d67c7e0-40c0-4804-bded-7ddc91e33376", "antigravity.google/conversation_id": "1d67c7e0-40c0-4804-bded-7ddc91e33376", "antigravity.google/parent_conversation_id": "68681258-2a80-4d31-81e3-0bd436e3658d", "antigravity.google/root_conversation_id": "68681258-2a80-4d31-81e3-0bd436e3658d", "progressToken": "0f341f39-3970-49b9-8996-d0400b21a344:12"}}
```

- **Verdict on T4**:
  - `root_conversation_id` matches parent Conversation X (`68681258-2a80-4d31-81e3-0bd436e3658d`).
  - `parent_conversation_id` matches parent Conversation X (`68681258-2a80-4d31-81e3-0bd436e3658d`).
  - `conversation_id` uniquely identifies the subagent (`1d67c7e0-40c0-4804-bded-7ddc91e33376`).
  - Both tool calls reuse the same process-level `Mcp-Session-Id` (`ff89a6ce-ebec-4f85-b9f7-ceca88d6e26a`).

---

## 3. Teardown & Cleanup Confirmation

- **MCP Configuration Removed**:
  - Executed `agy mcp remove a2a-stub`.
  - Verified `jq '.mcpServers["a2a-stub"]' ~/.gemini/config/mcp_config.json` returns `null`.
- **Stub Process Terminated**:
  - Background process running `sp2_a4_stub.py` terminated.
  - Verified via `ss -tulpn` that loopback port `18126` is completely free.
- **Scratch Files Cleaned**:
  - Temporary schemas in `~/.gemini/antigravity-cli/mcp/a2a-stub/` removed.
  - Test request logs cleaned up.

---

## 4. Appendix: SP2 A4 MCP Stub Server Source

```python
#!/usr/bin/env python3
"""
Streamable HTTP MCP Stub for SP2 A4 (agy session identity verification).
- Binds to 127.0.0.1 on specified port (default: 18126).
- Requires "Authorization: Bearer spike-token".
- Issues a FRESH random UUID as Mcp-Session-Id on every initialize.
- Maps client source port to PID using `ss -tnp` while connection is open.
- Logs every request as one JSON line with:
  timestamp, client_source_port, agy_pid, http_method, jsonrpc_method,
  mcp_session_id, user_agent, authorization_present, params_meta.
"""

import sys
import os
import json
import time
import uuid
import datetime
import re
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

PORT = 18126
BEARER_TOKEN = "spike-token"
LOG_FILE = "/home/rockad/.gemini/antigravity-cli/brain/68681258-2a80-4d31-81e3-0bd436e3658d/scratch/stub_requests.jsonl"

def lookup_pid(client_port):
    """Query ss -tnp to find PID associated with client port while connection is live."""
    for _ in range(3):
        try:
            out = subprocess.check_output(
                ["ss", "-tnp", f"sport = :{client_port} or dport = :{client_port}"],
                text=True,
                timeout=1
            )
            for line in out.splitlines():
                if f":{client_port}" in line and "pid=" in line:
                    m = re.search(r'pid=(\d+)', line)
                    if m:
                        return int(m.group(1))
        except Exception:
            pass
        time.sleep(0.01)
    return None

def append_log(entry):
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
        f.flush()

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

class McpStubHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    def check_auth(self):
        auth_header = self.headers.get("Authorization", "")
        if auth_header == f"Bearer {BEARER_TOKEN}":
            return True
        return False

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id")
        self.end_headers()

    def do_GET(self):
        client_port = self.client_address[1]
        agy_pid = lookup_pid(client_port)
        auth_present = "yes" if bool(self.headers.get("Authorization")) else "no"
        mcp_session_id = self.headers.get("Mcp-Session-Id")
        user_agent = self.headers.get("User-Agent", "")

        log_entry = {
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "client_source_port": client_port,
            "agy_pid": agy_pid,
            "http_method": "GET",
            "jsonrpc_method": None,
            "mcp_session_id": mcp_session_id,
            "user_agent": user_agent,
            "authorization_present": auth_present,
            "params_meta": None
        }
        append_log(log_entry)

        if not self.check_auth():
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Bearer error="invalid_token"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if self.path.startswith("/.well-known"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        if mcp_session_id:
            self.send_header("Mcp-Session-Id", mcp_session_id)
        self.end_headers()

        msg = f"event: endpoint\ndata: /mcp\n\n"
        try:
            self.wfile.write(msg.encode("utf-8"))
            self.wfile.flush()
        except Exception:
            pass

    def do_DELETE(self):
        client_port = self.client_address[1]
        agy_pid = lookup_pid(client_port)
        auth_present = "yes" if bool(self.headers.get("Authorization")) else "no"
        mcp_session_id = self.headers.get("Mcp-Session-Id")
        user_agent = self.headers.get("User-Agent", "")

        log_entry = {
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "client_source_port": client_port,
            "agy_pid": agy_pid,
            "http_method": "DELETE",
            "jsonrpc_method": None,
            "mcp_session_id": mcp_session_id,
            "user_agent": user_agent,
            "authorization_present": auth_present,
            "params_meta": None
        }
        append_log(log_entry)

        if not self.check_auth():
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Bearer error="invalid_token"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        client_port = self.client_address[1]
        agy_pid = lookup_pid(client_port)
        auth_present = "yes" if bool(self.headers.get("Authorization")) else "no"
        incoming_session_id = self.headers.get("Mcp-Session-Id")
        user_agent = self.headers.get("User-Agent", "")

        content_length = int(self.headers.get("Content-Length", 0))
        body_bytes = self.rfile.read(content_length) if content_length > 0 else b""
        
        parsed_body = {}
        jsonrpc_method = None
        params_meta = None
        req_id = 1

        if body_bytes:
            try:
                parsed_body = json.loads(body_bytes.decode("utf-8"))
                if isinstance(parsed_body, dict):
                    jsonrpc_method = parsed_body.get("method")
                    req_id = parsed_body.get("id", 1)
                    params = parsed_body.get("params")
                    if isinstance(params, dict):
                        params_meta = params.get("_meta")
            except Exception:
                pass

        if not self.check_auth():
            log_entry = {
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "client_source_port": client_port,
                "agy_pid": agy_pid,
                "http_method": "POST",
                "jsonrpc_method": jsonrpc_method,
                "mcp_session_id": incoming_session_id,
                "user_agent": user_agent,
                "authorization_present": auth_present,
                "params_meta": params_meta
            }
            append_log(log_entry)
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Bearer error="invalid_token"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if jsonrpc_method == "initialize":
            issued_session_id = str(uuid.uuid4())
            log_entry = {
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "client_source_port": client_port,
                "agy_pid": agy_pid,
                "http_method": "POST",
                "jsonrpc_method": jsonrpc_method,
                "mcp_session_id": issued_session_id,
                "incoming_mcp_session_id": incoming_session_id,
                "user_agent": user_agent,
                "authorization_present": auth_present,
                "params_meta": params_meta
            }
            append_log(log_entry)

            resp_data = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "a2a-stub",
                        "version": "1.0.0"
                    }
                }
            }
            body = json.dumps(resp_data).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Mcp-Session-Id", issued_session_id)
            self.end_headers()
            self.wfile.write(body)
            return

        log_entry = {
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "client_source_port": client_port,
            "agy_pid": agy_pid,
            "http_method": "POST",
            "jsonrpc_method": jsonrpc_method,
            "mcp_session_id": incoming_session_id,
            "user_agent": user_agent,
            "authorization_present": auth_present,
            "params_meta": params_meta
        }
        append_log(log_entry)

        if jsonrpc_method in ("notifications/initialized", "notifications/roots/list_changed"):
            self.send_response(200)
            self.send_header("Content-Length", "0")
            if incoming_session_id:
                self.send_header("Mcp-Session-Id", incoming_session_id)
            self.end_headers()
            return

        if jsonrpc_method == "tools/list":
            resp_data = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "tools": [
                        {
                            "name": "a2a_hello",
                            "description": "A2A stub hello verification tool",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "handle": {
                                        "type": "string",
                                        "description": "Handle or label identifying the call"
                                    }
                                }
                            }
                        },
                        {
                            "name": "a2a_identity_probe",
                            "description": "Probe tool that verifies conversation metadata and session identity",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "call_label": {
                                        "type": "string",
                                        "description": "Label identifying the call or test phase"
                                    }
                                }
                            }
                        }
                    ]
                }
            }
            body = json.dumps(resp_data).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            if incoming_session_id:
                self.send_header("Mcp-Session-Id", incoming_session_id)
            self.end_headers()
            self.wfile.write(body)
            return

        if jsonrpc_method == "tools/call":
            call_label = ""
            tool_name = ""
            if isinstance(parsed_body.get("params"), dict):
                tool_name = parsed_body["params"].get("name", "")
                args = parsed_body["params"].get("arguments", {})
                if isinstance(args, dict):
                    call_label = args.get("call_label") or args.get("handle") or ""

            resp_data = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": f"Stub {tool_name} acknowledged: handle={call_label}"
                        }
                    ]
                }
            }
            body = json.dumps(resp_data).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            if incoming_session_id:
                self.send_header("Mcp-Session-Id", incoming_session_id)
            self.end_headers()
            self.wfile.write(body)
            return

        resp_data = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {}
        }
        body = json.dumps(resp_data).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if incoming_session_id:
            self.send_header("Mcp-Session-Id", incoming_session_id)
        self.end_headers()
        self.wfile.write(body)

if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), McpStubHandler)
    print(f"Stub listening on http://127.0.0.1:{PORT}/mcp", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
```

---

## 5. Review by Claude Code (2026-11-04)

Review of sections 1 to 4, which are unchanged.

- **Verdict: the results are solid.** The evidence is raw NDJSON from a stub that issues a fresh `Mcp-Session-Id` per `initialize`. PIDs 863339 (the resumed conversation 68681258) and 901400 (the separate process) were still live when Claude Code checked, consistent with the report.
- **T1 (same process, `/clear`):** one `Mcp-Session-Id` shared across two conversations in one agy process, with different `conversation_id` values. `Mcp-Session-Id` is therefore process-scoped on the wire, which also confirms the section 1.5 claim of the A6 results file. [verified]
- **T2 (separate processes):** each process has its own `Mcp-Session-Id` and `conversation_id`. [verified]
- **T3 (exit and resume):** after a full exit (`DELETE /mcp` seen) and `agy --conversation <id>`, `conversation_id` and `root_conversation_id` are identical, with a new `Mcp-Session-Id` and a new PID. [verified]
  - Minor caveat: the T3 pre-restart row is taken from a subagent call. Its `conversation_id` was the subagent's (`1d67c7e0-...`); the `68681258-...` shown there is the root id. Stability is still demonstrated, because the resume used `agy --conversation 68681258-...` and the post-resume calls carried exactly that `conversation_id`.
- **T4 (subagent):** the subagent's calls carry its own `conversation_id`, plus `root_conversation_id` and `parent_conversation_id` equal to the parent's. [verified]
- **Consequence for the design:** the agy handle binds to `conversation_id` (not to `Mcp-Session-Id`), background or sub-invocations group under the parent by `root_conversation_id`, and `parent_conversation_id` is recorded. `/clear` in agy starts a new conversation, so it gets a new handle. SP2 A1 and A4 are answered for agy.
