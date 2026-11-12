/**
 * jev_batch_dispatch reads the free-tier worker cap from config.tiers.free.concurrencyCap (default 10).
 * The handler runs in a child process with a stubbed Decisions API (tests/fixtures/run-dispatch.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const RUNNER = path.join(import.meta.dir, 'fixtures', 'run-dispatch.ts');
const MARKERS = ['JEV_HARNESS', 'ANTIGRAVITY_CLI', 'GEMINI_CLI', 'CORTEX_SESSION', 'CLAUDE_CODE', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'OPENCODE_SESSION', 'OPENCODE_HOME'];

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cap-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function freeWorkers(config: object, freeTasks: number): number {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ routing: { strategy: 'keyword' }, ...config }));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !MARKERS.includes(k) && !/KEY|TOKEN|SECRET/.test(k)) env[k] = v;
  const tasks = Array.from({ length: freeTasks }, (_, i) => ({ id: `t${i}`, task: `Scaffold package number ${i}` }));
  const proc = Bun.spawnSync(['bun', RUNNER], {
    stdin: new TextEncoder().encode(JSON.stringify({ tool: 'batch', args: { tasks }, offline: true })),
    env: { ...env, HOME: tmp, JEV_HARNESS: 'cli', JEV_CONFIG_FILE: path.join(tmp, 'config.json'), JEV_CACHE_FILE: path.join(tmp, 'cache.sqlite'), JEV_OPENROUTER_API_KEY: 'test-key' }
  });
  if (proc.exitCode !== 0) throw new Error(`runner failed: ${proc.stderr.toString()}`);
  return JSON.parse(proc.stdout.toString()).maxConcurrentFreeWorkers;
}

describe('jev_batch_dispatch free-tier concurrency cap', () => {
  it('keeps 10 as the default', () => {
    expect(freeWorkers({}, 14)).toBe(10);
  });

  it('reads tiers.free.concurrencyCap from config', () => {
    expect(freeWorkers({ tiers: { free: { description: 'free', concurrencyCap: 3 } } }, 14)).toBe(3);
  });

  it('never exceeds the number of free tasks', () => {
    expect(freeWorkers({ tiers: { free: { description: 'free', concurrencyCap: 8 } } }, 2)).toBe(2);
  });
});
