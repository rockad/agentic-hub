/**
 * The combined cost estimate (telemetry only): the helper in src/core/cost-estimate.ts, and its presence on the `agent_call`
 * rows of both harnesses: Claude Code (decisions log and telemetry row, mode on and on-demand, pass and deny) and Antigravity
 * (telemetry builder, and the decisions log and telemetry file of the hook process). It never changes a decision.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  COST_WEIGHTS_VERSION,
  EFFORT_WEIGHTS,
  MODEL_WEIGHTS,
  antigravityCostFields,
  costEffortOf,
  costFields,
  costOf,
  costTierOf,
  effortFromModelId
} from '../src/core/cost-estimate.ts';
import { buildAntigravityTelemetryEvent } from '../antigravity/logic.ts';
import { onPreToolUse, telemetryEvent, type HookInput } from '../claude/hook.ts';
import { out, rig, type Rig } from './workflow-helpers.ts';

describe('the weights table (version 1)', () => {
  it('is versioned and has exactly the agreed weights', () => {
    expect(COST_WEIGHTS_VERSION).toBe(1);
    expect(MODEL_WEIGHTS).toEqual({ openrouter_free: 0, flash_lite: 1, flash: 3, pro: 15 });
    expect(EFFORT_WEIGHTS).toEqual({ low: 0.5, medium: 1, high: 1.5, xhigh: 2, max: 3 });
  });
});

describe('model tiers', () => {
  it.each([
    ['haiku', 'flash_lite'],
    ['claude-haiku-5-5', 'flash_lite'],
    ['flash_lite', 'flash_lite'],
    ['gemini-3.8-flash-lite', 'flash_lite'],
    ['sonnet', 'flash'],
    ['claude-sonnet-5-5', 'flash'],
    ['flash', 'flash'],
    ['gemini-3.8-flash-low', 'flash'],
    ['opus', 'pro'],
    ['claude-opus-5-5', 'pro'],
    ['fable', 'pro'],
    ['pro', 'pro'],
    ['gemini-pro', 'pro'],
    ['gemini-3.5-pro-high', 'pro'],
    ['openrouter_free', 'openrouter_free'],
    ['openrouter/free', 'openrouter_free'],
    ['free', 'openrouter_free'],
    ['FREE', 'openrouter_free'],
    ['google/gemma-4-31b-it:free', 'openrouter_free']
  ])('%s is %s', (model, tier) => expect(costTierOf(model)).toBe(tier));

  it.each(['gpt-5', 'unknown', '', null, undefined, 5, {}])('%p has no tier', (m) => expect(costTierOf(m)).toBeNull());
});

describe('effort levels', () => {
  it('reads a literal level and nothing else', () => {
    for (const l of ['low', 'medium', 'high', 'xhigh', 'max', 'HIGH']) expect(costEffortOf(l)).toBe(l.toLowerCase());
    for (const l of ['higher', 'lower', 'ludicrous', '', 5, null, undefined, { level: 'max' }]) expect(costEffortOf(l)).toBeNull();
  });

  it('reads the Antigravity suffix of a model id (-low, -medium, -high, -xhigh) and no other', () => {
    expect(effortFromModelId('gemini-3.8-flash-low')).toBe('low');
    expect(effortFromModelId('gemini-3.5-pro-xhigh')).toBe('xhigh');
    expect(effortFromModelId('gemini-3.8-flash-medium')).toBe('medium');
    expect(effortFromModelId('gemini-3.5-pro-high')).toBe('high');
    expect(effortFromModelId('gemini-3.8-flash')).toBeNull();
    expect(effortFromModelId('flash-lite')).toBeNull();
    expect(effortFromModelId('claude-opus-5-5')).toBeNull();
  });
});

describe('cost = W_model[tier] * W_effort[level], ratio = cost(call) / cost(session)', () => {
  it('multiplies the weights', () => {
    expect(costOf('opus', 'max')).toBe(45);
    expect(costOf('sonnet', 'high')).toBe(4.5);
    expect(costOf('haiku', 'low')).toBe(0.5);
    expect(costOf('openrouter_free', 'max')).toBe(0);
    expect(costOf('gpt-5', 'high')).toBeNull();
  });

  it('a missing call effort is the session effort, and a missing session effort is medium', () => {
    expect(costFields({ model: 'haiku' }, { model: 'sonnet', effort: 'high' })).toEqual({ costEstimate: 1.5, sessionCost: 4.5, costRatio: 0.333, costWeightsVersion: 1 });
    expect(costFields({ model: 'haiku' }, { model: 'sonnet' })).toEqual({ costEstimate: 1, sessionCost: 3, costRatio: 0.333, costWeightsVersion: 1 });
    expect(costFields({ model: 'haiku', effort: 'higher' }, { model: 'sonnet', effort: 'high' }).costEstimate).toBe(1.5); // relative: not a level
  });

  it('no model, or inherit, is the session model', () => {
    for (const model of [undefined, 'inherit', 'INHERIT', '']) expect(costFields({ model, effort: 'max' }, { model: 'sonnet', effort: 'high' })).toEqual({ costEstimate: 9, sessionCost: 4.5, costRatio: 2, costWeightsVersion: 1 });
  });

  it('the free pool costs 0 at any effort, whatever spelling names it', () => {
    for (const m of ['openrouter/free', 'free', 'openrouter_free']) {
      expect(costOf(m, 'max')).toBe(0);
      expect(costFields({ model: m, effort: 'max' }, { model: 'sonnet', effort: 'high' })).toEqual({ costEstimate: 0, sessionCost: 4.5, costRatio: 0, costWeightsVersion: 1 });
    }
  });

  it('a call at the session model and effort costs exactly the session: ratio 1', () => {
    expect(costFields({ model: 'sonnet', effort: 'high' }, { model: 'sonnet', effort: 'high' }).costRatio).toBe(1);
  });

  it('an unknown call model has no estimate and no ratio; an unknown or free session has no ratio; the version is always there', () => {
    expect(costFields({ model: 'gpt-5' }, { model: 'sonnet' })).toEqual({ costEstimate: null, sessionCost: 3, costRatio: null, costWeightsVersion: 1 });
    expect(costFields({ model: 'haiku' }, { model: 'gpt-5' })).toEqual({ costEstimate: 1, sessionCost: null, costRatio: null, costWeightsVersion: 1 });
    expect(costFields({ model: 'haiku' }, { model: 'openrouter_free' })).toEqual({ costEstimate: 1, sessionCost: 0, costRatio: null, costWeightsVersion: 1 });
    expect(costFields({ model: 'haiku' }, {})).toMatchObject({ costRatio: null, costWeightsVersion: 1 });
  });

  it('Antigravity: the effort is the id suffix of each side; no suffix is medium for the session and the session\'s for the call (2.3.19)', () => {
    // session gemini-3.8-flash-low: 3 * 0.5 = 1.5; a call whose id names no effort runs at the session's, so `pro` is pro at low
    expect(antigravityCostFields('pro', 'gemini-3.8-flash-low')).toEqual({ costEstimate: 7.5, sessionCost: 1.5, costRatio: 5, costWeightsVersion: 1 });
    expect(antigravityCostFields(undefined, 'gemini-3.8-flash-low')).toEqual({ costEstimate: 1.5, sessionCost: 1.5, costRatio: 1, costWeightsVersion: 1 });
    expect(antigravityCostFields('flash', 'gemini-3.8-flash-low')).toEqual({ costEstimate: 1.5, sessionCost: 1.5, costRatio: 1, costWeightsVersion: 1 });
    expect(antigravityCostFields('gemini-3.8-flash-high', 'gemini-3.8-flash-low')).toEqual({ costEstimate: 4.5, sessionCost: 1.5, costRatio: 3, costWeightsVersion: 1 });
    expect(antigravityCostFields('gemini-3.5-pro-xhigh', 'gemini-3.8-flash-medium')).toEqual({ costEstimate: 30, sessionCost: 3, costRatio: 10, costWeightsVersion: 1 });
    expect(antigravityCostFields('flash_lite', 'gemini-3.8-flash')).toEqual({ costEstimate: 1, sessionCost: 3, costRatio: 0.333, costWeightsVersion: 1 });
  });
});

describe('Claude Code rows', () => {
  let r: Rig;
  beforeEach(() => void (r = rig()));
  afterEach(() => r.cleanup());
  const call = (toolInput: Record<string, unknown>, extra: Partial<HookInput> = {}): HookInput => ({
    session_id: 's1',
    prompt_id: 'p1',
    tool_name: 'Agent',
    cwd: r.project,
    tool_input: toolInput as any,
    effort: 'high',
    ...extra
  });
  const row = () => r.logs.at(-1) as Record<string, any>;

  it('a call that passes carries the estimate against the session (sonnet at high effort is 4.5)', async () => {
    expect(await onPreToolUse(call({ description: 'd', model: 'haiku', effort: 'low' }), r.d)).toBeNull();

    expect(row()).toMatchObject({ event: 'agent_call', decision: 'pass', costEstimate: 0.5, costRatio: 0.111, costWeightsVersion: 1 });
  });

  it('a denied call carries it too: the estimate of what was requested (opus at the session effort)', async () => {
    const o = out(await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(row()).toMatchObject({ decision: 'deny', costEstimate: 22.5, costRatio: 5, costWeightsVersion: 1 });
  });

  it('a call that names no model runs on the session model; a definition effort counts when the call names none', async () => {
    await onPreToolUse(call({ description: 'd' }), r.d);
    expect(row()).toMatchObject({ costEstimate: 4.5, costRatio: 1 });

    fs.mkdirSync(path.join(r.project, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(r.project, '.claude', 'agents', 'deep.md'), '---\nname: deep\neffort: max\n---\nbody\n');
    await onPreToolUse(call({ description: 'd', subagent_type: 'deep', model: 'haiku' }), r.d);
    expect(row()).toMatchObject({ costEstimate: 3, costRatio: 0.667 });
  });

  it('a Workflow row has the version and no estimate (its agents choose their own)', async () => {
    await onPreToolUse(call({ script: `await agent('p')` }, { tool_name: 'Workflow' }), r.d);

    expect(row()).toMatchObject({ tool_name: 'Workflow', costEstimate: null, costRatio: null, costWeightsVersion: 1 });
  });

  it('an on-demand row (no decision) carries it too', async () => {
    r.mode.value = 'on-demand';

    expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d)).toBeNull();

    expect(row()).toMatchObject({ event: 'agent_call', decision: 'pass', costEstimate: 45, costRatio: 10, costWeightsVersion: 1 });
  });

  it('it is the cost gate\'s figure since 2.3.19: with a session effort the verdict states the cost, without one the pre-2.3.19 rules decide', async () => {
    const a = out(await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d));
    const b = out(await onPreToolUse(call({ description: 'd', model: 'opus' }, { effort: undefined }), r.d));

    expect(a.permissionDecision).toBe('deny');
    expect(b.permissionDecision).toBe('deny');
    expect(a.permissionDecisionReason).toMatch(/costs 22\.5 vs the session's 4\.5 \(opus at high vs sonnet at high\)/);
    expect(b.permissionDecisionReason).not.toMatch(/cost/i);
    expect(row()).toMatchObject({ cost_gate: 'fallback' }); // the last row: no session effort, so the gate fell back
  });

  it('the telemetry row passes the three fields through, on a deny as well', () => {
    const e = telemetryEvent({
      hook: 'PreToolUse',
      event: 'agent_call',
      session_id: 's1',
      decision: 'deny',
      requested_model: 'opus',
      costEstimate: 22.5,
      costRatio: 5,
      costWeightsVersion: 1
    });
    expect(e).toMatchObject({ costEstimate: 22.5, costRatio: 5, costWeightsVersion: 1, decision: 'deny' });
    expect(telemetryEvent({ hook: 'UserPromptSubmit', session_id: 's1' })).not.toHaveProperty('costWeightsVersion');
  });
});

describe('Antigravity rows', () => {
  const build = (decision: any, args: Record<string, unknown>, model = 'gemini-3.8-flash-low') =>
    buildAntigravityTelemetryEvent({ kind: 'agent_call', conversationId: 'c1', inputModelName: model, lastUserInput: 'run worker', args, decision } as any);

  it('the telemetry row carries the estimate: pass, deny and ask alike', () => {
    for (const decision of ['pass', 'deny', 'ask']) {
      expect(build({ decision }, { TypeName: 'x', Model: 'pro' })).toMatchObject({ costEstimate: 7.5, costRatio: 5, costWeightsVersion: 1 });
    }
    expect(build({ decision: 'pass' }, { TypeName: 'x' })).toMatchObject({ costEstimate: 1.5, costRatio: 1, costWeightsVersion: 1 });
  });

  describe('hook process', () => {
    const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
    let home = '';
    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cost-'));
      fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
    const run = (mode: string, model: string) => {
      fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode } }));
      const telemetry = path.join(home, 'telemetry.jsonl');
      const proc = Bun.spawnSync(['bun', HOOK, 'pre-tool-use'], {
        stdin: new TextEncoder().encode(
          JSON.stringify({
            conversationId: `conv-${mode}`,
            lastUserInput: 'Invoke an expert agent',
            modelName: 'gemini-3.8-flash-low',
            toolCall: { id: 'call_1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: model } }
          })
        ),
        env: { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json'), JEV_DOWNGRADE: 'off', JEV_TELEMETRY_FILE: telemetry }
      });
      const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
      return {
        out: proc.stdout.toString().trim(),
        decision: lines(path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl')).find((e) => e.event === 'agent_call'),
        telemetry: lines(telemetry).find((e) => e.event === 'agent_call')
      };
    };

    it('mode on: a denied call (pro above a flash session) has the estimate on the decisions row and the telemetry row', () => {
      const res = run('on', 'pro');

      expect(JSON.parse(res.out).decision).toBe('deny');
      expect(res.decision).toMatchObject({ decision: 'deny', costEstimate: 7.5, costRatio: 5, costWeightsVersion: 1 });
      expect(res.telemetry).toMatchObject({ decision: 'deny', costEstimate: 7.5, costRatio: 5, costWeightsVersion: 1 });
    });

    it('mode on-demand: the call passes untouched and the rows have the estimate too', () => {
      const res = run('on-demand', 'pro');

      expect(res.out).toBe('');
      expect(res.decision).toMatchObject({ decision: 'pass', costEstimate: 7.5, costRatio: 5, costWeightsVersion: 1 });
      expect(res.telemetry).toMatchObject({ costEstimate: 7.5, costRatio: 5, costWeightsVersion: 1 });
    });
  });
});
