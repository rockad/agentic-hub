/**
 * The cost gate (2.3.19), the shared helper `src/core/cost-gate.ts` and the approval records built on it in both harnesses:
 * the examples of the decision, the fallbacks, the allowance the user's words give, and what an approval covers (an approved
 * effort and every lower one, never a higher one; a record from before 2.3.19 stands for at most `high`).
 */
import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  antigravityClampModel,
  antigravityCostGate,
  antigravityMarkerModel,
  approvalEffortOf,
  costComparison,
  effortOfCall,
  effortWithin,
  evaluateCostGate,
  highestEffortWithin,
  type CostGate
} from '../src/core/cost-gate.ts';
import {
  claimApproval,
  claimEffortApproval,
  consumeApprovals,
  noteDenied,
  noteEffortDenied,
  normalizeApprovalState,
  parseElevationAnswer,
  parseEffortAnswer,
  recordApproval,
  recordEffortApproval,
  type ApprovalState
} from '../claude/logic.ts';
import { claimApproval as agyClaim, noteDenied as agyNoteDenied, recordApproval as agyRecord, createAntigravityApprovalStore } from '../antigravity/approvals.ts';

const FLASH_LOW = 'gemini-3.8-flash-low';
const over = (g: CostGate) => {
  if (g.kind !== 'over') throw new Error(`expected over, got ${g.kind}`);
  return g;
};

describe('the decision: a call needs approval only when it costs more than the session', () => {
  const session = { model: 'opus', effort: 'high' as const }; // 15 * 1.5 = 22.5

  it('session opus at high: sonnet at max passes, opus at xhigh needs approval, opus at high passes', () => {
    const a = evaluateCostGate({ model: 'sonnet', effort: 'max' }, session);
    expect(a).toMatchObject({ kind: 'pass', callCost: 9, sessionCost: 22.5, limit: 22.5, ratio: 0.4 });

    const b = over(evaluateCostGate({ model: 'opus', effort: 'xhigh' }, session));
    expect(b).toMatchObject({ callCost: 30, sessionCost: 22.5, cause: 'effort', ratio: 1.333 });

    expect(evaluateCostGate({ model: 'opus', effort: 'high' }, session)).toMatchObject({ kind: 'pass', ratio: 1 });
  });

  it('the cost sentence names both sides', () => {
    expect(costComparison(over(evaluateCostGate({ model: 'opus', effort: 'xhigh' }, session)))).toBe("costs 30 vs the session's 22.5 (opus at xhigh vs opus at high)");
  });

  it('a model above the baseline is the model cause; a cheaper model with a high effort is the effort cause', () => {
    const m = over(evaluateCostGate({ model: 'opus', effort: 'high' }, { model: 'sonnet', effort: 'high' }));
    expect(m).toMatchObject({ cause: 'model', callCost: 22.5, sessionCost: 4.5, clampModel: true });
    const e = over(evaluateCostGate({ model: 'sonnet', effort: 'max' }, { model: 'sonnet', effort: 'high' }));
    expect(e).toMatchObject({ cause: 'effort', callCost: 9, clampModel: false });
  });

  it('a stronger model at a low effort can cost less than the session: it passes (session sonnet at max, opus at low)', () => {
    expect(evaluateCostGate({ model: 'opus', effort: 'low' }, { model: 'sonnet', effort: 'max' })).toMatchObject({ kind: 'pass', callCost: 7.5, sessionCost: 9 });
  });

  it('a missing model or inherit is the session model: the call costs what the session costs only at the same effort', () => {
    expect(evaluateCostGate({ model: 'opus', effort: 'high' }, { model: 'opus', effort: 'high' }).kind).toBe('pass');
  });

  it('the free pool costs nothing', () => {
    expect(evaluateCostGate({ model: 'openrouter/free', effort: 'max' }, session)).toMatchObject({ kind: 'pass', callCost: 0 });
  });
});

