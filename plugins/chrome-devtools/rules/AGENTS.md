# Chrome DevTools: Rules & Guidelines

This document governs browser automation workflows and hygiene for AI agents using the `chrome-devtools` plugin via Chrome DevTools Protocol (`chrome-devtools-mcp`).

## 1. Safety & Tab Hygiene

- **Do NOT Close User Tabs**: The browser is connected to the user's live desktop environment. Only close tabs that were explicitly created by an agent during the current session.
- **Inspect Open Tabs First**: Always begin tasks by calling `list_pages` to inspect existing tabs and discover `pageId`s.
- **Reuse Existing Tabs**: Reuse an existing blank or completed page whenever appropriate rather than endlessly spawning new tabs.
- **Tab Grouping**: When opening tabs for research or automation, keep them organized under the "AI" tab group where supported or within designated windows.

## 2. Interaction & DOM Discipline

- **DOM Wait & State Verification**: Single Page Applications (SPAs) and dynamic web interfaces require elements to be mounted before interaction. Use `wait_for` or `evaluate_script` to verify element readiness before clicking or typing.
- **Snapshot Before Action**: Call `take_snapshot` to retrieve semantic element `uid`s before issuing click or fill actions.
- **Semantic Selectors**: Prefer robust CSS selectors, test IDs, or unique element attributes over fragile positional selectors.

## 3. Authentication & Bot Friction

- **Session Persistence**: Chrome operates with persistent profile state at `%USERPROFILE%\.config\chrome-devtools-mcp\profile`. Logins and cookies persist across runs.
- **Bot Detection & Manual Login**: If a site blocks automation (e.g. Google Accounts bot check), do not attempt to bypass it programmatically. Direct the user to complete the authentication manually in the persistent browser profile, then resume.
