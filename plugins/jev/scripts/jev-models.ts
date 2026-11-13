#!/usr/bin/env bun
/**
 * jev-models: model catalogue commands. Each subcommand lives in its own module under `src/`; this file only dispatches.
 *
 *   bun scripts/jev-models.ts ladder-agents --dir <directory> [--harness claude-code]
 */
import { runLadderAgents, LADDER_AGENTS_USAGE } from '../src/refresh/ladder-agents.js';

const COMMANDS: Record<string, (argv: readonly string[]) => number | Promise<number>> = {
  'ladder-agents': runLadderAgents
};

const [command, ...rest] = process.argv.slice(2);
const run = command ? COMMANDS[command] : undefined;
if (!run) {
  console.error(`usage: jev-models <command>\ncommands: ${Object.keys(COMMANDS).join(', ')}\n\n${LADDER_AGENTS_USAGE}`);
  process.exit(command ? 2 : 0);
}
process.exit(await run(rest));
