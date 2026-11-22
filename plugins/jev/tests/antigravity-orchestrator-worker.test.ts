/**
 * The Antigravity Orchestrator reports two model ids in one conversation: the planner (`gemini-pro-orchestrator-g1-pro`) on
 * planning turns and the execution worker (`gemini-flash-worker-agy`) on execution turns. Both are an Orchestrator
 * session; the stored session model stays the planner once known (Jev 2.3.18). Hermetic: a temp HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isOrchestratorModel,
  isOrchestratorPlanner,
  isOrchestratorWorker,
  subagentCeilingRank,
  writeAntigravitySessionModel,
  readQuotaView,
  poolForTier
} from '../src/core/governance.ts';

const PLANNER = 'gemini-pro-orchestrator-g1-pro';
const WORKER = 'gemini-flash-worker-agy';
const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const CONV = 'conv-orch-worker';

describe('Orchestrator family detection', () => {
  it('planner: any id naming the Orchestrator', () => {
    for (const m of [PLANNER, 'Orchestrator (Argon)', 'Orchestrator (Carbon)', 'orchestrator']) {
      expect(isOrchestratorPlanner(m)).toBe(true);
      expect(isOrchestratorWorker(m)).toBe(false);
      expect(isOrchestratorModel(m)).toBe(true);
    }
  });

  it('worker: the flash-worker / worker-agy tokens', () => {
    for (const m of [WORKER, 'gemini-pro-worker-agy', 'GEMINI-FLASH-WORKER-AGY', 'flash-worker', 'worker-agy', 'gemini flash-worker agy']) {
      expect(isOrchestratorWorker(m)).toBe(true);
      expect(isOrchestratorPlanner(m)).toBe(false);
      expect(isOrchestratorModel(m)).toBe(true);
    }
  });

  it('neither: ordinary Gemini, Claude and look-alike ids', () => {
    for (const m of ['gemini-3.8-flash-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-tiered-xhigh', 'claude-opus-5-5', 'worker', 'worker-agy2', 'agy-worker', 'flash-workers', 'my-flash-worker2', '', null, undefined]) {
      expect(isOrchestratorWorker(m)).toBe(false);
      expect(isOrchestratorModel(m)).toBe(false);
    }
  });

  it('the worker has the Orchestrator subagent ceiling (flash)', () => {
    expect(subagentCeilingRank(WORKER)).toBe(2);
    expect(subagentCeilingRank(PLANNER)).toBe(2);
  });
});

describe('sticky Orchestrator session model', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-orch-sticky-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rec = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

  it('a worker id does not replace a stored planner; the turn model is recorded beside it', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(writeAntigravitySessionModel(CONV, PLANNER, now, dir)).toBe(PLANNER);
    expect(writeAntigravitySessionModel(CONV, WORKER, now + 5, dir)).toBe(PLANNER);
    for (const f of [`${CONV}.model.json`, 'latest.json']) {
      expect(rec(f).model).toBe(PLANNER);
      expect(rec(f).turn_model).toBe(WORKER);
      expect(rec(f).updated_at).toBe(now + 5);
    }
    // the planner coming back clears the turn model
    expect(writeAntigravitySessionModel(CONV, PLANNER, now + 10, dir)).toBe(PLANNER);
    expect(rec(`${CONV}.model.json`).turn_model).toBeUndefined();
  });

  it('a worker id with nothing stored is stored as it is (still an Orchestrator session)', () => {
    expect(writeAntigravitySessionModel(CONV, WORKER, undefined, dir)).toBe(WORKER);
    expect(rec(`${CONV}.model.json`).model).toBe(WORKER);
  });

  it('a stale planner record does not stick', () => {
    const now = Math.floor(Date.now() / 1000);
    writeAntigravitySessionModel(CONV, PLANNER, now - 7201, dir);
    expect(writeAntigravitySessionModel(CONV, WORKER, now, dir)).toBe(WORKER);
  });

  it('a real model switch (any non-worker id) replaces the planner', () => {
    const now = Math.floor(Date.now() / 1000);
    writeAntigravitySessionModel(CONV, 'Orchestrator (Argon)', now, dir);
    expect(writeAntigravitySessionModel(CONV, 'gemini-4-hydrogen-medium', now + 1, dir)).toBe('gemini-4-hydrogen-medium');
    expect(rec(`${CONV}.model.json`).model).toBe('gemini-4-hydrogen-medium');
    // and a later worker id does not resurrect the Orchestrator
    expect(writeAntigravitySessionModel(CONV, WORKER, now + 2, dir)).toBe(WORKER);
  });

  it('another conversation is not affected by this one', () => {
    const now = Math.floor(Date.now() / 1000);
    writeAntigravitySessionModel('conv-other', PLANNER, now, dir);
    expect(writeAntigravitySessionModel(CONV, WORKER, now, dir)).toBe(WORKER);
  });

  it('pools: an Orchestrator quota view keeps execution = Gemini and frontier = Argon for a worker session', async () => {
    const now = Math.floor(Date.now() / 1000);
    const quotaFile = path.join(dir, 'quota-state.json');
    fs.writeFileSync(
      quotaFile,
      JSON.stringify({
        schema: 2,
        updated_at: now,
        active_model: 'Gemini 3.8 Flash (Medium)',
        plan_tier: 'pro',
        buckets: {
          'gemini-5h': { remaining_fraction: 0.8 },
          'gemini-weekly': { remaining_fraction: 0.8 },
          'gemini-argon-wtu-weekly': { remaining_fraction: 0.01, reset_at: now + 3600 }
        }
      })
    );
    const orig = process.env.JEV_QUOTA_STATE_FILE;
    process.env.JEV_QUOTA_STATE_FILE = quotaFile;
    try {
      writeAntigravitySessionModel(CONV, 'Orchestrator (Argon)', now, dir);
      writeAntigravitySessionModel(CONV, WORKER, now + 1, dir);
      const view = await readQuotaView({ conversationId: CONV, overrideSessionsDir: dir });
      expect(view.active_model).toBe('Orchestrator (Argon)');
      expect(view.variant).toBe('argon');
      expect(view.pools?.execution.strategy).toBe('normal');
      expect(view.pools?.frontier.strategy).not.toBe('normal');
      expect(poolForTier(view, 'flash')).toBe(view.pools!.execution);
      expect(poolForTier(view, 'flash_lite')).toBe(view.pools!.execution);
      // Model pro is served on Gemini 4 Hydrogen (2.3.20): the Gemini pool. A call served on Argon draws the frontier pool.
      expect(poolForTier(view, 'pro')).toBe(view.pools!.execution);
      expect(poolForTier(view, 'gemini-4-argon-high')).toBe(view.pools!.frontier);
    } finally {
      if (orig === undefined) delete process.env.JEV_QUOTA_STATE_FILE;
      else process.env.JEV_QUOTA_STATE_FILE = orig;
    }
  });
});

describe('PreToolUse hook: the planner then the worker', () => {
  let home = '';
  const sessions = () => path.join(home, '.config', 'jev', 'antigravity-sessions');
  const setMode = (mode: string) =>
    fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode } }));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-orch-hook-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'),
      JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' })
    );
    setMode('on');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function run(modelName: string, model?: string, stepIdx = 3) {
    return Bun.spawnSync(['bun', HOOK, 'pre-tool-use'], {
      stdin: new TextEncoder().encode(
        JSON.stringify({
          conversationId: CONV,
          modelName,
          lastUserInput: 'tidy the synthetic notes',
          stepIdx,
          toolCall: { id: `call_${stepIdx}`, name: 'invoke_subagent', args: { TypeName: 'research', Prompt: 'read', ...(model ? { Model: model } : {}) } }
        })
      ),
      env: {
        ...process.env,
        HOME: home,
        JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json'),
        JEV_OPENROUTER_API_KEY: '',
        OPENROUTER_API_KEY: '',
        JEV_DOWNGRADE: 'off'
      }
    });
  }
  const out = (p: ReturnType<typeof run>) => {
    const t = p.stdout.toString().trim();
    return t ? JSON.parse(t) : {};
  };
  const stored = (name = `${CONV}.model.json`) => JSON.parse(fs.readFileSync(path.join(sessions(), name), 'utf8'));

  it('mode on: the stored model stays the planner after a worker PreToolUse, and the explicit-Model rule still denies', () => {
    // planning turn: the session starts with the planner id
    expect(out(run(PLANNER, 'flash'))).toEqual({}); // explicit flash passes
    expect(stored().model).toBe(PLANNER);

    // execution turn: the worker id arrives with Model omitted
    const denied = out(run(WORKER, undefined, 4));
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('Under Orchestrator, set Model explicitly');
    expect(stored().model).toBe(PLANNER);
    expect(stored().turn_model).toBe(WORKER);
    expect(stored('latest.json').model).toBe(PLANNER);

    // "inherit" is denied the same way, an explicit flash passes
    expect(out(run(WORKER, 'inherit', 5)).decision).toBe('deny');
    expect(out(run(WORKER, 'flash', 6))).toEqual({});
    expect(stored().model).toBe(PLANNER);
  });

  it('mode on: a worker id alone (no planner seen) is still an Orchestrator session', () => {
    const denied = out(run(WORKER));
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('Under Orchestrator');
    expect(stored().model).toBe(WORKER);
  });

  it('mode on: the Orchestrator ceiling applies on a worker turn (pro above the flash ceiling is denied)', () => {
    run(PLANNER, 'flash');
    const r = out(run(WORKER, 'pro', 4));
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('[jev-elevate:pro]');
  });

  it('on-demand still passes everything, and the stored model is still sticky', () => {
    setMode('on-demand');
    expect(out(run(PLANNER, 'flash'))).toEqual({});
    expect(out(run(WORKER, undefined, 4))).toEqual({});
    expect(out(run(WORKER, 'inherit', 5))).toEqual({});
    expect(out(run(WORKER, 'pro', 6))).toEqual({});
    expect(stored().model).toBe(PLANNER);
  });
});
