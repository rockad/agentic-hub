/**
 * The 2.3.19 review fixes on the Claude Code side:
 *  - a Workflow agent() call that names a model or an effort twice (a duplicated key, or two options objects) is judged at its
 *    worst case, never by the first finding alone;
 *  - the Workflow model question's marker, the denial note and the approval all carry the same effort, so the retry is covered;
 *  - an effort approval that names a model covers that model and weaker ones only, also where the cost cannot be computed;
 *  - a bare effort answer is recorded for the model the prescribed question named, and an answer's effort is capped by the
 *    denial of its own model.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { onPostToolUse, onPreToolUse, type HookInput } from '../claude/hook.ts';
import { claimEffortApproval, noteDenied, noteEffortDenied, normalizeApprovalState, recordApproval, recordEffortApproval } from '../claude/logic.ts';
import { evaluateWorkflowInput } from '../claude/workflow-guard.ts';
import { out, rig, type Rig } from './workflow-helpers.ts';

let r: Rig;
afterEach(() => r?.cleanup());

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
const agentCall = (toolInput: Record<string, unknown>, extra: Partial<HookInput> = {}): HookInput => ({
  session_id: 's1',
  prompt_id: 'p1',
  tool_name: 'Agent',
  cwd: r.project,
  tool_input: toolInput as any,
  effort: 'high',
  ...extra
});
const approve = (extra: Record<string, unknown>) => r.approvals.states.set('s1', { approvals: [], ...extra } as any);
const answer = async (question: string, label = 'Yes, for this session') =>
  onPostToolUse({ session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question }] }, tool_response: { answers: { [question]: label } } } as any, r.d as any);
const markerOf = (reason: string | undefined) => /\[jev-elevate(?:-effort)?:[^\]]+\]/.exec(reason ?? '')?.[0] ?? '';

describe('a Workflow agent() call with duplicate model or effort findings is judged at its worst case', () => {
  const HELD = [
    ['a duplicated model key', "await agent('x', { model: 'haiku', model: 'opus' })", '[jev-elevate:opus]'],
    ['two options objects', "await agent({ model: 'haiku' }, { model: 'opus' })", '[jev-elevate:opus]'],
    ['either order of the duplicate', "await agent('x', { model: 'opus', model: 'haiku' })", '[jev-elevate:opus]'],
    ['a duplicated effort key', "await agent('x', { model: 'sonnet', effort: 'low', effort: 'max' })", '[jev-elevate-effort:max:sonnet]']
  ] as const;
  for (const [name, script, marker] of HELD) {
    it(`${name}: held in choice mode with the session effort known`, async () => {
      r = rig({}, 'claude-sonnet-5-5');
      const o = out(await onPreToolUse(wfCall(script), r.d));
      expect(o.permissionDecision).toBe('deny');
      expect(o.permissionDecisionReason).toContain(`STARTS with the marker ${marker}`);
    });
  }

  it('every candidate fits: a duplicate between models within the session\'s cost passes', async () => {
    r = rig({}, 'claude-sonnet-5-5');
    expect(await onPreToolUse(wfCall("await agent('x', { model: 'haiku', model: 'sonnet' })"), r.d)).toBeNull();
    expect(await onPreToolUse(wfCall("await agent('x', { model: 'sonnet', effort: 'high', effort: 'low' })"), r.d)).toBeNull();
  });

  it('the decision keeps both findings: the worst of the models, at the highest of the efforts', () => {
    const none = { agentDefinition: () => null, workflowScript: () => null } as any;
    const d = evaluateWorkflowInput({ script: "await agent('x', { model: 'sonnet', model: 'opus', effort: 'low', effort: 'xhigh' })" }, '/tmp', 'claude-sonnet-5-5', none, { sessionEffort: 'high', env: {} });
    expect(d.decision).toBe('ask');
    expect(d.gate?.modelGate).toMatchObject({ callModel: 'opus', callEffort: 'xhigh' });
    expect(d.highestElevation?.requested).toBe('opus');
  });
});

describe('the Workflow model question: the denial is noted with the effort the marker shows', () => {
  it('session haiku at high, script opus at high and sonnet at max: "Yes, for this session" covers the retry', async () => {
    r = rig({}, 'claude-haiku-4-5');
    const script = "await agent('a', { model: 'opus', effort: 'high' })\nawait agent('b', { model: 'sonnet', effort: 'max' })";

    const held = out(await onPreToolUse(wfCall(script), r.d));
    expect(held.permissionDecision).toBe('deny');
    const marker = markerOf(held.permissionDecisionReason);
    expect(marker).toBe('[jev-elevate:opus:max]'); // the highest effort among the model-cause sites

    await answer(`${marker} Run the workflow?`);
    expect(await onPreToolUse(wfCall(script), r.d)).toBeNull();
    expect(r.logs.at(-1)).toMatchObject({ workflow_guard: 'allow', cost_gate: 'approved' });
  });
});

describe('an effort approval that names a model never covers another model, also where the cost cannot be computed', () => {
  it('Agent call: [jev-elevate-effort:max:haiku] does not cover opus at max with no session effort on the input', async () => {
    r = rig({}, 'claude-opus-5-5');
    approve({ effortApprovals: [{ level: 'max', scope: 'session', created_at: 0, model: 'haiku' }] });

    const o = out(await onPreToolUse(agentCall({ description: 'd', model: 'opus', effort: 'max' }, { effort: undefined }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(r.logs.at(-1)).toMatchObject({ cost_gate: 'fallback', effort_decision: 'denied' });
  });

  it('Agent call: the same approval for opus, or one that names no model (a legacy record), covers it', async () => {
    r = rig({}, 'claude-opus-5-5');
    approve({ effortApprovals: [{ level: 'max', scope: 'session', created_at: 0, model: 'opus' }] });
    expect(await onPreToolUse(agentCall({ description: 'd', model: 'opus', effort: 'max' }, { effort: undefined }), r.d)).toBeNull();

    r.cleanup();
    r = rig({}, 'claude-opus-5-5');
    approve({ effortApprovals: [{ level: 'max', scope: 'session', created_at: 0 }] });
    expect(await onPreToolUse(agentCall({ description: 'd', model: 'opus', effort: 'max' }, { effort: undefined }), r.d)).toBeNull();
  });

  it('Agent call that inherits: the session model is the call\'s model', async () => {
    r = rig({}, 'claude-opus-5-5');
    approve({ effortApprovals: [{ level: 'max', scope: 'session', created_at: 0, model: 'haiku' }] });
    const o = out(await onPreToolUse(agentCall({ description: 'd', effort: 'max' }, { effort: undefined }), r.d));
    expect(o.permissionDecision).toBe('deny');
  });

  it('Workflow: the strongest model the script runs on is the one an effort approval must cover', async () => {
    r = rig({}, 'claude-opus-5-5');
    const script = "await agent('a', { model: 'opus', effort: 'max' })";
    approve({ effortApprovals: [{ level: 'max', scope: 'session', created_at: 0, model: 'haiku' }] });
    expect(out(await onPreToolUse(wfCall(script, { effort: undefined }), r.d)).permissionDecision).toBe('deny');

    approve({ effortApprovals: [{ level: 'max', scope: 'session', created_at: 0, model: 'opus' }] });
    expect(await onPreToolUse(wfCall(script, { effort: undefined }), r.d)).toBeNull();
  });

  it('the pure claim: a model-scoped approval needs the call\'s model; a record with no model covers any', () => {
    const scoped = { approvals: [], effortApprovals: [{ level: 'max' as const, scope: 'session' as const, created_at: 0, model: 'haiku' as const }] };
    expect(claimEffortApproval(scoped, 'max', 1, 'opus').approval).toBeNull();
    expect(claimEffortApproval(scoped, 'max', 1).approval).toBeNull();
    expect(claimEffortApproval(scoped, 'max', 1, 'not-a-model').approval).toBeNull();
    expect(claimEffortApproval(scoped, 'max', 1, 'haiku').approval).not.toBeNull();
    const legacy = { approvals: [], effortApprovals: [{ level: 'max' as const, scope: 'session' as const, created_at: 0 }] };
    expect(claimEffortApproval(legacy, 'max', 1, 'opus').approval).not.toBeNull();
    expect(claimEffortApproval(legacy, 'max', 1).approval).not.toBeNull();
  });
});

describe('a bare effort answer is recorded for the model the prescribed question named', () => {
  it('through the hook: a bare [jev-elevate-effort:xhigh] answered after a question that named opus covers opus, not a stronger model', async () => {
    r = rig({}, 'claude-opus-5-5');
    const held = out(await onPreToolUse(agentCall({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d));
    expect(markerOf(held.permissionDecisionReason)).toBe('[jev-elevate-effort:xhigh:opus]');

    await answer('[jev-elevate-effort:xhigh] Run general-purpose at xhigh?');

    const state = r.approvals.states.get('s1') as any;
    expect(state.effortApprovals).toHaveLength(1);
    expect(state.effortApprovals[0]).toMatchObject({ level: 'xhigh', model: 'opus' });
    expect(await onPreToolUse(agentCall({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d)).toBeNull();
  });

  it('pure: the denial\'s model is stored per level; a bare answer takes it, a marker naming a stronger model is held to it, a weaker one is kept', () => {
    const asked = noteEffortDenied({ approvals: [] }, 'xhigh', 100, 'sonnet');
    expect(asked.effortDeniedModel).toEqual({ xhigh: 'sonnet' });
    const bare = recordEffortApproval(asked, { level: 'xhigh', scope: 'session', created_at: 101 }, 101);
    expect(bare?.effortApprovals?.[0]).toMatchObject({ model: 'sonnet' });
    const stronger = recordEffortApproval(asked, { level: 'xhigh', scope: 'session', created_at: 101, model: 'opus' }, 101);
    expect(stronger?.effortApprovals?.[0]).toMatchObject({ model: 'sonnet' });
    const weaker = recordEffortApproval(asked, { level: 'xhigh', scope: 'session', created_at: 101, model: 'haiku' }, 101);
    expect(weaker?.effortApprovals?.[0]).toMatchObject({ model: 'haiku' });
  });

  it('legacy: a denial that named no model records the answer as it is (no model: any model)', () => {
    const asked = noteEffortDenied({ approvals: [] }, 'xhigh', 100);
    expect(asked.effortDeniedModel).toBeUndefined();
    expect(recordEffortApproval(asked, { level: 'xhigh', scope: 'session', created_at: 101 }, 101)?.effortApprovals?.[0]).not.toHaveProperty('model');
    expect(recordEffortApproval({ approvals: [], effortDenied: { xhigh: 100 } }, { level: 'xhigh', scope: 'session', created_at: 101 }, 101)?.effortApprovals?.[0]).not.toHaveProperty('model');
  });

  it('a newer denial with no model replaces an older one that had one, and the models survive a round trip through the state file', () => {
    const a = noteEffortDenied({ approvals: [] }, 'xhigh', 100, 'opus');
    const b = noteEffortDenied(a, 'xhigh', 200);
    expect(b.effortDeniedModel).toBeUndefined();
    expect(normalizeApprovalState(JSON.parse(JSON.stringify(a))).effortDeniedModel).toEqual({ xhigh: 'opus' });
    expect(normalizeApprovalState({ approvals: [], effortDeniedModel: { xhigh: 'nonsense', bogus: 'opus' } }).effortDeniedModel).toBeUndefined();
  });
});

describe('a model approval takes the effort prescribed for its own model only', () => {
  it('a stronger model\'s denial at a higher effort does not raise what an answer for a weaker model can approve', () => {
    let s = noteDenied({ approvals: [] }, 'opus', 100, 'max');
    s = noteDenied(s, 'sonnet', 101, 'high');
    const next = recordApproval(s, { model: 'sonnet', scope: 'session', created_at: 102, effort: 'max' }, 102);
    expect(next?.approvals[0]).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  it('no effort on record for the model: the approval keeps none (it stands for at most high), even when a stronger model\'s denial has one', () => {
    let s = noteDenied({ approvals: [] }, 'opus', 100, 'max');
    s = noteDenied(s, 'sonnet', 101);
    const next = recordApproval(s, { model: 'sonnet', scope: 'session', created_at: 102, effort: 'max' }, 102);
    expect(next?.approvals[0]).toEqual({ model: 'sonnet', scope: 'session', created_at: 102 });
  });

  it('the same model: an answer at or below the prescribed effort is kept, above it is capped', () => {
    const s = noteDenied({ approvals: [] }, 'opus', 100, 'xhigh');
    expect(recordApproval(s, { model: 'opus', scope: 'session', created_at: 101, effort: 'high' }, 101)?.approvals[0]).toMatchObject({ effort: 'high' });
    expect(recordApproval(s, { model: 'opus', scope: 'session', created_at: 101, effort: 'max' }, 101)?.approvals[0]).toMatchObject({ effort: 'xhigh' });
  });
});
