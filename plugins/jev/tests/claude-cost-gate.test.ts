/**
 * The cost gate (2.3.19) in the Claude Code hook: one gate for the model and the effort of an Agent/Task call. A call needs
 * approval only when it costs more than the session's own model at the session's effort. Choice (deny with the prescribed
 * question), clamp (allow + updatedInput), dialog (ask), on-demand and off; approvals that cover an effort; the fallback to the
 * pre-2.3.19 rules where the cost cannot be computed; and the same rules for the agent() calls of a Workflow script.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { onPostToolUse, onPreToolUse, type HookInput } from '../claude/hook.ts';
import { out, rig, type Rig } from './workflow-helpers.ts';

let r: Rig;
afterEach(() => r?.cleanup());

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
const setEnv = (env: Record<string, string>) => void ((r.d as any).env = env);
const approve = (extra: Record<string, unknown>) => r.approvals.states.set('s1', { approvals: [], ...extra } as any);
const stored = (intent: Record<string, unknown>) =>
  r.turns.set('s1', { turn: 't1', promptId: 'p1', mode: 'on', intent: { models: [], ...intent }, at: new Date().toISOString() } as any);

describe('the gate: session opus at high (22.5)', () => {
  it('sonnet at max passes, opus at high passes, opus at xhigh is held', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-opus-5-5');

    expect(await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'max' }), r.d)).toBeNull();
    expect(row()).toMatchObject({ decision: 'pass', cost_gate: 'pass', costEstimate: 9, sessionCost: 22.5, costRatio: 0.4 });

    expect(await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d)).toBeNull();
    expect(row()).toMatchObject({ decision: 'pass', cost_gate: 'pass', costRatio: 1 });

    const o = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d));
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain("costs 30 vs the session's 22.5 (opus at xhigh vs opus at high)");
    expect(o.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate-effort:xhigh:opus]');
    expect(o.permissionDecisionReason).toContain("'No, run at high'");
    expect(row()).toMatchObject({ decision: 'deny', cost_gate: 'denied', effort_level: 'xhigh', effort_decision: 'denied', costEstimate: 30, sessionCost: 22.5 });
  });

  it('a stronger model at a low effort that costs less than the session still asks (the tier check: session sonnet at max, opus at low)', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');

    const o = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'low' }, { effort: 'max' }), r.d));

    // The gate would let the cost through (7.5 against 9); the model is above the session's, so the question is asked all the same.
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(row()).toMatchObject({ decision: 'deny', elevation: 'denied', cost_gate: 'pass', costEstimate: 7.5, sessionCost: 9 });
  });

  it('an effort above the session\'s on the same model is held even at high (session sonnet at medium, sonnet at high costs 4.5 vs 3)', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');

    const o = out(await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'high' }, { effort: 'medium' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate-effort:high:sonnet]');
    expect(o.permissionDecisionReason).toContain("'No, run at medium'");
  });
});

describe('choice (default): one question per held call, the existing markers', () => {
  it('a model above the session\'s is the model question; it names the effort in the marker only above high', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');

    const a = out(await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d));
    expect(a.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate:opus]');
    expect(a.permissionDecisionReason).toContain("costs 22.5 vs the session's 4.5 (opus at high vs sonnet at high)");
    expect(a.permissionDecisionReason).toContain("'No, proceed on sonnet'");

    const b = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d));
    expect(b.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate:opus:xhigh]');
    expect(b.permissionDecisionReason).toContain('launch it on sonnet at effort: "high"');
    expect(row()).toMatchObject({ cost_gate: 'denied', elevation: 'denied', elevation_attempt: 2 }); // the same delegation, asked again
    expect(row()).not.toHaveProperty('effort_level'); // one question: the model's, not also the effort's
  });

  it('an approval of opus at xhigh covers opus at xhigh, high and medium, not opus at max, and is spent only by a call that runs', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    approve({ approvals: [{ model: 'opus', scope: 'once', created_at: 0, turn: 'p1', effort: 'xhigh' }] });

    const max = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d));
    expect(max.permissionDecision).toBe('deny'); // not covered, and nothing was spent
    expect((r.approvals.states.get('s1') as any).approvals).toHaveLength(1);

    expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'high' }), r.d)).toBeNull();
    expect(row()).toMatchObject({ decision: 'pass', cost_gate: 'approved', elevation: 'approved', approval_scope: 'once' });
    expect((r.approvals.states.get('s1') as any).approvals).toHaveLength(0); // the once is used up
  });

  it('a record from before 2.3.19 (no effort) stands for that model at high or lower', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    approve({ approvals: [{ model: 'opus', scope: 'session', created_at: 0 }] });

    expect(await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d)).toBeNull();
    expect(row()).toMatchObject({ cost_gate: 'approved' });
    const xhigh = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d));
    expect(xhigh.permissionDecision).toBe('deny');
  });

  it('an effort approval that names a model covers that model and weaker ones, at its level and lower', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-opus-5-5');
    approve({ effortApprovals: [{ level: 'xhigh', scope: 'session', created_at: 0, model: 'opus' }] });

    expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d)).toBeNull();
    expect(row()).toMatchObject({ cost_gate: 'approved', effort_decision: 'approved', effort_approval_scope: 'session' });
    const max = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d));
    expect(max.permissionDecision).toBe('deny');
  });

  it('the answer to the effort question is recorded with its model and used on the retry', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-opus-5-5');
    const held = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d));
    expect(held.permissionDecision).toBe('deny');

    const question = '[jev-elevate-effort:xhigh:opus] Run general-purpose at xhigh?';
    await onPostToolUse(
      { session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question }] }, tool_response: { answers: { [question]: 'Yes, for this session' } } } as any,
      r.d as any
    );

    expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d)).toBeNull();
    expect(row()).toMatchObject({ cost_gate: 'approved', effort_decision: 'approved' });
  });

  it('what the user named in the prompt raises the baseline: a named model passes, a named effort passes', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    stored({ models: ['opus'] });
    expect(await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d)).toBeNull();
    expect(row()).toMatchObject({ decision: 'pass', elevation: 'instructed', cost_gate: 'pass' });

    stored({ models: [], effort: 'xhigh' });
    expect(await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'xhigh' }), r.d)).toBeNull();
    expect(row()).toMatchObject({ decision: 'pass', cost_gate: 'pass' });
    // a named model is not a named effort
    stored({ models: ['opus'] });
    const o = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d));
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate-effort:xhigh:opus]');
  });
});

describe('fallback: where the cost cannot be computed the pre-2.3.19 rules decide (never an allow)', () => {
  it('no session effort: the model ceiling by rank, no cost sentence', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');

    const o = out(await onPreToolUse(call({ description: 'd', model: 'opus' }, { effort: undefined }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate:opus]');
    expect(o.permissionDecisionReason).not.toMatch(/costs/);
    expect(row()).toMatchObject({ cost_gate: 'fallback' });
  });

  it('a relative effort ("higher") is not a level: the interim effort rule, with its own marker and "No, run at high"', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');

    const o = out(await onPreToolUse(call({ description: 'd', effort: 'higher' }, { effort: 'high' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate-effort:xhigh]');
    expect(o.permissionDecisionReason).toContain("'No, run at high'");
    expect(row()).toMatchObject({ cost_gate: 'fallback', effort_decision: 'denied' });
  });

  it('a model with no alias and an unreadable definition keep their own verdicts', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    fs.mkdirSync(path.join(r.project, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(r.project, '.claude', 'agents', 'broken.md'), '---\nname: broken\nmodel: [oops\n---\nbody\n');

    const o = out(await onPreToolUse(call({ description: 'd', subagent_type: 'broken' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('unreadable or ambiguous');
    expect(row()).toMatchObject({ cost_gate: 'fallback' });
  });
});

describe('clamp: the most expensive (model, effort) within the session\'s cost', () => {
  it('a model too much and an effort too high: the session model, the effort lowered to fit; both are logged', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    setEnv({ JEV_ELEVATION: 'clamp' });

    const o = out(await onPreToolUse(call({ description: 'd', prompt: 'p', model: 'opus', effort: 'max' }), r.d));

    expect(o.permissionDecision).toBe('allow');
    expect(o.updatedInput).toMatchObject({ description: 'd', prompt: 'p', model: 'sonnet', effort: 'high' });
    expect(row()).toMatchObject({ decision: 'allow', cost_gate: 'clamped', elevation: 'clamped', clamped_from: 'opus', clamped_to: 'sonnet', clamped_effort: 'high' });
  });

  it('only the effort too high: the same model, the effort lowered; never a deny', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-opus-5-5');
    setEnv({ JEV_ELEVATION: 'clamp' });

    const o = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d));

    expect(o.permissionDecision).toBe('allow');
    expect(o.updatedInput).toMatchObject({ model: 'opus', effort: 'high' });
    expect(row()).toMatchObject({ cost_gate: 'clamped', clamped_from: 'opus', clamped_to: 'opus', clamped_effort: 'high' });
  });

  it('a call at a lower effort than the session keeps it; a call within the cost is left alone', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    setEnv({ JEV_ELEVATION: 'clamp' });

    const low = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'low' }, { effort: 'low' }), r.d));
    expect(low.updatedInput).toMatchObject({ model: 'sonnet' });
    expect(low.updatedInput.effort).toBe('low'); // the call's own, unchanged

    expect(await onPreToolUse(call({ description: 'd', model: 'haiku', effort: 'max' }), r.d)).toBeNull(); // haiku at max is 3, within 4.5
    expect(row()).toMatchObject({ cost_gate: 'pass' });
  });

  it('a remapped session alias cannot be clamped to: denied with guidance, never asked', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    setEnv({ JEV_ELEVATION: 'clamp', ANTHROPIC_DEFAULT_SONNET_MODEL: 'some-model' });

    const o = out(await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(row()).toMatchObject({ clamp_skipped: 'alias-remapped' });
  });
});

describe('dialog: unchanged semantics (ask, auto_approve_warning)', () => {
  it('a model too much asks with the cost; an effort too high asks with the cost; auto-approve is a warning only', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    setEnv({ JEV_ELEVATION: 'dialog' });

    const m = out(await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d));
    expect(m.permissionDecision).toBe('ask');
    expect(m.permissionDecisionReason).toContain("It costs 22.5 vs the session's 4.5");
    expect(row()).toMatchObject({ decision: 'ask', cost_gate: 'denied' });

    const e = out(await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'max' }), r.d));
    expect(e.permissionDecision).toBe('ask');
    expect(e.permissionDecisionReason).toContain("costs 9 vs the session's 4.5 (sonnet at max vs sonnet at high)");
    expect(row()).toMatchObject({ effort_ask: true });

    await onPreToolUse(call({ description: 'd', model: 'opus' }, { permission_mode: 'auto' }), r.d);
    expect(row()).toMatchObject({ decision: 'ask', auto_approve_warning: true });
  });

  it('a call within the cost does not ask', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-opus-5-5');
    setEnv({ JEV_ELEVATION: 'dialog' });

    expect(await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'max' }), r.d)).toBeNull();
  });
});

describe('on-demand and off', () => {
  it('on-demand writes the row (with the costs) and decides nothing', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    r.mode.value = 'on-demand';

    expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d)).toBeNull();

    expect(row()).toMatchObject({ decision: 'pass', costEstimate: 45, sessionCost: 4.5, costRatio: 10 });
    expect(row()).not.toHaveProperty('cost_gate');
  });

  it('off writes nothing and decides nothing', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    r.mode.value = 'off';

    expect(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d)).toBeNull();

    expect(r.logs).toHaveLength(0);
  });
});

describe('Workflow scripts: the same rule, per agent() call', () => {
  const script = (opts: string) => ({ script: `await agent('p', ${opts})` });
  const wfCall = (toolInput: unknown, extra: Partial<HookInput> = {}): HookInput => ({
    session_id: 's1',
    prompt_id: 'p1',
    tool_name: 'Workflow',
    cwd: r.project,
    tool_input: toolInput as any,
    tool_use_id: 'toolu_1',
    effort: 'high',
    ...extra
  });

  it('session opus at high: sonnet at max passes; opus at xhigh is the effort question; opus at high passes', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-opus-5-5');

    expect(out(await onPreToolUse(wfCall(script("{ model: 'sonnet', effort: 'max' }")), r.d)).permissionDecision).toBeUndefined();
    expect(row()).toMatchObject({ workflow_guard: 'allow', cost_gate: 'pass' });
    expect(out(await onPreToolUse(wfCall(script("{ model: 'opus', effort: 'high' }")), r.d)).permissionDecision).toBeUndefined();

    const o = out(await onPreToolUse(wfCall(script("{ model: 'opus', effort: 'xhigh' }")), r.d));
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain("costs 30 vs the session's 22.5 (opus at xhigh vs opus at high)");
    expect(o.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate-effort:xhigh:opus]');
    expect(row()).toMatchObject({ workflow_guard: 'denied', cost_gate: 'denied', effort_level: 'xhigh' });
  });

  it('a model above the session\'s is the model question, with the effort in the marker above high', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');

    const a = out(await onPreToolUse(wfCall(script("{ model: 'opus' }")), r.d));
    expect(a.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate:opus]');
    expect(a.permissionDecisionReason).toContain('costs 22.5');

    const b = out(await onPreToolUse(wfCall(script("{ model: 'opus', effort: 'max' }")), r.d));
    expect(b.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate:opus:max]');
  });

  it('one answer covers the whole script at the approved effort or lower, not above it', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-opus-5-5');
    approve({ effortApprovals: [{ level: 'xhigh', scope: 'session', created_at: 0, model: 'opus' }] });

    expect(out(await onPreToolUse(wfCall(script("{ model: 'opus', effort: 'xhigh' }")), r.d)).permissionDecision).toBeUndefined();
    expect(row()).toMatchObject({ workflow_guard: 'allow', cost_gate: 'approved', effort_decision: 'approved' });
    expect(out(await onPreToolUse(wfCall(script("{ model: 'opus', effort: 'max' }")), r.d)).permissionDecision).toBe('deny');
  });

  it('what the user named in the prompt lets the call through, as before', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    stored({ models: ['opus'] });

    expect(out(await onPreToolUse(wfCall(script("{ model: 'opus' }")), r.d)).permissionDecision).toBeUndefined();
    expect(row()).toMatchObject({ workflow_guard: 'passed-instructed' });
  });

  it('clamp is the choice flow for a script (it cannot be clamped), never an ask; dialog asks', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    setEnv({ JEV_ELEVATION: 'clamp' });
    expect(out(await onPreToolUse(wfCall(script("{ model: 'opus' }")), r.d)).permissionDecision).toBe('deny');

    setEnv({ JEV_ELEVATION: 'dialog' });
    expect(out(await onPreToolUse(wfCall(script("{ model: 'opus' }")), r.d)).permissionDecision).toBe('ask');
  });

  it('where the cost cannot be computed (no session effort, a variable effort) the per-finding rules decide', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');

    const a = out(await onPreToolUse(wfCall(script("{ model: 'sonnet', effort: 'xhigh' }"), { effort: undefined }), r.d));
    expect(a.permissionDecision).toBe('deny');
    expect(a.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate-effort:xhigh]');
    expect(row()).toMatchObject({ cost_gate: 'fallback' });

    const b = out(await onPreToolUse(wfCall({ script: "await agent('p', { model: 'sonnet', effort: args.effort })" }), r.d));
    expect(b.permissionDecision).toBe('deny');
    expect(b.permissionDecisionReason).toContain('Jev cannot verify');
  });

  it('on-demand passes the script untouched', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    r.mode.value = 'on-demand';

    expect(await onPreToolUse(wfCall(script("{ model: 'opus', effort: 'max' }")), r.d)).toBeNull();
  });
});
