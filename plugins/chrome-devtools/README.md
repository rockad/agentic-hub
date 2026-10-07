# Chrome Browser Automation Plugin (`chrome-browser`)

Enables AI agents (Google Antigravity, Claude Code, OpenCode) to control a native Google Chrome browser instance via the Chrome DevTools Protocol (CDP) and `chrome-devtools-mcp`.

---

## Overview

In WSL or Linux development environments, interacting with a desktop browser typically requires complex display configurations or headless browsers that lack user session context. 

The `chrome-browser` plugin solves this by:
1. **Bridging WSL to Windows Chrome**: Automates Chrome directly on the host using a resilient launcher (`scripts/launch-windows.js`) via PowerShell.
2. **Dedicated Debug Profile**: Launches Chrome with `--remote-debugging-port=9222`, `--remote-allow-origins=*`, and an isolated persistent profile directory (`%USERPROFILE%\.config\chrome-devtools-mcp\profile`), preventing collisions with your daily browsing sessions.
3. **Resilient Process Management**: If Chrome is already running without debugging enabled on the debug profile, the launcher cleanly restarts the debug instance and guarantees port 9222 availability before connecting the MCP server.

---

## Features & Available Tools

Bridges directly to the `chrome-devtools` MCP server, exposing full page automation:

| Tool | Purpose | Primary Arguments |
| :--- | :--- | :--- |
| `list_pages` | List all open tabs and pages with IDs and titles | *(none)* |
| `new_page` | Open a new tab | `url` (optional) |
| `navigate_page` | Navigate to URL, reload, or navigate back/forward | `pageId`, `type`, `url` |
| `close_page` | Close a tab | `pageId` |
| `evaluate_script` | Evaluate JavaScript in the page context | `pageId`, `function` |
| `take_screenshot` | Capture visual screenshot of page or element | `pageId`, `format`, `quality` |
| `click` | Click on a DOM element | `pageId`, `selector` |
| `fill` | Type text into an input or form field | `pageId`, `selector`, `value` |
| `fill_form` | Batch fill form fields | `pageId`, `elements` |
| `wait_for` | Wait for selector or navigation event | `pageId`, `selector` |

---

## Installation

### Google Antigravity
Install via the marketplace manifest:
```bash
agy marketplace add https://github.com/rockad/agentic-hub.git
```
Or toggle on-demand via the MCP switcher:
```bash
mcp-toggle chrome-devtools on
```

### Claude Code
Install directly from the Claude Code marketplace:
```bash
/plugin marketplace add rockad/agentic-hub
/plugin install chrome-browser@agentic-hub
```

---

## Configuration & Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `CHROME_DEBUG_PORT` | Remote debugging port | `9222` |
| `CHROME_WINDOWS_PATH` | Path to Windows Chrome executable | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| `CHROME_PROFILE_DIR` | Dedicated profile directory | `%USERPROFILE%\.config\chrome-devtools-mcp\profile` |
| `CHROME_READY_TIMEOUT_MS` | Timeout for Chrome to become ready | `25000` |

---

## License

MIT — see [LICENSE](../../LICENSE) for details.