describe('the fallback: what cannot be computed keeps the rules of before 2.3.19 (never an allow)', () => {
  it.each([
    ['a model with no tier', { model: 'gpt-5', effort: 'high' as const }, { model: 'sonnet', effort: 'high' as const }, 'unknown-model'],
    ['a session model with no tier', { model: 'sonnet', effort: 'high' as const }, { model: 'gpt-5', effort: 'high' as const }, 'unknown-session-model'],
    ['a call effort that is not a level', { model: 'sonnet', effort: null }, { model: 'sonnet', effort: 'high' as const }, 'unknown-effort'],
    ['an unknown session effort', { model: 'sonnet', effort: 'high' as const }, { model: 'sonnet', effort: null }, 'unknown-session-effort'],
    ['a free session (its own cost is 0)', { model: 'sonnet', effort: 'high' as const }, { model: 'openrouter_free', effort: 'high' as const }, 'zero-baseline']
  ])('%s', (_what, call, session, why) => {
    expect(evaluateCostGate(call, session)).toEqual({ kind: 'fallback', why });
  });

  it('effortOfCall: the first candidate present decides; a present value that is not a level is unknown', () => {
    expect(effortOfCall(undefined, undefined, 'high')).toBe('high');
    expect(effortOfCall('max', 'low', 'high')).toBe('max');
    expect(effortOfCall(undefined, 'xhigh', 'high')).toBe('xhigh');
    expect(effortOfCall('higher', undefined, 'high')).toBeNull();
    expect(effortOfCall(undefined, undefined, null)).toBeNull();
  });
});

describe('the user\'s own words raise what the call is held to', () => {
  it('a named model is allowed at the session effort: opus on a sonnet session at high passes, opus at xhigh does not', () => {
    const session = { model: 'sonnet', effort: 'high' as const };
    expect(evaluateCostGate({ model: 'opus', effort: 'high' }, session, { model: 'opus' }).kind).toBe('pass');
    expect(evaluateCostGate({ model: 'opus', effort: 'xhigh' }, session, { model: 'opus' })).toMatchObject({ kind: 'over', cause: 'effort', limit: 22.5, sessionCost: 4.5 });
  });

  it('a named effort is allowed on the session model: sonnet at xhigh on a sonnet session at high passes', () => {
    expect(evaluateCostGate({ model: 'sonnet', effort: 'xhigh' }, { model: 'sonnet', effort: 'high' }, { effort: 'xhigh' }).kind).toBe('pass');
    expect(evaluateCostGate({ model: 'opus', effort: 'xhigh' }, { model: 'sonnet', effort: 'high' }, { effort: 'xhigh' })).toMatchObject({ kind: 'over', cause: 'model' });
  });
});

describe('the No option and the clamp', () => {
  it('No runs at the highest effort that keeps the cost within the session\'s, at most high', () => {
    expect(over(evaluateCostGate({ model: 'opus', effort: 'xhigh' }, { model: 'opus', effort: 'high' })).noEffort).toBe('high');
    // session sonnet at low (1.5): haiku at max (3) is over; haiku at high is 1.5, so No runs at high
    expect(over(evaluateCostGate({ model: 'haiku', effort: 'max' }, { model: 'sonnet', effort: 'low' })).noEffort).toBe('high');
    // session haiku at low (0.5): haiku at medium is over; No can only run at low
    expect(over(evaluateCostGate({ model: 'haiku', effort: 'medium' }, { model: 'haiku', effort: 'low' })).noEffort).toBe('low');
    // the cap: with a session at xhigh (6) xhigh itself would fit, but a No is never offered more than high
    expect(over(evaluateCostGate({ model: 'sonnet', effort: 'max' }, { model: 'sonnet', effort: 'xhigh' })).noEffort).toBe('high');
  });

  it('the clamp keeps the model when only the effort is over, and lowers the effort to the highest level that fits', () => {
    const g = over(evaluateCostGate({ model: 'opus', effort: 'max' }, { model: 'opus', effort: 'high' }));
    expect(g).toMatchObject({ clampModel: false, clampEffort: 'high' });
  });

  it('the clamp moves a model that is too much to the session model, at the call\'s effort lowered to fit', () => {
    const g = over(evaluateCostGate({ model: 'opus', effort: 'max' }, { model: 'sonnet', effort: 'high' }));
    expect(g).toMatchObject({ clampModel: true, clampEffort: 'high' });
    // a call at a lower effort than the session's keeps it
    const low = over(evaluateCostGate({ model: 'opus', effort: 'low' }, { model: 'haiku', effort: 'high' }));
    expect(low).toMatchObject({ clampModel: true, clampEffort: 'low' });
  });

  it('highestEffortWithin', () => {
    expect(highestEffortWithin('sonnet', 4.5)).toBe('high');
    expect(highestEffortWithin('sonnet', 4.5, 'medium')).toBe('medium');
    expect(highestEffortWithin('opus', 1)).toBeNull();
  });
});

