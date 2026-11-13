/**
 * Telemetry privacy: files the plugin writes outside the Claude hook state are owner-only (0600 files, 0700
 * directories, tightened at write time even when they already exist), and the dispatch line carries
 * task metadata (taskLen, taskHash) instead of prompt text.
 * Every write runs in its own process with HOME pointed at a temp directory, because the telemetry paths are
 * fixed from os.homedir() when the module loads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { privateDir, privateFile } from '../src/core/private-fs.ts';
import { taskFingerprint } from '../src/core/telemetry.ts';

const SRC = path.join(import.meta.dir, '..', 'src');
const RUNNER = path.join(import.meta.dir, 'fixtures', 'run-dispatch.ts');
const MARKER = 'ZEBRA-PROMPT-MARKER-4471 refactor the payroll secrets handler';
const mode = (p: string): number => fs.statSync(p).mode & 0o777;

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-telpriv-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const telemetryDir = () => path.join(home, '.gemini', 'antigravity-cli');
const telemetryFile = () => path.join(telemetryDir(), 'jev_telemetry.jsonl');
const egressFile = () => path.join(home, '.config', 'jev', 'egress-log.jsonl');

function env(extra: Record<string, string> = {}): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/KEY|TOKEN|SECRET/.test(k)) clean[k] = v;
  return { ...clean, HOME: home, JEV_CONFIG_FILE: path.join(home, 'config.json'), JEV_CACHE_FILE: path.join(home, 'cache.sqlite'), ...extra };
}

function runScript(code: string, extra: Record<string, string> = {}): void {
  const proc = Bun.spawnSync(['bun', '-e', code], { env: env(extra) });
  if (proc.exitCode !== 0) throw new Error(`script failed: ${proc.stderr.toString()}`);
}

const writeBoth = `
import { logTelemetry, logJevTelemetry } from '${SRC}/core/telemetry.ts';
await logTelemetry({ tool: 'jev_probe', n: 1 });
await logJevTelemetry({ harness: 'claude', toolOrHook: 'probe' });
`;

describe('telemetry file modes', () => {
  it('creates the directory 0700 and the file 0600', () => {
    runScript(writeBoth);

    expect([mode(telemetryDir()), mode(telemetryFile())]).toEqual([0o700, 0o600]);
    expect(fs.readFileSync(telemetryFile(), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('tightens a directory and file that already exist as 0755 and 0644', () => {
    fs.mkdirSync(telemetryDir(), { recursive: true });
    fs.chmodSync(telemetryDir(), 0o755);
    fs.writeFileSync(telemetryFile(), '{"old":true}\n', { mode: 0o644 });
    fs.chmodSync(telemetryFile(), 0o644);

    runScript(writeBoth);

    expect([mode(telemetryDir()), mode(telemetryFile())]).toEqual([0o700, 0o600]);
    expect(fs.readFileSync(telemetryFile(), 'utf8')).toStartWith('{"old":true}\n');
  });

  it('tightens the egress log and its directory too', () => {
    fs.mkdirSync(path.dirname(egressFile()), { recursive: true });
    fs.chmodSync(path.dirname(egressFile()), 0o755);
    fs.writeFileSync(egressFile(), '', { mode: 0o644 });
    fs.chmodSync(egressFile(), 0o644);
    fs.writeFileSync(path.join(home, '.config', 'jev', 'egress.json'), JSON.stringify({ allow: [] }));

    runScript(
      `
      import { assertEgressAllowed } from '${SRC}/core/egress.ts';
      try { assertEgressAllowed('https://openrouter.ai/api/v1/x', '{}', []); } catch {}
    `,
      { JEV_ZDR: 'on' }
    );

    expect([mode(path.dirname(egressFile())), mode(egressFile())]).toEqual([0o700, 0o600]);
    expect(fs.readFileSync(egressFile(), 'utf8').trim()).not.toBe('');
  });
});

describe('private-fs helpers never throw', () => {
  it('privateFile ignores a missing file', () => {
    expect(() => privateFile(path.join(home, 'nope', 'missing.jsonl'))).not.toThrow();
  });

  it('privateDir and privateFile do not throw when chmod is refused', () => {
    const dir = path.join(home, 'ro');
    fs.mkdirSync(dir);
    // A path under a non-directory: chmod fails with ENOTDIR, mkdir is not reached for the file helper.
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    expect(() => privateFile(path.join(dir, 'file', 'child'))).not.toThrow();
    expect(() => privateDir(dir)).not.toThrow();
  });

  it('a telemetry write under an unwritable root does not throw or block', () => {
    const locked = path.join(home, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o500);
    try {
      fs.writeFileSync(path.join(home, 'probe'), '');
      // HOME under a directory we cannot create inside; the caller must still finish normally.
      runScript(
        `
        import { logTelemetry, logJevTelemetry } from '${SRC}/core/telemetry.ts';
        await logTelemetry({ tool: 'jev_probe' });
        await logJevTelemetry({ harness: 'claude', toolOrHook: 'probe' });
      `,
        { HOME: locked }
      );
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});

describe('taskFingerprint', () => {
  it('returns the length and the first 12 hex of the sha256', () => {
    const fp = taskFingerprint(MARKER);

    expect(fp.taskLen).toBe(MARKER.length);
    expect(fp.taskHash).toBe(createHash('sha256').update(MARKER).digest('hex').slice(0, 12));
    expect(fp.taskHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable for equal text and differs for different text', () => {
    expect(taskFingerprint(MARKER)).toEqual(taskFingerprint(MARKER));
    expect(taskFingerprint(MARKER).taskHash).not.toBe(taskFingerprint(MARKER + '!').taskHash);
  });

  it('contains none of the task text', () => {
    expect(JSON.stringify(taskFingerprint(MARKER))).not.toContain('ZEBRA');
  });
});

describe('jev_dispatch telemetry line', () => {
  function dispatchOnce(): void {
    const proc = Bun.spawnSync(['bun', RUNNER], {
      stdin: new TextEncoder().encode(JSON.stringify({ tool: 'single', args: { task: MARKER } })),
      env: env({ JEV_HARNESS: 'claude-code', JEV_OPENROUTER_API_KEY: 'test-key', JEV_CLAUDE_STATE_DIR: path.join(home, 'state') })
    });
    if (proc.exitCode !== 0) throw new Error(`runner failed: ${proc.stderr.toString()}`);
  }

  it('stores taskLen and taskHash, and no task text, in a 0600 file', () => {
    dispatchOnce();

    const raw = fs.readFileSync(telemetryFile(), 'utf8');
    const line = JSON.parse(raw.trim().split('\n').filter((l) => l.includes('jev_dispatch')).pop() as string);
    expect(raw).not.toContain('ZEBRA-PROMPT-MARKER');
    expect(raw).not.toContain('payroll');
    expect(line.task).toBeUndefined();
    expect(line.taskLen).toBe(MARKER.length);
    expect(line.taskHash).toBe(createHash('sha256').update(MARKER).digest('hex').slice(0, 12));
    expect(line.tool).toBe('jev_dispatch');
    expect(line.harness).toBe('claude-code');
    expect(line.recommendedTier).toBeDefined();
    expect([mode(telemetryDir()), mode(telemetryFile())]).toEqual([0o700, 0o600]);
  });

  it('writes the same hash for the same task on a second run', () => {
    dispatchOnce();
    dispatchOnce();

    const hashes = fs
      .readFileSync(telemetryFile(), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.tool === 'jev_dispatch')
      .map((e) => e.taskHash);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
  });
});
