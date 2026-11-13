import { describe, it, expect } from 'bun:test';
import * as os from 'node:os';
import { defaultSpawner } from '../src/refresh/spawn.js';

describe('defaultSpawner', () => {
  it('returns timedOut within about a second even when a grandchild holds the pipes open', async () => {
    const start = performance.now();
    const r = await defaultSpawner('sh', ['-c', 'sleep 5 & sleep 5'], { cwd: os.tmpdir(), timeoutMs: 300 });
    const took = performance.now() - start;
    expect(r.timedOut).toBe(true);
    expect(took).toBeLessThan(1500);
  });

  it('captures the output and exit code of a normal command', async () => {
    const r = await defaultSpawner('sh', ['-c', 'echo hi; exit 3'], { cwd: os.tmpdir(), timeoutMs: 5000 });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(3);
    expect(r.stdout.trim()).toBe('hi');
  });

  it('reports a command that cannot start', async () => {
    const r = await defaultSpawner('definitely-not-a-command-xyz', [], { cwd: os.tmpdir(), timeoutMs: 5000 });
    expect(r.error).toBeTruthy();
  });
});