describe('what an approval covers (Claude Code)', () => {
  const now = 1_000;
  const state = (approvals: ApprovalState['approvals'], extra: Partial<ApprovalState> = {}): ApprovalState => ({ approvals, ...extra });

  it('opus at xhigh covers opus at high and medium, not opus at max', () => {
    const s = state([{ model: 'opus', scope: 'session', created_at: now, effort: 'xhigh' }]);
    for (const e of ['low', 'medium', 'high', 'xhigh'] as const) expect(claimApproval(s, 'opus', now, null, e).approval).not.toBeNull();
    expect(claimApproval(s, 'opus', now, null, 'max').approval).toBeNull();
  });

  it('it never covers a stronger model than the approved one', () => {
    const s = state([{ model: 'sonnet', scope: 'session', created_at: now, effort: 'xhigh' }]);
    expect(claimApproval(s, 'opus', now, null, 'high').approval).toBeNull();
    expect(claimApproval(s, 'sonnet', now, null, 'xhigh').approval).not.toBeNull();
  });

  it('a record from before 2.3.19 (no effort) stands for that model at high or lower', () => {
    const s = state([{ model: 'opus', scope: 'session', created_at: now }]);
    expect(approvalEffortOf(s.approvals[0])).toBe('high');
    expect(claimApproval(s, 'opus', now, null, 'high').approval).not.toBeNull();
    expect(claimApproval(s, 'opus', now, null, 'medium').approval).not.toBeNull();
    expect(claimApproval(s, 'opus', now, null, 'xhigh').approval).toBeNull();
    // and with no effort asked for the old behaviour holds
    expect(claimApproval(s, 'opus', now).approval).not.toBeNull();
  });

  it('a once is consumed by the claim, a session approval is not', () => {
    const s = state([{ model: 'opus', scope: 'once', created_at: now, expires_at: now + 1000, effort: 'xhigh' }]);
    const c = claimApproval(s, 'opus', now, null, 'high');
    expect(c.approval?.scope).toBe('once');
    expect(c.state.approvals).toHaveLength(0);
  });

  it('the effort approval covers its level and lower; one that names a model covers that model and weaker ones only', () => {
    const s = state([], { effortApprovals: [{ level: 'xhigh', scope: 'session', created_at: now, model: 'sonnet' }] });
    expect(claimEffortApproval(s, 'high', now, 'sonnet').approval).not.toBeNull();
    expect(claimEffortApproval(s, 'xhigh', now, 'haiku').approval).not.toBeNull();
    expect(claimEffortApproval(s, 'max', now, 'sonnet').approval).toBeNull();
    expect(claimEffortApproval(s, 'high', now, 'opus').approval).toBeNull();
    // a record that names no model (from before 2.3.19) covers any model
    const legacy = state([], { effortApprovals: [{ level: 'max', scope: 'session', created_at: now }] });
    expect(claimEffortApproval(legacy, 'xhigh', now, 'opus').approval).not.toBeNull();
  });

  it('consumeApprovals spends the model and the effort approval together or neither', () => {
    const s = state([{ model: 'opus', scope: 'once', created_at: now, expires_at: now + 1000, effort: 'xhigh' }], {
      effortApprovals: [{ level: 'high', scope: 'once', created_at: now, expires_at: now + 1000 }]
    });
    expect(consumeApprovals(s, { model: { requested: 'opus', effort: 'xhigh' }, effort: 'xhigh' }, now)).toBeNull(); // the effort one does not cover xhigh
    const ok = consumeApprovals(s, { model: { requested: 'opus', effort: 'high' }, effort: 'high' }, now);
    expect(ok?.state.approvals).toHaveLength(0);
    expect(ok?.state.effortApprovals ?? []).toHaveLength(0);
  });
});

