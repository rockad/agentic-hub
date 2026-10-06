---
name: chrome-browser
description: Automate browsing and web inspection using persistent Windows Chrome via Chrome DevTools Protocol. Supports page navigation, script evaluation, screenshots, and AI tab group management.
when_to_use: Automate web browsing, interact with dynamic web applications, fill forms, take screenshots, or inspect page DOM using Chrome DevTools Protocol.
metadata:
  author: aleksandr
  requires: chrome-devtools-mcp
---

# Chrome Browser Automation Skill

This skill guides AI agents (Google Antigravity, Claude Code, and other assistants) in controlling Google Chrome running on Windows via the Chrome DevTools Protocol (`chrome-devtools-mcp`).

## 1. Tool Mapping & Capabilities

The following MCP tools are available under the `chrome-devtools` server:

| Tool | Purpose | Primary Arguments |
| :--- | :--- | :--- |
| `list_pages` | List all open tabs and pages with their IDs and titles | *(none)* |
| `new_page` | Open a new blank or target page | `url` (optional) |
| `navigate_page` | Go to a specific URL, reload, or navigate back/forward | `pageId`, `type` (`url`), `url` |
| `close_page` | Close a tab | `pageId` |
| `evaluate_script` | Run arbitrary JavaScript inside a page's context | `pageId`, `function` |
| `take_screenshot` | Capture visual state of a page or element | `pageId`, `format`, `quality` |
| `click` | Click on a DOM element | `pageId`, `selector` |
| `fill` | Type text into an input or form field | `pageId`, `selector`, `value` |
| `fill_form` | Batch fill multiple form elements | `pageId`, `elements` |
| `hover` | Hover over an element | `pageId`, `selector` |
| `wait_for` | Wait for selector or navigation event | `pageId`, `selector` |

## 2. Browsing Workflows & Rules

1. **Always inspect open tabs first**:
   - Begin tasks by calling `list_pages` to see existing tabs.
   - Reuse an existing blank or completed page when appropriate rather than endlessly spawning new tabs.

2. **Respect the user's browser environment**:
   - The browser is connected to the user's desktop environment.
   - Do **NOT** close user tabs. Only close tabs that were created by the agent during the current session.

3. **Tab Grouping ("AI" Tab Group)**:
   - When opening new tabs for research or tasks, keep them organized.
   - The user has configured Tab Manager AI / tab group extensions. You can evaluate scripts to group agent tabs under an "AI" group or use designated windows.

4. **Interacting with Dynamic Web Content**:
   - For Single Page Applications (SPAs) and dynamic apps, use `evaluate_script` to check DOM state and verify that elements are mounted before clicking.
   - Prefer semantic CSS selectors or unique element IDs.

5. **Authentication & Bot Friction**:
   - Because Chrome runs with `--remote-allow-origins=*` and an isolated profile at `%USERPROFILE%\.config\chrome-devtools-mcp\profile`, logins and cookies persist across sessions.
   - If a site (like Google Accounts) triggers bot detection (*"This browser or app may not be secure"*), instruct the user to complete the initial login in that profile with the debugger detached. Future agent runs will inherit the authenticated session.
