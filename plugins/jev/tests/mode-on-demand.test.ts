/**
 * Mode `on-demand` in every harness: tools, telemetry rows and a low-quota notice, and nothing else (no decisions, no
 * routing advice). The semantics live in src/core/mode-policy.ts; both adapters consult it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lowQuotaNotice, modeBehaviour, quotaPoolLabel } from '../src/core/mode-policy.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';
import { onPreToolUse, onUserPromptSubmit, telemetryEvent, type HookDeps } from '../claude/hook.ts';
import { runPreflight } from '../antigravity/preflight.ts';

describe('modeBehaviour', () => {
  it('describes the three modes', () => {
    expect(modeBehaviour('off')).toEqual({ tools: false, decisions: false, routingAdvice: false, telemetry: false, quotaNotice: 'none' });
    expect(modeBehaviour('on-demand')).toEqual({ tools: true, decisions: false, routingAdvice: false, telemetry: true, quotaNotice: 'low-only' });
    expect(modeBehaviour('on')).toEqual({ tools: true, decisions: true, routingAdvice: true, telemetry: true, quotaNotice: 'always' });
  });

  it('treats an unknown mode as off', () => {
    expect(modeBehaviour(undefined).decisions).toBe(false);
    expect(modeBehaviour('bogus').telemetry).toBe(false);
  });
});

describe('lowQuotaNotice', () => {
  it('is null for a healthy pool', () => {
    expect(lowQuotaNotice({ label: 'Gemini', strategy: 'normal', minRemaining: 0.8 })).toBeNull();
    expect(lowQuotaNotice({ label: 'Gemini', strategy: 'unknown', minRemaining: null })).toBeNull();
  });

  it('is one informational line for a conserve, free_only or exhausted pool', () => {
    expect(lowQuotaNotice({ label: 'Gemini', strategy: 'conserve', minRemaining: 0.15 })).toBe(
      '[JEV] quota notice: Gemini is conserve (15% remaining). Informational only.'
    );
    expect(lowQuotaNotice({ label: 'Gemini', strategy: 'free_only' })).toBe('[JEV] quota notice: Gemini is free_only. Informational only.');
    expect(lowQuotaNotice({ label: 'Gemini', strategy: 'normal', minRemaining: 0 })).toBe(
      '[JEV] quota notice: Gemini is exhausted (0% remaining). Informational only.'
    );
  });

  it('labels a 3p pool with its model', () => {
    expect(quotaPoolLabel({ pool: '3p' }, 'claude-x')).toBe('3p (claude-x)');
    expect(quotaPoolLabel({ pool: 'gemini' }, 'claude-x')).toBe('Gemini');
  });
});

describe('Claude Code hooks in on-demand', () => {
  const boom = (name: string) => () => {
    throw new Error(`${name} must not be called in this mode`);
  };

  function make(mode: string, overrides: Partial<HookDeps> = {}) {
    const logs: Record<string, unknown>[] = [];
    const deps: HookDeps = {
      readMode: async () => mode as any,
      readSessionModel: () => 'claude-sonnet-5-5',
      readQuotaStrategy: async () => 'normal',
      dispatch: boom('dispatch') as any,
      log: (e) => logs.push(e),
      saveTurn: boom('saveTurn') as any,
      claimClamp: boom('claimClamp') as any,
      approvals: { claim: boom('claim'), attempt: boom('attempt'), deny: boom('deny'), record: boom('record') } as any,
      downgrades: boom('downgrades') as any,
      ...overrides
    };
    return { deps, logs };
  }

  const agentCall = (model?: string) => ({
    session_id: 's1',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose', description: 'work', prompt: 'do it', ...(model ? { model } : {}) }
  });

  describe('PreToolUse', () => {
    it('writes the agent_call row of a call let through unchanged and returns no output', async () => {
      const { deps, logs } = make('on-demand');
      expect(await onPreToolUse(agentCall('opus'), deps)).toBeNull();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        hook: 'PreToolUse',
        event: 'agent_call',
        session_id: 's1',
        tool_name: 'Agent',
        decision: 'pass',
        requested_model: 'opus',
        sessionModel: 'claude-sonnet-5-5',
        session_model_source: 'stored'
      });
      expect(logs[0]).not.toHaveProperty('tier');
      expect(logs[0]).not.toHaveProperty('recommended_model');
      expect(logs[0]).not.toHaveProperty('elevation');
      expect(logs[0]).not.toHaveProperty('reason', expect.anything());
      const t = telemetryEvent(logs[0]);
      expect(t).toMatchObject({
        harness: 'claude',
        toolOrHook: 'PreToolUse',
        decision: 'pass',
        requestedModel: 'opus',
        modelUsed: 'opus',
        modelUsedSource: 'requested',
        sessionModel: 'claude-sonnet-5-5',
        sessionModelSource: 'stored'
      });
      expect(t.modelRecommended).toBeUndefined();
    });

    it('records an inherited call as running on the session model', async () => {
      const { deps, logs } = make('on-demand');
      expect(await onPreToolUse(agentCall(), deps)).toBeNull();
      expect(telemetryEvent(logs[0])).toMatchObject({ decision: 'pass', modelUsed: 'claude-sonnet-5-5', modelUsedSource: 'inherited' });
    });

    it('does not decide a Workflow or an elevating call, and ignores other tools', async () => {
      const { deps, logs } = make('on-demand');
      expect(await onPreToolUse({ session_id: 's1', tool_name: 'Workflow', tool_input: { script: "await agent('p', { model: 'opus' })" } }, deps)).toBeNull();
      expect(await onPreToolUse(agentCall('opus'), deps)).toBeNull();
      expect(await onPreToolUse({ session_id: 's1', tool_name: 'Bash', tool_input: {} }, deps)).toBeNull();
      expect(logs.map((l) => l.tool_name)).toEqual(['Workflow', 'Agent']);
      expect(logs.every((l) => l.decision === 'pass')).toBe(true);
      expect(telemetryEvent(logs[0]).modelUsed).toBeUndefined(); // a Workflow carries no model of its own
    });

    it('mode off writes nothing', async () => {
      const { deps, logs } = make('off');
      expect(await onPreToolUse(agentCall('opus'), deps)).toBeNull();
      expect(logs).toEqual([]);
    });
  });

  describe('UserPromptSubmit', () => {
    const prompt = { session_id: 's1', prompt: 'please refactor the billing module' };

    it('makes no dispatch call, writes a row without recommendation fields and injects nothing for a healthy pool', async () => {
      const { deps, logs } = make('on-demand');
      expect(await onUserPromptSubmit(prompt, deps)).toBeNull();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        hook: 'UserPromptSubmit',
        session_id: 's1',
        quota: 'normal',
        sessionModel: 'claude-sonnet-5-5',
        session_model_source: 'stored'
      });
      expect(logs[0].turn).toEqual(expect.any(String));
      for (const k of ['tier', 'subagent', 'effort', 'recommended_model', 'rule', 'user_intent']) expect(logs[0]).not.toHaveProperty(k);
      const t = telemetryEvent(logs[0]);
      expect(t).toMatchObject({ harness: 'claude', toolOrHook: 'UserPromptSubmit', quotaStrategy: 'normal' });
      expect(t.modelRecommended).toBeUndefined();
    });

    it('injects the one-line notice for a low pool and nothing else', async () => {
      const { deps, logs } = make('on-demand', {
        readQuotaPool: async () => ({ label: 'Gemini', strategy: 'conserve', minRemaining: 0.15 })
      });
      const out = await onUserPromptSubmit(prompt, deps);
      expect(out).toEqual({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: '[JEV] quota notice: Gemini is conserve (15% remaining). Informational only.'
        }
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].quota).toBe('conserve');
    });

    it('falls back to the quota strategy alone, and notices an exhausted pool', async () => {
      const a = make('on-demand', { readQuotaStrategy: async () => 'free_only' });
      expect((await onUserPromptSubmit(prompt, a.deps))?.hookSpecificOutput.additionalContext).toBe(
        '[JEV] quota notice: Gemini is free_only. Informational only.'
      );
      const b = make('on-demand', { readQuotaPool: async () => ({ label: 'Gemini', strategy: 'normal', minRemaining: 0 }) });
      expect((await onUserPromptSubmit(prompt, b.deps))?.hookSpecificOutput.additionalContext).toContain('exhausted (0% remaining)');
    });

    it('writes nothing for a short prompt or a host-injected turn', async () => {
      const { deps, logs } = make('on-demand', { readQuotaStrategy: async () => 'free_only' });
      expect(await onUserPromptSubmit({ session_id: 's1', prompt: 'ok' }, deps)).toBeNull();
      expect(logs).toEqual([]);
    });

    it('mode off writes and injects nothing, even for a low pool', async () => {
      const { deps, logs } = make('off', { readQuotaStrategy: async () => 'free_only' });
      expect(await onUserPromptSubmit(prompt, deps)).toBeNull();
      expect(logs).toEqual([]);
    });
  });
});

describe('Antigravity pre-flight in on-demand', () => {
  let tmpHome = '';
  let agyDir = '';
  const saved: Record<string, string | undefined> = {};
  const ENV = ['HOME', 'JEV_CONFIG_FILE', 'JEV_TELEMETRY_FILE', 'JEV_QUOTA_STATE_FILE'];

  beforeEach(() => {
    clearConfigCacheForTesting();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ondemand-pre-'));
    agyDir = path.join(tmpHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(agyDir, { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.config', 'jev'), { recursive: true });
    for (const k of ENV) saved[k] = process.env[k];
    process.env.HOME = tmpHome;
    process.env.JEV_CONFIG_FILE = path.join(tmpHome, '.config', 'jev', 'config.json');
    process.env.JEV_TELEMETRY_FILE = path.join(tmpHome, 'telemetry.jsonl');
    process.env.JEV_QUOTA_STATE_FILE = path.join(agyDir, 'quota-state.json');
    fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ defaults: { mode: 'on-demand' } }));
  });

  afterEach(() => {
    clearConfigCacheForTesting();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const writeQuota = (remaining: number) =>
    fs.writeFileSync(
      path.join(agyDir, 'quota-state.json'),
      JSON.stringify({
        schema: 2,
        updated_at: Math.floor(Date.now() / 1000),
        active_model: 'gemini-3.8-flash-low',
        buckets: { 'gemini-5h': { remaining_fraction: remaining }, 'gemini-weekly': { remaining_fraction: remaining } }
      })
    );

  const input = { conversationId: 'c-od', modelName: 'gemini-3.8-flash-low', lastUserInput: 'please refactor the billing module', invocationNum: 1 };

  async function capture(deps: { callJev?: any } = {}): Promise<{ out: any; dispatches: number }> {
    let dispatches = 0;
    let stdout = '';
    const origLog = console.log;
    console.log = (msg: string) => { stdout += msg; };
    try {
      await runPreflight(JSON.stringify(input), {
        autoHeal: () => {},
        callJev: (async () => { dispatches++; return null; }) as any,
        ...deps
      });
    } finally {
      console.log = origLog;
    }
    return { out: JSON.parse(stdout), dispatches };
  }

  const rows = (): Record<string, any>[] => {
    const file = process.env.JEV_TELEMETRY_FILE!;
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  it('healthy pool: no router call, no directive, no turn state; writes the prompt row without recommendation fields', async () => {
    writeQuota(0.9);
    const { out, dispatches } = await capture();
    expect(dispatches).toBe(0);
    expect(JSON.stringify(out)).not.toContain('JEV MODE');
    expect(JSON.stringify(out)).not.toContain('PRE-FLIGHT');
    expect(JSON.stringify(out)).not.toContain('quota notice');
    const prompt = rows().filter((r) => r.toolOrHook === 'PreInvocation');
    expect(prompt).toHaveLength(1);
    expect(prompt[0]).toMatchObject({ harness: 'antigravity', sessionId: 'c-od', sessionModel: 'gemini-3.8-flash-low', sessionModelSource: 'hook' });
    for (const k of ['recommendedSubagent', 'recommendedTier', 'modelRecommended', 'effort']) expect(prompt[0]).not.toHaveProperty(k);
    const sessions = path.join(tmpHome, '.config', 'jev', 'antigravity-sessions');
    const files = fs.existsSync(sessions) ? fs.readdirSync(sessions) : [];
    expect(files.filter((f) => f.includes('turn'))).toEqual([]);
  });

  it('low pool: only the shared one-line notice, no QUOTA directive and no router call', async () => {
    writeQuota(0.05);
    const { out, dispatches } = await capture();
    expect(dispatches).toBe(0);
    const msg: string = out.injectSteps[0].ephemeralMessage;
    expect(msg).toMatch(/^\[JEV\] quota notice: Gemini is (conserve|free_only) \(5% remaining\)\. Informational only\./);
    expect(msg).not.toContain('QUOTA EMERGENCY');
    expect(msg).not.toContain('QUOTA CONSERVE');
    expect(msg).not.toContain('JEV MODE');
    expect(rows().filter((r) => r.toolOrHook === 'PreInvocation')).toHaveLength(1);
  });

  it('mode on keeps the full directive (not a notice)', async () => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ defaults: { mode: 'on' } }));
    clearConfigCacheForTesting();
    writeQuota(0.05);
    const { out } = await capture();
    const msg: string = out.injectSteps[0].ephemeralMessage;
    expect(msg).toMatch(/QUOTA (EMERGENCY|CONSERVE)/);
    expect(msg).toContain('JEV MODE: ON');
    expect(msg).not.toContain('quota notice');
  });
});

describe('Antigravity pre-flight: exhausted Argon frontier pool per mode', () => {
  let tmpHome = '';
  let agyDir = '';
  const saved: Record<string, string | undefined> = {};
  const ENV = ['HOME', 'JEV_CONFIG_FILE', 'JEV_TELEMETRY_FILE', 'JEV_QUOTA_STATE_FILE'];

  beforeEach(() => {
    clearConfigCacheForTesting();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-argon-pre-'));
    agyDir = path.join(tmpHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(agyDir, { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.config', 'jev'), { recursive: true });
    for (const k of ENV) saved[k] = process.env[k];
    process.env.HOME = tmpHome;
    process.env.JEV_CONFIG_FILE = path.join(tmpHome, '.config', 'jev', 'config.json');
    process.env.JEV_TELEMETRY_FILE = path.join(tmpHome, 'telemetry.jsonl');
    process.env.JEV_QUOTA_STATE_FILE = path.join(agyDir, 'quota-state.json');
  });

  afterEach(() => {
    clearConfigCacheForTesting();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const setMode = (mode: string) => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ defaults: { mode } }));
    clearConfigCacheForTesting();
  };

  const writeQuota = (execution: number, argon: number) =>
    fs.writeFileSync(
      path.join(agyDir, 'quota-state.json'),
      JSON.stringify({
        schema: 2,
        updated_at: Math.floor(Date.now() / 1000),
        active_model: 'Orchestrator (Argon)',
        plan_tier: 'pro',
        buckets: {
          'gemini-5h': { remaining_fraction: execution },
          'gemini-weekly': { remaining_fraction: execution },
          'gemini-argon-wtu-weekly': { remaining_fraction: argon, reset_at: Math.floor(Date.now() / 1000) + 3600 }
        }
      })
    );

  async function message(): Promise<string> {
    let stdout = '';
    const origLog = console.log;
    console.log = (msg: string) => { stdout += msg; };
    try {
      await runPreflight(
        JSON.stringify({ conversationId: 'c-argon', modelName: 'Orchestrator (Argon)', lastUserInput: 'please refactor the billing module', invocationNum: 1 }),
        { autoHeal: () => {}, callJev: (async () => null) as any }
      );
    } finally {
      console.log = origLog;
    }
    const out = JSON.parse(stdout);
    return out.injectSteps?.[0]?.ephemeralMessage ?? '';
  }

  it('on-demand, Argon at 0, healthy execution pool: one shared notice line for Argon, no advice', async () => {
    setMode('on-demand');
    writeQuota(0.8, 0);
    const msg = await message();
    expect(msg).toBe('[JEV] quota notice: Argon is free_only (0% remaining). Informational only.');
    expect(msg).not.toContain('ARGON EXHAUSTED WARNING');
    expect(msg).not.toMatch(/switch model|\/model/i);
  });

  it('on-demand, Argon free_only with some remaining: the shared wording for free_only', async () => {
    setMode('on-demand');
    writeQuota(0.8, 0.03);
    expect(await message()).toBe('[JEV] quota notice: Argon is free_only (3% remaining). Informational only.');
  });

  it('on-demand, both pools low: one shared notice line per pool, nothing else', async () => {
    setMode('on-demand');
    writeQuota(0.05, 0);
    const lines = (await message()).split('\n\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[JEV\] quota notice: Gemini is (conserve|free_only) \(5% remaining\)\. Informational only\.$/);
    expect(lines[1]).toBe('[JEV] quota notice: Argon is free_only (0% remaining). Informational only.');
  });

  it('on-demand, healthy pools: nothing injected', async () => {
    setMode('on-demand');
    writeQuota(0.8, 0.8);
    expect(await message()).toBe('');
  });

  it('mode on keeps the full Argon warning with the model-switch advice', async () => {
    setMode('on');
    writeQuota(0.8, 0);
    const msg = await message();
    expect(msg).toContain('ARGON EXHAUSTED WARNING');
    expect(msg).toContain('Switch model to Gemini 4 Hydrogen via /model');
    expect(msg).not.toContain('quota notice');
  });
});
