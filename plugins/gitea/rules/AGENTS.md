# Gitea: Rules & Guidelines

This document governs repository interaction, issue tracking, and commit practices for AI agents interacting with Gitea via the `gitea` plugin and `gitea-mcp`.

## 1. Commit Discipline & Guidelines

- **Meaningful Commits**: Use semantic commit message conventions (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`) describing the why and what clearly.
- **Commit Cadence**: Commit at genuine milestones or when explicitly instructed, never per incidental edit.
- **Pushing**: Push to remotes only when explicitly asked by the user.
- **Pre-Commit Checks**: Verify working trees and inspect `git log --oneline -3` before assuming changes are uncommitted.
- **Branch Discipline**: For repository file mutations via `create_or_update_file`, always supply a descriptive commit message and target branch.

## 2. Issue & Action Management

- **Issue Reading**: Read issues before making assumptions about reported bugs or feature requirements.
- **CI / Actions Visibility**: Use `actions_run_read` to inspect Gitea Actions build and CI status when diagnosing pipeline failures.
- **Tree Exploration**: Prefer targeted searches over massive recursive `get_repository_tree` dumps to keep context clean.
