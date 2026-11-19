import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const WRITER = path.join(import.meta.dir, 'lock-writer.ts');
const SESSION = '00000000-0000-4000-8000-00000000a501';

let home = '';
let sessionsDir = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-lock-conc-'));
  const cfgDir = path.join(home, '.config', 'jev');
  fs.mkdirSync(cfgDir, { recursive: true });
  // maxFiles 3: of N concurrent writers exactly 3 may be recorded, the rest denied.
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ defaults: { mode: 'on' }, harnesses: { antigravity: { writeGuard: { maxFiles: 3, maxFilesOrchestrator: 6 } } } })
  );
  sessionsDir = path.join(cfgDir, 'antigravity-sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

async function runWriters(mode: 'pending' | 'guard', count: number): Promise<Array<Record<string, unknown>>> {
  const startAt = Date.now() + 1500;
  const procs = Array.from({ length: count }, (_, n) =>
    Bun.spawn(['bun', WRITER, mode, sessionsDir, SESSION, String(n), String(startAt)], {
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json') },
      stdout: 'pipe',
      stderr: 'pipe'
    })
  );
  const out: Array<Record<string, unknown>> = [];
  for (const p of procs) {
    const text = await new Response(p.stdout).text();
    await p.exited;
    const line = text.trim().split('\n').filter(Boolean).pop();
    if (line) out.push(JSON.parse(line));
  }
  return out;
}

describe('concurrent hook writers (A5)', () => {
  it('pending-served: ten simultaneous recordPendingServed calls lose no entry', async () => {
    const results = await runWriters('pending', 10);
    expect(results).toHaveLength(10);
    const file = path.join(sessionsDir, `${SESSION}.pending-served.json`);
    const items = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ stepIdx: number }>;
    expect(items.map((i) => i.stepIdx).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(fs.existsSync(`${file.replace(/\.json$/, '.lock')}`)).toBe(false);
  }, 30_000);

  it('write guard: ten simultaneous edits of distinct files record exactly the limit and deny the rest', async () => {
    const results = await runWriters('guard', 10);
    expect(results).toHaveLength(10);
    const allowed = results.filter((r) => r.decision === 'allow');
    const denied = results.filter((r) => r.decision === 'deny');
    const streak = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${SESSION}.write-guard.json`), 'utf8')) as { files: string[] };
    expect(streak.files).toHaveLength(3);
    expect(allowed).toHaveLength(3);
    expect(denied).toHaveLength(7);
  }, 30_000);
});
