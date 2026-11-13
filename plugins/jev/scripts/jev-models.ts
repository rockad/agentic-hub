#!/usr/bin/env bun
/**
 * jev-models: model catalogue commands. Each subcommand lives in its own module under `src/`; this file only dispatches.
 *
 *   bun scripts/jev-models.ts refresh [--harness claude-code|opencode|antigravity] [--max-calls N] [--quiet]
 *   bun scripts/jev-models.ts status  [--harness ...]
 *   bun scripts/jev-models.ts list    [--harness ...] [--json]
 *   bun scripts/jev-models.ts ladder-agents --dir <directory> [--harness claude-code] [--max-tier free|cheap|standard|deep]
 */
import { runLadderAgents, LADDER_AGENTS_USAGE } from '../src/refresh/ladder-agents.js';
import { runCli } from '../src/refresh/cli.js';

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'ladder-agents') {
    process.exit(await runLadderAgents(rest));
  } else if (command === 'refresh' || command === 'status' || command === 'list') {
    process.exit(await runCli(process.argv.slice(2)));
  } else {
    console.error(`usage: jev-models <command>\ncommands: refresh, status, list, ladder-agents\n\n${LADDER_AGENTS_USAGE}`);
    process.exit(command ? 2 : 0);
  }
}