describe('the markers and what the recorder stores', () => {
  const answer = (marker: string, label: string) => ({
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: `${marker} Allow it?` }] },
    tool_response: { answers: { [`${marker} Allow it?`]: label } }
  });

  it('[jev-elevate:opus:xhigh] stores the effort, a bare [jev-elevate:opus] stores none', () => {
    expect(parseElevationAnswer(answer('[jev-elevate:opus:xhigh]', 'Yes, for this session'), 5)).toMatchObject({ model: 'opus', scope: 'session', effort: 'xhigh' });
    expect(parseElevationAnswer(answer('[jev-elevate:opus]', 'Yes, once'), 5)).not.toHaveProperty('effort');
  });

  it('[jev-elevate-effort:xhigh:opus] stores the level and the model, any level is a level', () => {
    expect(parseEffortAnswer(answer('[jev-elevate-effort:xhigh:opus]', 'Yes, once'), 5)).toMatchObject({ level: 'xhigh', model: 'opus', scope: 'once' });
    expect(parseEffortAnswer(answer('[jev-elevate-effort:high]', 'Yes, once'), 5)).toMatchObject({ level: 'high' });
    expect(parseEffortAnswer(answer('[jev-elevate-effort:ludicrous]', 'Yes, once'), 5)).toBeNull();
  });

  it('an answer cannot approve a higher effort than the question that was prescribed named', () => {
    const asked = noteDenied({ approvals: [] }, 'opus', 1, 'xhigh');
    const rec = recordApproval(asked, { model: 'opus', scope: 'session', created_at: 2, effort: 'max' }, 2);
    expect(rec?.approvals[0].effort).toBe('xhigh');
    // a question that named no effort (an old denial): the effort is dropped, which stands for at most high
    const bare = recordApproval(noteDenied({ approvals: [] }, 'opus', 1), { model: 'opus', scope: 'session', created_at: 2, effort: 'max' }, 2);
    expect(bare?.approvals[0]).not.toHaveProperty('effort');
  });

  it('an effort answer needs a prescribed effort question of that level or higher', () => {
    const asked = noteEffortDenied({ approvals: [] }, 'xhigh', 1);
    expect(recordEffortApproval(asked, { level: 'xhigh', scope: 'session', created_at: 2 }, 2)).not.toBeNull();
    expect(recordEffortApproval(asked, { level: 'max', scope: 'session', created_at: 2 }, 2)).toBeNull();
  });

  it('a stored state keeps the effort of an approval and the model of an effort approval; garbage is dropped', () => {
    const s = normalizeApprovalState({
      approvals: [{ model: 'opus', scope: 'session', created_at: 1, effort: 'xhigh' }, { model: 'opus', scope: 'session', created_at: 1, effort: 'ludicrous' }],
      effortApprovals: [{ level: 'high', scope: 'session', created_at: 1, model: 'sonnet' }, { level: 'high', scope: 'session', created_at: 1, model: 'gpt' }],
      deniedEffort: { opus: 'xhigh', gpt: 'max', sonnet: 'nonsense' }
    });
    expect(s.approvals.map((a) => a.effort)).toEqual(['xhigh', undefined]);
    expect(s.effortApprovals?.map((a) => a.model)).toEqual(['sonnet', undefined]);
    expect(s.deniedEffort).toEqual({ opus: 'xhigh' });
  });

  it('effortWithin', () => {
    expect(effortWithin('xhigh', 'high')).toBe(true);
    expect(effortWithin('high', 'xhigh')).toBe(false);
    expect(effortWithin('max', 'max')).toBe(true);
  });
});

