#!/usr/bin/env bun
/**
 * Refresh, inspect and list the Jev model catalogue. Run with bun:
 *
 *   bun scripts/jev-models.ts refresh [--harness claude-code|opencode|antigravity] [--max-calls N] [--quiet]
 *   bun scripts/jev-models.ts status  [--harness ...]
 *   bun scripts/jev-models.ts list    [--harness ...] [--json]
 *
 * The logic lives in src/refresh/cli.ts.
 */
import { runCli } from '../src/refresh/cli.js';

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
