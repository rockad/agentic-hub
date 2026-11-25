# Gitea: Rules & Guidelines

Governs repository interaction, issue tracking, and commit discipline via `gitea` and `gitea-mcp`.

- **Commits & Branches**: Use semantic messages (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`) explaining why and what. Commit only at genuine milestones or when instructed; push only when explicitly asked. Check working trees and `git log --oneline -3` before assuming uncommitted state. Always supply a descriptive commit message and target branch for `create_or_update_file`.
- **Issues, CI & Exploration**: Read issues before assuming bug/feature requirements. Inspect pipeline failures with `actions_run_read`. Prefer targeted searches over massive recursive `get_repository_tree` dumps.
