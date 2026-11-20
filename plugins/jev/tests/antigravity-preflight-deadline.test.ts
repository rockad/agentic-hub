import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPreflight, PREFLIGHT_DEADLINE_MS } from '../antigravity/preflight.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';

// Deterministic: every slow dependency is a stub (a timer, never the network), so the timings below come from the
// pre-flight's own budgets and deadline.
describe('antigravity preflight finishes within the hook timeout', () => {
  let tmpHome = '';
  let jevConfigDir = '';
  let agyDir = '';
  const saved: Record<string, string | undefined> = {};
  const ENV = ['HOME', 'JEV_CONFIG_FILE', 'JEV_TELEMETRY_FILE', 'JEV_QUOTA_STATE_FILE'] as const;

  beforeEach(() => {
    clearConfigCacheForTesting();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-preflight-deadline-'));
    jevConfigDir = path.join(tmpHome, '.config', 'jev');
    agyDir = path.join(tmpHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(jevConfigDir, { recursive: true });
    fs.mkdirSync(agyDir, { recursive: true });
    for (const k of ENV) saved[k] = process.env[k];
    process.env.HOME = tmpHome;
    process.env.JEV_CONFIG_FILE = path.join(jevConfigDir, 'config.json');
    process.env.JEV_TELEMETRY_FILE = path.join(agyDir, 'jev_telemetry.jsonl');
    process.env.JEV_QUOTA_STATE_FILE = path.join(agyDir, 'quota-state.json');
    fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ defaults: { mode: 'on' } }));
    fs.writeFileSync(
      process.env.JEV_QUOTA_STATE_FILE,
      JSON.stringify({
        schema: 2,
        updated_at: Math.floor(Date.now() / 1000),
        active_model: 'gemini-3.8-flash-low',
        buckets: { 'gemini-5h': { remaining_fraction: 0.15 }, 'gemini-weekly': { remaining_fraction: 0.15 } }
      })
    );
  });

  afterEach(() => {
    clearConfigCacheForTesting();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const INPUT = { conversationId: 'c-deadline', modelName: 'gemini-3.8-flash-low', lastUserInput: 'refactor the parser module', invocationNum: 1 };
  const never = () => new Promise<never>(() => {});

  async function run(deps: Parameters<typeof runPreflight>[1]): Promise<{ out: string; ms: number }> {
    let out = '';
    const origLog = console.log;
    console.log = (msg: string) => { out += msg; };
    const t0 = Date.now();
    try {
      await runPreflight(JSON.stringify(INPUT), deps);
    } finally {
      console.log = origLog;
    }
    return { out, ms: Date.now() - t0 };
  }

  function decisionRows(): any[] {
    const f = path.join(jevConfigDir, 'antigravity_decisions.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  }

  it('the overall deadline is under the hook timeout with room for startup', () => {
    const hook = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'hooks.json'), 'utf8'));
    const timeoutMs = hook['jev-subagent-guard'].PreInvocation[0].timeout * 1000;
    expect(PREFLIGHT_DEADLINE_MS).toBeLessThanOrEqual(4000);
    expect(PREFLIGHT_DEADLINE_MS).toBeLessThan(timeoutMs);
  });

  it('a router call and a Recall read that never answer cost one budget, not the sum, and the output is valid', async () => {
    const { out, ms } = await run({
      autoHeal: () => {},
      callJev: never as any,
      fetchMemory: never as any
    });
    expect(ms).toBeLessThan(4000);
    const parsed = JSON.parse(out);
    const msg: string = parsed.injectSteps[0].ephemeralMessage;
    // What does not depend on the slow calls is still there: the quota text and the base directive.
    expect(msg).toContain('QUOTA CONSERVE');
    expect(msg).toContain('JEV MODE: ON');
    // The late router call is skipped: no recommendation line, and no memory block.
    expect(msg).not.toContain('[JEV PRE-FLIGHT]');
    expect(msg).not.toContain('CROSS-HARNESS MEMORY');
    const skipped = decisionRows().filter((r) => r.event === 'preflight_skipped').map((r) => `${r.step}:${r.reason}`);
    expect(skipped).toContain('router:timeout');
    expect(skipped).toContain('memory:timeout');
  });

  it('the router call and the Recall read run in parallel', async () => {
    const slow = <T>(v: T) => () => new Promise<T>((r) => setTimeout(() => r(v), 800));
    const { out, ms } = await run({
      autoHeal: () => {},
      callJev: slow({
        answers: { recommendedSubagent: { choice: 'self' }, recommendedTier: { choice: 'flash' } }
      }) as any,
      fetchMemory: slow({ lastHarness: 'opencode', activeGoal: 'ship it', updatedAt: 'now' }) as any
    });
    // Sequential would be at least 1600 ms.
    expect(ms).toBeLessThan(1500);
    const msg: string = JSON.parse(out).injectSteps[0].ephemeralMessage;
    expect(msg).toContain('[JEV PRE-FLIGHT]');
    expect(msg).toContain('Active Goal: ship it');
  });

  it('when synchronous waits already used the deadline, the late steps are skipped and the output is still valid', async () => {
    let calledRouter = 0;
    let calledMemory = 0;
    const { out, ms } = await run({
      deadlineMs: 300,
      autoHeal: () => { Bun.sleepSync(450); },
      callJev: (async () => { calledRouter++; return null; }) as any,
      fetchMemory: (async () => { calledMemory++; return null; }) as any
    });
    expect(ms).toBeLessThan(1500);
    expect(calledRouter).toBe(0);
    expect(calledMemory).toBe(0);
    const msg: string = JSON.parse(out).injectSteps[0].ephemeralMessage;
    expect(msg).toContain('QUOTA CONSERVE');
    expect(msg).toContain('JEV MODE: ON');
    const skipped = decisionRows().filter((r) => r.event === 'preflight_skipped').map((r) => r.step);
    expect(skipped).toContain('router');
    expect(skipped).toContain('memory');
  });

  it('a step that outlives the deadline is cut off: the hook prints what it has and returns', async () => {
    // A 700 ms deadline clips the router and Recall budgets to what is left (400 ms each), so both give up well before
    // the 1500 ms and 1000 ms defaults, and the output is printed once, inside the deadline.
    const { out, ms } = await run({ deadlineMs: 700, autoHeal: () => {}, callJev: never as any, fetchMemory: never as any });
    expect(ms).toBeLessThan(1200);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out).injectSteps[0].ephemeralMessage).toContain('JEV MODE: ON');
  });

  it('mode off is unchanged: prints {} at once and writes nothing', async () => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ defaults: { mode: 'off' } }));
    const { out, ms } = await run({ autoHeal: () => {}, callJev: never as any, fetchMemory: never as any });
    expect(JSON.parse(out)).toEqual({});
    expect(ms).toBeLessThan(500);
    expect(fs.existsSync(path.join(jevConfigDir, 'antigravity_decisions.jsonl'))).toBe(false);
  });

  it('on-demand makes no router call and no Recall read, and is not slowed by either', async () => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ defaults: { mode: 'on-demand' } }));
    let calls = 0;
    const { out, ms } = await run({
      autoHeal: () => {},
      callJev: (async () => { calls++; return null; }) as any,
      fetchMemory: (async () => { calls++; return null; }) as any
    });
    expect(calls).toBe(0);
    expect(ms).toBeLessThan(500);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
