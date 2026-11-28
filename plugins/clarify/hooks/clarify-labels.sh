#!/usr/bin/env bash
# clarify-labels.sh - Claude Code PreToolUse wrapper (matcher AskUserQuestion) for clarify-labels.mjs.
# Denies a clarify question whose dialog labels break the naming rule (issue #123). Silent
# otherwise. Fails open, loudly: a missing node is reported on stderr, never blocks a question.

command -v node >/dev/null 2>&1 || { echo "clarify-labels: node is not installed, option-label check skipped" >&2; exit 0; }
exec node "$(cd "$(dirname "$0")" && pwd)/clarify-labels.mjs" claude-pre
