/**
 * 2.3.19: a stronger model always asks (the tier check), and the cost gate ships in shadow mode.
 *
 * - The tier check is the rank ceiling and holds in BOTH modes, in both harnesses, for Agent/Task, invoke_subagent and the agents
 *   of a Workflow / run_workflow script, whatever the call's effort.
 * - `costGate` is `shadow` (the default when unset) or `enforce`. Shadow decides like the rules of before the gate (rank ceiling and
 *   the interim xhigh / max effort rule) and every agent_call row says what the gate would have done (`cost_gate_shadow`); enforce
 *   lets the gate decide (`cost_gate`). Approvals work in both; on-demand and off are unchanged.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPostToolUse, onPreToolUse, type HookInput } from '../claude/hook.ts';
import { ELEVATE_MARKER_RE, EFFORT_MARKER_RE } from '../claude/logic.ts';
import { evaluateWorkflowInput } from '../claude/workflow-guard.ts';
import { clearConfigCacheForTesting, getCostGateMode } from '../src/core/config.ts';
import { parseCostGateMode, shadowStateOf, evaluateCostGate } from '../src/core/cost-gate.ts';
import {
  evaluateAntigravitySubagentCall,
  antigravityCostGateShadowState,
  type AntigravityHookInput
} from '../antigravity/logic.ts';
import { createAntigravityApprovalStore, type ApprovalStore } from '../antigravity/approvals.ts';
import { evaluateAntigravityWorkflowCall } from '../antigravity/workflow-guard.ts';
import { out, rig, type Rig } from './workflow-helpers.ts';

/* ------------------------------------------------------------------------------------------------ the config */

