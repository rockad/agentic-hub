/**
 * Test preload (bunfig.toml): run every test file against a fresh, empty home directory.
 * Several modules read os.homedir() when they load (config, telemetry, egress, discovery), so the real
 * ~/.agents, ~/.config/jev and ~/.gemini must never leak into a run. This file runs before any test file loads.
 * A test that needs different values still sets its own env or spawns a process with its own HOME.
 */
import { afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-test-home-'));

process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.XDG_CONFIG_HOME;
delete process.env.JEV_CONFIG_FILE;

// Harness detection (detectActiveHarness) reads these: a run inside Claude Code or Antigravity must not
// change what a test sees. Tests that need a harness set JEV_HARNESS or the marker themselves.
for (const name of Object.keys(process.env)) {
  if (/^(ANTIGRAVITY_|CLAUDE_CODE|OPENCODE_)/.test(name) || ['JEV_HARNESS', 'GEMINI_CLI', 'CORTEX_SESSION', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR'].includes(name)) {
    delete process.env[name];
  }
}

// bun test does not emit process 'exit' or 'beforeExit' (checked on 1.4.3); a preload afterAll runs once, after the last file.
afterAll(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // best-effort cleanup of a temp directory
  }
});
