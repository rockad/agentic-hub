/**
 * Test preload (bunfig.toml): run every test file against a fresh, empty home directory and without
 * credentials. Several modules read os.homedir() when they load (config, telemetry, egress, discovery, and
 * src/core/client.ts, which loads ~/.config/zsh/secrets.env, ~/.config/jev/env and the Antigravity .env into
 * process.env at import; JEV_SECRETS_FILES, set below, now pins that list to the temporary home), so the real ~/.agents, ~/.config/jev and ~/.gemini must never leak into a run.
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
      'bun fixes os.homedir() at startup, so modules that build paths from it at import see your REAL home ' +
      '(API keys are not among them: the secrets loader reads HOME at call time and JEV_SECRETS_FILES pins it, see below). ' +
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

// The router's decision cache lives in a machine-wide file (/dev/shm/jev/cache.sqlite) unless JEV_CACHE_FILE says otherwise,
// and a rating cached there by an earlier real run would answer a test's router call without a key. Point it inside the
// temporary home, after the scrub above, so every test and every process a test spawns uses a private cache.
process.env.JEV_CACHE_FILE = path.join(home, 'decision-cache.sqlite');

// Secrets: src/core/client.ts loads API keys from ~/.config/zsh/secrets.env, ~/.config/jev/env and the Antigravity .env.
// It builds that list from HOME at call time, and JEV_SECRETS_FILES replaces the list. Under plain `bun test` bun keeps the
// real os.homedir(), so the list is pinned here to files inside the temporary home (none exists): no real key can be loaded,
// by this process or by any process a test spawns (they inherit this variable).
process.env.JEV_SECRETS_FILES = path.join(home, '.config', 'jev', 'test-secrets.env');

// No test may start a real catalogue refresh: the SessionStart hook launches a detached refresh when the catalogue is
// missing, and that refresh runs paid `claude -p` probes. Set after the scrub above, so every process a test spawns
// inherits it. The one test that exercises the real trigger deletes it from its own env and points JEV_REFRESH_SCRIPT
// at a stub (tests/claude-hook-process.test.ts).
process.env.JEV_MODEL_REFRESH = 'off';

// The legacy schema-1 quota fallback is a machine-wide file (/tmp/antigravity-quota.json) that a running Antigravity
// statusline keeps rewriting. Outside HOME, it would make a test's quota strategy follow the developer's live quota (a
// conserve or free_only reading blocks the elevation tests). Pin it to a file that does not exist; tests that need a
// legacy quota set JEV_QUOTA_LEGACY_FILE themselves. Spawned hook processes inherit it through process.env.
process.env.JEV_QUOTA_LEGACY_FILE = path.join(home, 'no-legacy-antigravity-quota.json');

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