describe('costGate config: shadow unless set', () => {
  let dir = '';
  const saved = { file: process.env.JEV_CONFIG_FILE, gate: process.env.JEV_COST_GATE, harness: process.env.JEV_HARNESS };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cgmode-'));
    process.env.JEV_CONFIG_FILE = path.join(dir, 'config.json');
    delete process.env.JEV_COST_GATE;
    clearConfigCacheForTesting();
  });
  afterEach(() => {
    for (const [k, v] of [['JEV_CONFIG_FILE', saved.file], ['JEV_COST_GATE', saved.gate], ['JEV_HARNESS', saved.harness]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearConfigCacheForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (cfg: object) => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE as string, JSON.stringify(cfg));
    clearConfigCacheForTesting();
  };

  it('the default is shadow, with no config file and with a config that does not mention it', () => {
    expect(getCostGateMode('claude-code')).toBe('shadow');
    write({ defaults: { mode: 'on' } });
    expect(getCostGateMode('claude-code')).toBe('shadow');
    expect(getCostGateMode('antigravity')).toBe('shadow');
  });

  it('defaults.costGate applies to every harness; a harness override beats it', () => {
    write({ defaults: { mode: 'on', costGate: 'enforce' }, harnesses: { antigravity: { costGate: 'shadow' } } });
    expect(getCostGateMode('claude-code')).toBe('enforce');
    expect(getCostGateMode('antigravity')).toBe('shadow');
    write({ defaults: { mode: 'on' }, harnesses: { 'claude-code': { costGate: 'enforce' } } });
    expect(getCostGateMode('claude-code')).toBe('enforce');
    expect(getCostGateMode('antigravity')).toBe('shadow');
  });

  it('JEV_COST_GATE overrides the config; a value that is not a mode is ignored (a typo never enforces)', () => {
    write({ defaults: { mode: 'on', costGate: 'enforce' } });
    expect(getCostGateMode('claude-code', undefined, { JEV_COST_GATE: 'shadow' })).toBe('shadow');
    expect(getCostGateMode('claude-code', undefined, { JEV_COST_GATE: ' ENFORCE ' })).toBe('enforce');
    expect(getCostGateMode('claude-code', undefined, { JEV_COST_GATE: 'strict' })).toBe('enforce'); // ignored: the config says enforce
    write({ defaults: { mode: 'on', costGate: 'strict' } });
    expect(getCostGateMode('claude-code')).toBe('shadow');
  });

  it('a project config cannot turn the gate on (it is stripped to its allowlist)', () => {
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(path.join(proj, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.agents', 'jev.json'), JSON.stringify({ defaults: { costGate: 'enforce' }, harnesses: { 'claude-code': { costGate: 'enforce' } } }));
    write({ defaults: { mode: 'on' } });
    expect(getCostGateMode('claude-code', proj)).toBe('shadow');
  });

  it('parse and the shadow value', () => {
    expect(parseCostGateMode('shadow')).toBe('shadow');
    expect(parseCostGateMode('enforce')).toBe('enforce');
    expect(parseCostGateMode('on')).toBeNull();
    expect(parseCostGateMode(undefined)).toBeNull();
    const pass = evaluateCostGate({ model: 'sonnet', effort: 'low' }, { model: 'opus', effort: 'high' });
    const over = evaluateCostGate({ model: 'opus', effort: 'xhigh' }, { model: 'opus', effort: 'high' });
    expect(shadowStateOf(pass, 'choice')).toBe('pass');
    expect(shadowStateOf(over, 'choice')).toBe('denied');
    expect(shadowStateOf(over, 'dialog')).toBe('denied');
    expect(shadowStateOf(over, 'clamp')).toBe('clamped');
    expect(shadowStateOf(null, 'choice')).toBe('fallback');
    expect(shadowStateOf({ kind: 'fallback', why: 'unknown-effort' }, 'choice')).toBe('fallback');
  });
});

/* ------------------------------------------------------------------------------------------------ Claude Code */

describe('Claude Code: the tier check and shadow mode', () => {
  let r: Rig;
  afterEach(() => r?.cleanup());
  const MODES = ['shadow', 'enforce'] as const;
  const gate = (mode: 'shadow' | 'enforce') => ({ costGateMode: () => mode });
  const call = (toolInput: Record<string, unknown>, extra: Partial<HookInput> = {}): HookInput => ({
    session_id: 's1',
    prompt_id: 'p1',
    tool_name: 'Agent',
    cwd: r.project,
    tool_input: toolInput as any,
    effort: 'high',
    ...extra
  });
  const wfCall = (script: string, extra: Partial<HookInput> = {}): HookInput => ({
    session_id: 's1',
    prompt_id: 'p1',
    tool_name: 'Workflow',
    cwd: r.project,
    tool_input: { script } as any,
    tool_use_id: 'toolu_1',
    effort: 'high',
    ...extra
  });
  const row = () => r.logs.at(-1) as Record<string, any>;
  const answer = async (question: string, label = 'Yes, for this session') =>
    onPostToolUse({ session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question }] }, tool_response: { answers: { [question]: label } } } as any, r.d as any);
  const marker = (reason: string | undefined) => /\[jev-elevate(?:-effort)?:[^\]]+\]/.exec(reason ?? '')?.[0] ?? '';

  for (const mode of MODES) {
    describe(`tier check in ${mode}`, () => {
      it('opus at low under sonnet at max asks (the cost is lower, the model is stronger)', async () => {
        r = rig(gate(mode), 'claude-sonnet-5-5');
        const o = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'low' }, { effort: 'max' }), r.d));
        expect(o.permissionDecision).toBe('deny');
        expect(marker(o.permissionDecisionReason)).toBe('[jev-elevate:opus]');
        expect(row()).toMatchObject({ decision: 'deny', elevation: 'denied' });
        // The gate (computed in both modes) would have let the cost through.
        expect(row()).toHaveProperty(mode === 'enforce' ? 'cost_gate' : 'cost_gate_shadow', 'pass');
        expect(row()).not.toHaveProperty(mode === 'enforce' ? 'cost_gate_shadow' : 'cost_gate');
      });

      it('a model at or below the session passes, whatever its effort is relative to the gate: haiku and sonnet under sonnet', async () => {
        r = rig(gate(mode), 'claude-sonnet-5-5');
        expect(await onPreToolUse(call({ description: 'd', model: 'haiku', effort: 'low' }), r.d)).toBeNull();
        expect(await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'high' }), r.d)).toBeNull();
      });

      it('the answer to the question is recorded and the retry goes through', async () => {
        r = rig(gate(mode), 'claude-sonnet-5-5');
        const first = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'low' }, { effort: 'max' }), r.d));
        expect(ELEVATE_MARKER_RE.test(first.permissionDecisionReason.slice(first.permissionDecisionReason.indexOf('[jev-elevate:')))).toBe(true);
        await answer(`[jev-elevate:opus] Run on opus?`);
        expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'low' }, { effort: 'max' }), r.d)).toBeNull();
        expect(row()).toMatchObject({ decision: 'pass', elevation: 'approved' });
      });

      it('a prompt that names the model passes as instructed', async () => {
        r = rig(gate(mode), 'claude-sonnet-5-5');
        r.turns.set('s1', { turn: 't1', promptId: 'p1', mode: 'on', intent: { models: ['opus'] }, at: new Date().toISOString() } as any);
        expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'low' }, { effort: 'max' }), r.d)).toBeNull();
        expect(row()).toMatchObject({ decision: 'pass', elevation: 'instructed' });
      });

      it('a Workflow agent() call to a stronger model at a low effort asks too', async () => {
        r = rig(gate(mode), 'claude-sonnet-5-5');
        const o = out(await onPreToolUse(wfCall("await agent('x', { model: 'opus', effort: 'low' })", { effort: 'max' }), r.d));
        expect(o.permissionDecision).toBe('deny');
        expect(marker(o.permissionDecisionReason)).toBe('[jev-elevate:opus]');
      });

      it('a Workflow agent() call by an agent definition is judged the same way (the guard function)', () => {
        const none = { readScriptFile: () => ({ error: 'x' }), findNamedWorkflow: () => ({ error: 'x' }), agentDefinition: () => ({ found: false, model: null }) } as any;
        const d = evaluateWorkflowInput({ script: "await agent('x', { model: 'opus', effort: 'low' })" }, '/tmp', 'claude-sonnet-5-5', none, { sessionEffort: 'max', env: {}, costGate: mode });
        expect(d.decision).toBe('ask');
        expect(d.highestRequested).toBe('opus');
      });
    });
  }

  describe('shadow decides like the rules of before the gate and logs what the gate would have done', () => {
    it('session opus at high: opus at xhigh is held by the interim effort rule (bare marker), the row says the gate would have denied it', async () => {
      r = rig(gate('shadow'), 'claude-opus-5-5');
      const o = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d));
      expect(o.permissionDecision).toBe('deny');
      // The pre-2.3.19 effort question: no model in the marker, no cost in the reason.
      expect(marker(o.permissionDecisionReason)).toBe('[jev-elevate-effort:xhigh]');
      expect(o.permissionDecisionReason).not.toContain('costs 30');
      expect(row()).toMatchObject({ decision: 'deny', cost_gate_shadow: 'denied', costEstimate: 30, sessionCost: 22.5 });
      expect(row()).not.toHaveProperty('cost_gate');
    });

    it('session opus at high: sonnet at max is still held by the interim rule, though the gate would pass it (9 against 22.5)', async () => {
      r = rig(gate('shadow'), 'claude-opus-5-5');
      const o = out(await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'max' }), r.d));
      expect(o.permissionDecision).toBe('deny');
      expect(marker(o.permissionDecisionReason)).toBe('[jev-elevate-effort:max]');
      expect(row()).toMatchObject({ decision: 'deny', cost_gate_shadow: 'pass', costEstimate: 9, sessionCost: 22.5 });
    });

    it('enforce: the same two calls follow the gate (opus at xhigh held with the cost, sonnet at max passes)', async () => {
      r = rig(gate('enforce'), 'claude-opus-5-5');
      expect(await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'max' }), r.d)).toBeNull();
      expect(row()).toMatchObject({ cost_gate: 'pass' });
      const o = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d));
      expect(marker(o.permissionDecisionReason)).toBe('[jev-elevate-effort:xhigh:opus]');
      expect(o.permissionDecisionReason).toContain("costs 30 vs the session's 22.5");
      expect(row()).toMatchObject({ cost_gate: 'denied' });
      expect(row()).not.toHaveProperty('cost_gate_shadow');
    });

    it('the model question is the old plain one in shadow and carries the effort in enforce; both are accepted by the recorders', async () => {
      // sonnet session at high, opus at xhigh: shadow asks the model first (plain marker), then the effort (bare marker)
      r = rig(gate('shadow'), 'claude-sonnet-5-5');
      const m1 = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d));
      expect(marker(m1.permissionDecisionReason)).toBe('[jev-elevate:opus]');
      await answer('[jev-elevate:opus] Run on opus?');
      const m2 = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d));
      expect(marker(m2.permissionDecisionReason)).toBe('[jev-elevate-effort:xhigh]');
      expect(EFFORT_MARKER_RE.test('[jev-elevate-effort:xhigh] Run at xhigh?')).toBe(true);
      await answer('[jev-elevate-effort:xhigh] Run at xhigh?');
      expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d)).toBeNull();
      r.cleanup();

      // enforce: one question with the effort in the marker covers both
      r = rig(gate('enforce'), 'claude-sonnet-5-5');
      const e1 = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d));
      expect(marker(e1.permissionDecisionReason)).toBe('[jev-elevate:opus:xhigh]');
      await answer('[jev-elevate:opus:xhigh] Run on opus at xhigh?');
      expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d)).toBeNull();
    });

    it('an approval recorded under the other mode\'s marker still covers the call (an answer to the plain marker covers up to high)', async () => {
      r = rig(gate('enforce'), 'claude-sonnet-5-5');
      await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'high' }), r.d); // the question is prescribed
      await answer('[jev-elevate:opus] Run on opus?');
      expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'high' }), r.d)).toBeNull();
      r.cleanup();
      r = rig(gate('shadow'), 'claude-sonnet-5-5');
      await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'high' }), r.d);
      await answer('[jev-elevate:opus:high] Run on opus at high?');
      expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'high' }), r.d)).toBeNull();
    });

    it('clamp mode: the gate would have clamped; fallback where the cost cannot be computed', async () => {
      r = rig({ ...gate('shadow'), env: { JEV_ELEVATION: 'clamp' } }, 'claude-opus-5-5');
      await onPreToolUse(call({ description: 'd', prompt: 'p', model: 'opus', effort: 'max' }), r.d);
      expect(row()).toMatchObject({ cost_gate_shadow: 'clamped' });
      r.cleanup();
      r = rig(gate('shadow'), 'claude-opus-5-5');
      await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'higher' }), r.d);
      expect(row()).toMatchObject({ cost_gate_shadow: 'fallback' });
    });

    it('a Workflow row carries cost_gate_shadow: denied where the gate would hold the script, pass where it would not', async () => {
      r = rig(gate('shadow'), 'claude-opus-5-5');
      await onPreToolUse(wfCall("await agent('x', { model: 'opus', effort: 'xhigh' })"), r.d);
      expect(row()).toMatchObject({ cost_gate_shadow: 'denied', workflow_guard: 'denied' });
      expect(row()).not.toHaveProperty('cost_gate');
      // sonnet at max: the interim rule asks, the gate would not
      const o = out(await onPreToolUse(wfCall("await agent('x', { model: 'sonnet', effort: 'max' })"), r.d));
      expect(o.permissionDecision).toBe('deny');
      expect(row()).toMatchObject({ cost_gate_shadow: 'pass' });
      r.cleanup();
      r = rig(gate('enforce'), 'claude-opus-5-5');
      expect(await onPreToolUse(wfCall("await agent('x', { model: 'sonnet', effort: 'max' })"), r.d)).toBeNull();
      expect(row()).toMatchObject({ cost_gate: 'pass' });
    });
  });

  describe('on-demand and off are unchanged', () => {
    for (const mode of MODES) {
      it(`on-demand (${mode}): nothing is decided and the row carries neither field; off writes nothing`, async () => {
        r = rig(gate(mode), 'claude-sonnet-5-5');
        r.mode.value = 'on-demand';
        expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d)).toBeNull();
        expect(row()).toMatchObject({ decision: 'pass', costEstimate: 45 });
        expect(row()).not.toHaveProperty('cost_gate');
        expect(row()).not.toHaveProperty('cost_gate_shadow');
        r.mode.value = 'off';
        const before = r.logs.length;
        expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d)).toBeNull();
        expect(r.logs).toHaveLength(before);
      });
    }
  });

  it('with no costGateMode dependency and no environment the hook is in shadow', async () => {
    r = rig({}, 'claude-opus-5-5');
    await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'low' }), r.d);
    expect(row()).toMatchObject({ cost_gate_shadow: 'pass' });
    expect(row()).not.toHaveProperty('cost_gate');
    (r.d as any).env = { JEV_COST_GATE: 'enforce' };
    await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'low' }), r.d);
    expect(row()).toMatchObject({ cost_gate: 'pass' });
  });
});

