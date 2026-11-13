/**
 * Test preload (bunfig.toml): run every test file against a fresh, empty home directory and without
 * credentials. Several modules read os.homedir() when they load (config, telemetry, egress, discovery, and
 * src/core/client.ts, which loads ~/.config/zsh/secrets.env, ~/.config/jev/env and the Antigravity .env into
 * process.env at import), so the real ~/.agents, ~/.config/jev and ~/.gemini must never leak into a run.
 * This file runs before any test file loads.
 *
 * Caveat: bun keeps the os.homedir() it started with (checked on 1.3.12 and 1.4.3), so assigning
 * process.env.HOME here does not move it. `bun run test` (scripts/run-tests.ts) sets a fresh HOME before bun
 * starts and is the supported entry point. Under plain `bun test` the override below only covers code that
 * reads process.env.HOME, and this file prints a warning.
 * A test that needs different values still sets its own env or spawns a process with its own HOME.
 */
import { afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PREFIX = 'jev-test-home-';
const startedIn = os.homedir();
const prepared = path.basename(startedIn).startsWith(PREFIX) && fs.existsSync(startedIn);
const home = prepared ? startedIn : fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));

process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.XDG_CONFIG_HOME;
delete process.env.JEV_CONFIG_FILE;

if (os.homedir() !== home) {
  console.error(
    `[jev tests] WARNING: os.homedir() is still ${os.homedir()}, not the temporary home ${home}. ` +
      'bun fixes os.homedir() at startup, so modules that build paths from it (src/core/client.ts reads ' +
      '~/.config/zsh/secrets.env, ~/.config/jev/env and the Antigravity .env) see your REAL home. ' +
      'Run `bun run test`, or start bun with HOME set to an empty directory.'
  );
}

// Harness detection (detectActiveHarness) reads these: a run inside Claude Code or Antigravity must not
// change what a test sees. Tests that need a harness set JEV_HARNESS or the marker themselves.
// Credentials are scrubbed too: a developer's OPENROUTER_API_KEY must not turn an offline test into a live call.
// Tests that need a key or a JEV_* value set it themselves, after this preload.
for (const name of Object.keys(process.env)) {
  if (
    /^(ANTIGRAVITY_|CLAUDE_CODE|OPENCODE_|JEV_)/.test(name) ||
    /KEY|TOKEN|SECRET/i.test(name) ||
    ['OPENROUTER_API_KEY', 'GEMINI_CLI', 'CORTEX_SESSION', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR'].includes(name)
  ) {
    delete process.env[name];
  }
}

// bun test does not emit process 'exit' or 'beforeExit' (checked on 1.4.3); a preload afterAll runs once, after the last file.
// A home created by `bun run test` belongs to that script, which removes it.
afterAll(() => {
  if (prepared) return;
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // best-effort cleanup of a temp directory
  }
});