describe('Antigravity: the effort is the suffix of the model id', () => {
  it('session pro at high (22.5): flash at max (9) passes, pro at xhigh (30) needs approval, pro at high passes', () => {
    expect(antigravityCostGate('flash-max', 'pro', 'gemini-3.5-pro-high')).toMatchObject({ kind: 'pass', callCost: 9, sessionCost: 22.5 });
    expect(antigravityCostGate('pro-xhigh', 'pro', 'gemini-3.5-pro-high')).toMatchObject({ kind: 'over', callCost: 30, cause: 'effort' });
    expect(antigravityCostGate('pro-high', 'pro', 'gemini-3.5-pro-high').kind).toBe('pass');
  });

  it('a call whose id names no effort runs at the session\'s: flash on a flash-low session passes, pro on it is the model cause', () => {
    expect(antigravityCostGate('flash', 'flash', 'gemini-3.8-flash-low').kind).toBe('pass');
    expect(antigravityCostGate('pro', 'flash', 'gemini-3.8-flash-low')).toMatchObject({ kind: 'over', cause: 'model', callCost: 7.5, sessionCost: 1.5 });
  });

  it('a model with no tier falls back to the ceiling by rank', () => {
    expect(antigravityCostGate('gpt-oss-120b-medium', 'flash', 'gemini-3.8-flash-low')).toEqual({ kind: 'fallback', why: 'unknown-model' });
  });

  it('the marker names the tier and the effort when the id names one or the effort is above high; a bare model stands for at most high', () => {
    const gate = (m: string, session: string) => over(antigravityCostGate(m, 'flash', session));
    // pro with no suffix on a flash-xhigh session runs at xhigh: the marker has to say so
    expect(antigravityMarkerModel('pro', gate('pro', 'gemini-3.8-flash-xhigh'))).toBe('pro-xhigh');
    // at or below high a bare model is enough (a record with no effort stands for high)
    expect(antigravityMarkerModel('pro', gate('pro', FLASH_LOW))).toBe('pro');
    // a full id (it holds dots, which a marker cannot) is written as the tier and the effort
    expect(antigravityMarkerModel('gemini-3.5-pro-max', gate('gemini-3.5-pro-max', 'gemini-3.8-flash-high'))).toBe('pro-max');
    expect(antigravityMarkerModel('pro', null)).toBe('pro');
  });

  it('the clamp: the ceiling alias when the model is too much, or the call\'s own id at the lowered effort', () => {
    const model = over(antigravityCostGate('gemini-3.5-pro-xhigh', 'flash', 'gemini-3.8-flash-high'));
    expect(antigravityClampModel('gemini-3.5-pro-xhigh', model, 'flash')).toBe('flash');
    expect(antigravityClampModel('pro', over(antigravityCostGate('pro', 'flash', 'gemini-3.8-flash-low')), 'flash')).toBe('flash');
    const effort = over(antigravityCostGate('gemini-3.5-pro-xhigh', 'pro', 'gemini-3.5-pro-high'));
    expect(antigravityClampModel('gemini-3.5-pro-xhigh', effort, 'pro')).toBe('gemini-3.5-pro-high');
  });

  it('an approval covers its effort and lower; a record that names none stands for high; a denial caps what an answer can approve', () => {
    const state = (models: string[]) => ({ approvals: models.map((model) => ({ model, scope: 'session' as const, created_at: 0 })) });
    expect(agyClaim(state(['pro-xhigh']), 'pro-high', 1).approval).not.toBeNull();
    expect(agyClaim(state(['pro-xhigh']), 'pro-max', 1).approval).toBeNull();
    expect(agyClaim(state(['pro']), 'pro', 1).approval).not.toBeNull();
    expect(agyClaim(state(['pro']), 'pro-high', 1).approval).not.toBeNull();
    expect(agyClaim(state(['pro']), 'pro-xhigh', 1).approval).toBeNull();
    // the call named no effort in its id: the effort the gate computed is what must be covered
    expect(agyClaim(state(['pro']), 'pro', 1, 'xhigh').approval).toBeNull();
    expect(agyClaim(state(['pro-xhigh']), 'pro', 1, 'xhigh').approval).not.toBeNull();
    // a weaker model is covered at or below the approved effort
    expect(agyClaim(state(['pro-xhigh']), 'flash', 1).approval).not.toBeNull();

    const asked = agyNoteDenied({ approvals: [] }, 'pro-high', 1);
    expect(agyRecord(asked, { model: 'pro-xhigh', scope: 'session', created_at: 2 }, 2)).toBeNull();
    expect(agyRecord(asked, { model: 'pro-high', scope: 'session', created_at: 2 }, 2)).not.toBeNull();
  });

  it('the file store passes the effort to the claim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cg-'));
    try {
      const store = createAntigravityApprovalStore(dir);
      store.deny('c1', 'pro-xhigh', 1000);
      expect(store.record('c1', { model: 'pro-xhigh', scope: 'session', created_at: 1001 })).toBe(true);
      expect(store.claim('c1', 'pro-max', 1002)).toBeNull();
      expect(store.claim('c1', 'pro-high', 1002)).not.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