/* ------------------------------------------------------------------------------------------------ Antigravity */

describe('Antigravity: the tier check and shadow mode', () => {
  let dir = '';
  let approvals: ApprovalStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cgshadow-'));
    approvals = createAntigravityApprovalStore(path.join(dir, 'sessions'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ARGON_MAX = 'gemini-4-argon-max'; // an Orchestrator planner: the subagent ceiling is flash at the planner's effort (max)
  const FLASH_LOW = 'gemini-3.8-flash-low';
  const sub = (model: string | undefined, session: string, prompt = 'run it'): AntigravityHookInput => ({
    conversationId: 'c1',
    lastUserInput: prompt,
    modelName: session,
    toolCall: { id: 't1', name: 'invoke_subagent', args: { TypeName: 'worker', Prompt: 'work', ...(model ? { Model: model } : {}) } }
  });
  const decide = (input: AntigravityHookInput, mode: 'shadow' | 'enforce', extra: Record<string, unknown> = {}) =>
    evaluateAntigravitySubagentCall(input, { approvals, sessionModelOverride: input.modelName, elevationMode: 'choice', costGateMode: mode, now: () => 1_000, ...extra });

  for (const mode of ['shadow', 'enforce'] as const) {
    describe(`tier check in ${mode}`, () => {
      it('a pro-class full id under the Orchestrator flash ceiling asks even when the planner is at max', () => {
        const r = decide(sub('gemini-4-argon-low', ARGON_MAX), mode, { sessionOrchestrator: true });
        expect(r).toMatchObject({ decision: 'deny', elevation: 'denied' });
        expect(r.reason).toContain('[jev-elevate:');
      });

      it('claude-opus-5-5-low under a flash-class session asks, a flash-class id passes', () => {
        expect(decide(sub('claude-opus-5-5-low', 'gemini-3.8-flash-max'), mode)).toMatchObject({ decision: 'deny' });
        expect(decide(sub('gemini-3.8-flash-low', 'gemini-3.8-flash-max'), mode)).toMatchObject({ decision: 'pass' });
      });

      it('a prompt that names the model passes as instructed', () => {
        expect(decide(sub('gemini-4-argon-low', ARGON_MAX, 'use manual pro approval for this'), mode, { sessionOrchestrator: true })).toMatchObject({ decision: 'allow', elevation: 'instructed' });
      });

      it('the answer is recorded and the retry goes through', () => {
        const first = decide(sub('gemini-4-argon-low', ARGON_MAX), mode, { sessionOrchestrator: true });
        const marker = /\[jev-elevate:([a-z0-9_-]+)\]/.exec(first.reason ?? '')?.[1];
        expect(marker).toBeTruthy();
        approvals.record('c1', { model: marker as string, scope: 'session', created_at: 1_000 });
        expect(decide(sub('gemini-4-argon-low', ARGON_MAX), mode, { sessionOrchestrator: true })).toMatchObject({ decision: 'allow', elevation: 'approved' });
      });

      it('a run_workflow script with a pro-class full id asks too', () => {
        const wf = (script: string) =>
          evaluateAntigravityWorkflowCall(
            { conversationId: 'cw', modelName: ARGON_MAX, lastUserInput: 'run it', toolCall: { id: 'w1', name: 'run_workflow', args: { Script: script } } },
            { mode: 'on', sessionModel: ARGON_MAX, sessionOrchestrator: true, approvals, costGateMode: mode, now: () => 1_000, pinDir: path.join(dir, 'pins'), definitions: { definition: () => ({ found: false, model: null }) } }
          );
        expect(wf('await agent("p", model="gemini-4-argon-low")').decision.decision).toBe('deny');
        expect(wf('await agent("p", model="flash")').decision.decision).toBe('pass');
      });
    });
  }

  it('shadow: the marker is the model as written, enforce: the tier and effort form; the recorders take both', () => {
    const s = decide(sub('gemini-4-argon-low', ARGON_MAX), 'shadow', { sessionOrchestrator: true });
    expect(s.reason).toContain('[jev-elevate:gemini-4-argon-low]');
    const e = decide(sub('gemini-4-argon-low', ARGON_MAX), 'enforce', { sessionOrchestrator: true });
    expect(e.reason).toContain('[jev-elevate:pro-low]');
    // an approval in the other form covers the call
    approvals.record('c1', { model: 'pro-low', scope: 'session', created_at: 1_000 });
    expect(decide(sub('gemini-4-argon-low', ARGON_MAX), 'enforce', { sessionOrchestrator: true })).toMatchObject({ decision: 'allow', elevation: 'approved' });
  });

  it('an enum pro under the Orchestrator follows served pricing in enforce (Hydrogen xhigh against flash at the planner\'s effort) and the rank ceiling in shadow', () => {
    // planner at max: flash at max (9) holds pro served as Hydrogen at xhigh (6): the gate passes it
    expect(decide(sub('pro', ARGON_MAX), 'enforce', { sessionOrchestrator: true })).toMatchObject({ decision: 'pass' });
    // the same call in shadow is held by the rank ceiling (pro above the flash ceiling), and the row says the gate would pass it
    expect(decide(sub('pro', ARGON_MAX), 'shadow', { sessionOrchestrator: true })).toMatchObject({ decision: 'deny' });
    expect(antigravityCostGateShadowState(sub('pro', ARGON_MAX), { sessionModel: ARGON_MAX, sessionOrchestrator: true })).toBe('pass');
    // planner at high: flash at high (4.5) is below pro's 6: enforce asks too, with the cost
    const high = 'gemini-4-argon-high';
    const held = decide(sub('pro', high), 'enforce', { sessionOrchestrator: true });
    expect(held).toMatchObject({ decision: 'deny' });
    expect(held.reason).toContain('costs');
    expect(antigravityCostGateShadowState(sub('pro', high), { sessionModel: high, sessionOrchestrator: true })).toBe('denied');
  });

  it('shadow decides like the old rules: flash at max on a flash-low session is held by the effort in enforce only', () => {
    // a full id of the session's own tier: the rank ceiling passes it, the gate holds it for its effort
    const input = sub('gemini-3.8-flash-max', FLASH_LOW);
    expect(decide(input, 'shadow')).toMatchObject({ decision: 'pass' });
    expect(decide(input, 'enforce')).toMatchObject({ decision: 'deny' });
    expect(antigravityCostGateShadowState(input, { sessionModel: FLASH_LOW })).toBe('denied');
    expect(antigravityCostGateShadowState(input, { sessionModel: FLASH_LOW, elevationMode: 'clamp' })).toBe('clamped');
    expect(antigravityCostGateShadowState(sub('gemini-3.8-flash-low', FLASH_LOW), { sessionModel: FLASH_LOW })).toBe('pass');
    expect(antigravityCostGateShadowState(sub('some-other-model', FLASH_LOW), { sessionModel: FLASH_LOW })).toBe('fallback');
    expect(antigravityCostGateShadowState(sub(undefined, FLASH_LOW), { sessionModel: FLASH_LOW })).toBe('pass');
  });

  describe('shadow approval coverage is the 2.3.19 one (stricter than before the gate, documented in the README)', () => {
    const FLASH_HIGH = 'gemini-3.8-flash-high';
    const approve = (model: string) => approvals.record('c1', { model, scope: 'session', created_at: 1_000 });

    it('approving a low-effort full id under an Orchestrator planner covers neither higher efforts, nor the enum, nor another vendor\'s id', () => {
      expect(decide(sub('gemini-4-argon-low', ARGON_MAX), 'shadow', { sessionOrchestrator: true })).toMatchObject({ decision: 'deny' });
      approve('gemini-4-argon-low');
      expect(decide(sub('gemini-4-argon-low', ARGON_MAX), 'shadow', { sessionOrchestrator: true })).toMatchObject({ decision: 'allow', elevation: 'approved' });
      for (const model of ['gemini-4-argon-high', 'gemini-4-argon-max', 'pro', 'claude-opus-5-5']) {
        expect(decide(sub(model, ARGON_MAX), 'shadow', { sessionOrchestrator: true })).toMatchObject({ decision: 'deny' });
      }
    });

    it('approving the enum pro on a flash session does not cover a full pro-class id', () => {
      expect(decide(sub('pro', FLASH_HIGH), 'shadow')).toMatchObject({ decision: 'deny' });
      approve('pro');
      expect(decide(sub('pro', FLASH_HIGH), 'shadow')).toMatchObject({ decision: 'allow', elevation: 'approved' });
      for (const model of ['gemini-4-argon-low', 'gemini-4-argon-xhigh']) {
        expect(decide(sub(model, FLASH_HIGH), 'shadow')).toMatchObject({ decision: 'deny' });
      }
    });

    it('an xhigh approval does not cover max', () => {
      expect(decide(sub('gemini-3.5-pro-xhigh', FLASH_HIGH), 'shadow')).toMatchObject({ decision: 'deny' });
      approve('gemini-3.5-pro-xhigh');
      expect(decide(sub('gemini-3.5-pro-xhigh', FLASH_HIGH), 'shadow')).toMatchObject({ decision: 'allow', elevation: 'approved' });
      expect(decide(sub('gemini-3.5-pro-max', FLASH_HIGH), 'shadow')).toMatchObject({ decision: 'deny' });
    });
  });

  describe('run_workflow: a full id names the effort it runs at, in shadow and on the enforce rank path', () => {
    const FLASH_HIGH = 'gemini-3.8-flash-high';
    const wf = (script: string, mode: 'shadow' | 'enforce') =>
      evaluateAntigravityWorkflowCall(
        { conversationId: 'cwe', modelName: FLASH_HIGH, lastUserInput: 'run it', toolCall: { id: 'w1', name: 'run_workflow', args: { Script: script } } },
        { mode: 'on', sessionModel: FLASH_HIGH, approvals, elevationMode: 'choice', costGateMode: mode, now: () => 1_000, pinDir: path.join(dir, 'pins'), definitions: { definition: () => ({ found: false, model: null }) } }
      );
    const markerOf = (r: { decision: { reason?: string } }) => /\[jev-elevate:([a-z0-9_-]+)\]/.exec(r.decision.reason ?? '')?.[1];
    const ARGON = 'await agent("p", model="gemini-4-argon-max")';

    it('shadow: the marker names the script\'s effort (pro-max), not high', () => {
      const r = wf(ARGON, 'shadow');
      expect(r.decision.decision).toBe('deny');
      expect(markerOf(r)).toBe('pro-max');
      expect(markerOf(wf('await agent("p", model="gemini-4-argon-xhigh")', 'shadow'))).toBe('pro-xhigh');
      expect(markerOf(wf('await agent("p", model="gemini-4-argon-low")', 'shadow'))).toBe('pro-low');
      // a full id that names no effort (the model's default) still stands for high at most
      expect(markerOf(wf('await agent("p", model="claude-opus-5-5")', 'shadow'))).toBe('pro-high');
    });

    it('shadow: a pro-high approval does not cover argon-max or opus-xhigh; a pro-max approval covers both', () => {
      approvals.record('cwe', { model: 'pro-high', scope: 'session', created_at: 1_000 });
      expect(wf(ARGON, 'shadow').decision.decision).toBe('deny');
      expect(wf('await agent("p", model="claude-opus-5-5-xhigh")', 'shadow').decision.decision).toBe('deny');
      approvals.record('cwe', { model: 'pro-max', scope: 'session', created_at: 1_000 });
      expect(wf(ARGON, 'shadow').decision.decision).toBe('allow');
      expect(wf('await agent("p", model="claude-opus-5-5-xhigh")', 'shadow').decision.decision).toBe('allow');
    });

    it('an enum value gets no effort suffix in shadow: the plain tier covers it', () => {
      expect(markerOf(wf('await agent("p", model="pro")', 'shadow'))).toBe('pro');
    });

    it('enforce asks the same marker for the same script (shadow and enforce agree)', () => {
      expect(markerOf(wf(ARGON, 'enforce'))).toBe('pro-max');
    });
  });

  it('on-demand is unchanged: nothing is decided in either mode', () => {
    for (const mode of ['shadow', 'enforce'] as const) {
      expect(decide(sub('gemini-4-argon-low', ARGON_MAX), mode, { sessionOrchestrator: true, mode: 'on-demand' })).toEqual({ decision: 'pass' });
    }
  });

  it('with no costGateMode dependency and no environment the guard is in shadow', () => {
    const saved = process.env.JEV_COST_GATE;
    delete process.env.JEV_COST_GATE;
    try {
      const r = evaluateAntigravitySubagentCall(sub('gemini-3.8-flash-max', FLASH_LOW), { approvals, sessionModelOverride: FLASH_LOW, elevationMode: 'choice', now: () => 1_000 });
      expect(r).toMatchObject({ decision: 'pass' });
    } finally {
      if (saved !== undefined) process.env.JEV_COST_GATE = saved;
    }
  });
});

/* ------------------------------------------------------------------------------------------------ the hook processes */

describe('through the hook processes: the config file picks the mode, the rows say which', () => {
  let home = '';
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cgshadow-proc-')));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.mkdirSync(path.join(home, 'proj', '.git'), { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const writeCfg = (cfg: object) => fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode: 'on' }, ...cfg }));
  const run = (hook: 'claude' | 'antigravity', event: string, input: object, extra: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json'),
      JEV_OPENROUTER_API_KEY: '',
      JEV_MODEL_REFRESH: 'off',
      JEV_DOWNGRADE: 'off',
      ...extra
    };
    for (const v of ['JEV_COST_GATE', 'JEV_ELEVATION', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE']) {
      if (!(v in extra)) delete env[v];
    }
    const p = Bun.spawnSync(['bun', path.join(import.meta.dir, '..', hook, 'hook.ts'), event], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: env as Record<string, string>,
      cwd: path.join(home, 'proj')
    });
    return p.stdout.toString().trim();
  };
  const claudeRows = () => fs.readFileSync(path.join(home, '.config', 'jev', 'claude_decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const agyRows = () => fs.readFileSync(path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const claudeAgent = (toolInput: object) => ({ session_id: 'sess-sh', prompt_id: 'p1', cwd: path.join(home, 'proj'), tool_name: 'Agent', tool_input: toolInput, effort: 'high' });
  const agySub = (model: string, session: string) => ({
    conversationId: 'c1',
    lastUserInput: 'run it',
    modelName: session,
    toolCall: { id: 't1', name: 'invoke_subagent', args: { TypeName: 'worker', Prompt: 'work', Model: model } }
  });

  it('Claude Code: unset is shadow (the interim rule decides, cost_gate_shadow on the row); defaults.costGate enforce and the env override switch it', () => {
    writeCfg({});
    run('claude', 'session-start', { session_id: 'sess-sh', model: 'claude-opus-5-5' });
    // sonnet at max under opus at high: the gate would pass it, the interim rule holds it
    const held = JSON.parse(run('claude', 'pre-tool-use', claudeAgent({ description: 'd', model: 'sonnet', effort: 'max' }))).hookSpecificOutput;
    expect(held.permissionDecision).toBe('deny');
    expect(claudeRows().at(-1)).toMatchObject({ cost_gate_shadow: 'pass' });
    expect(claudeRows().at(-1)).not.toHaveProperty('cost_gate');

    writeCfg({ defaults: { mode: 'on', costGate: 'enforce' } });
    expect(run('claude', 'pre-tool-use', claudeAgent({ description: 'd', model: 'sonnet', effort: 'max' }))).toBe('');
    expect(claudeRows().at(-1)).toMatchObject({ cost_gate: 'pass' });
    expect(claudeRows().at(-1)).not.toHaveProperty('cost_gate_shadow');

    expect(run('claude', 'pre-tool-use', claudeAgent({ description: 'd', model: 'sonnet', effort: 'max' }), { JEV_COST_GATE: 'shadow' })).not.toBe('');
    expect(claudeRows().at(-1)).toMatchObject({ cost_gate_shadow: 'pass' });
  });

  it('Antigravity: unset is shadow, a harness override enforces, and the telemetry row carries the same field', () => {
    writeCfg({});
    // flash at max on a flash-low session: the rank ceiling passes it, the gate would hold it
    expect(run('antigravity', 'pre-tool-use', agySub('gemini-3.8-flash-max', 'gemini-3.8-flash-low'))).toBe('');
    expect(agyRows().at(-1)).toMatchObject({ decision: 'pass', cost_gate_shadow: 'denied' });
    expect(agyRows().at(-1)).not.toHaveProperty('cost_gate');
    const tel = fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'jev_telemetry.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(tel.at(-1)).toMatchObject({ cost_gate_shadow: 'denied' });
    expect(tel.at(-1)).not.toHaveProperty('cost_gate');

    writeCfg({ harnesses: { antigravity: { costGate: 'enforce' } } });
    expect(JSON.parse(run('antigravity', 'pre-tool-use', agySub('gemini-3.8-flash-max', 'gemini-3.8-flash-low'))).decision).toBe('deny');
    expect(agyRows().at(-1)).toMatchObject({ decision: 'deny', cost_gate: 'denied' });
    expect(agyRows().at(-1)).not.toHaveProperty('cost_gate_shadow');
  });
});
