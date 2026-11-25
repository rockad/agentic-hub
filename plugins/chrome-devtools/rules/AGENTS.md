# Chrome DevTools: Rules & Guidelines

Governs browser automation and tab hygiene via `chrome-devtools-mcp`.

- **Safety & Tab Hygiene**: Never close user tabs; close only agent-created session tabs. Call `list_pages` first to inspect `pageId`s, reuse blank/completed tabs when appropriate, and keep automation tabs in the "AI" tab group where supported.
- **SPA & DOM Discipline**: Wait for dynamic elements (`wait_for` or `evaluate_script`) before interacting. Call `take_snapshot` for semantic `uid`s before click/fill actions, and prefer robust CSS, test-ID, or unique attributes over positional selectors.
- **Auth & Bot Checks**: Persistent profile state lives at `%USERPROFILE%\.config\chrome-devtools-mcp\profile`. Never bypass bot detection or CAPTCHAs programmatically; pause and ask the user to authenticate manually in the persistent profile.
