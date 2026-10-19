import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const JEV_MODE = path.join(PLUGIN_ROOT, 'scripts', 'jev-mode');

let tmp = '';
let home = '';
let binDir = '';

function env(): Record<string, string> {
  return { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`, HOME: home, JEV_CACHE_FILE: ':memory:' };
}

function runJevMode(mode: string): void {
  Bun.spawnSync(['bash', JEV_MODE, mode], { env: env(), stdout: 'pipe', stderr: 'pipe' });
}

// The hooks read the mode in a fresh process; HOME is resolved once per process.
function claudeCodeMode(): string {
  const res = Bun.spawnSync(
    ['bun', '-e', `import { readJevMode } from '${PLUGIN_ROOT}/src/core/config.ts'; console.log(await readJevMode('claude-code'));`],
    { env: env(), stdout: 'pipe', stderr: 'pipe' }
  );
  return res.stdout.toString().trim();
}

describe('scripts/jev-mode as seen by the Claude Code hooks', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-mode-'));
    home = path.join(tmp, 'home');
    binDir = path.join(tmp, 'bin');
    fs.mkdirSync(home);
    fs.mkdirSync(binDir);
    // Stand-in for the Antigravity CLI, which the script calls after writing the mode.
    fs.writeFileSync(path.join(binDir, 'agy'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('turns the Claude Code hooks off', () => {
    runJevMode('off');

    expect(claudeCodeMode()).toBe('off');
  });

  it('turns the Claude Code hooks back on after jev_set_mode switched them off', () => {
    // What jev_set_mode("off") leaves behind.
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode: 'off' } }));

    runJevMode('on');

    expect(claudeCodeMode()).toBe('on');
  });

  it('switches the Claude Code hooks to on-demand', () => {
    runJevMode('on-demand');

    expect(claudeCodeMode()).toBe('on-demand');
  });
});
