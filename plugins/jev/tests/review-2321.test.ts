/**
 * 2.3.21 review fixes (Claude Code and Antigravity): the effort answer keeps its model binding when the marker names a higher level, a
 * once No never withdraws a session Yes, the session No of the effort question lowers to the level the question's own No ran at,
 * Antigravity's effort cap reads only the model's own tier, the once-No line names the model the launch runs on, and a Workflow spends
 * a once No.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPostToolUse, onPreToolUse, type HookDeps, type HookInput } from '../claude/hook.ts';
import {
  claimEffortApproval,
  noteEffortDenied,
  normalizeApprovalState,
  recordApproval,
  recordDecline,
  recordEffortApproval,
  recordEffortDecline,
  resolveEffortDecline,
  type Dispatch
} from '../claude/logic.ts';
import { resolveChoiceElevation } from '../antigravity/logic.ts';
import { prescribedEffortFor, recordDecline as agyRecordDecline, createAntigravityApprovalStore, antigravityTurnKey } from '../antigravity/approvals.ts';
import { memoryApprovals } from './elevation-helpers.ts';

const SAMPLE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'posttooluse-askuserquestion.json'), 'utf8'));
const flashRec: Dispatch = { subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };
const T0 = 1_800_000_000_000;

const answered = (question: string, label: string): HookInput => {
  const s = { ...structuredClone(SAMPLE), prompt_id: 'p1', session_id: 's1' };
  for (const part of [s.tool_input, s.tool_response]) {
    part.questions[0].question = question;
    part.answers = { [question]: label };
  }
  return s as HookInput;
};
const MODEL_Q = (model: string) => `[jev-elevate:${model}] Run the delegation on ${model}?`;
const EFFORT_Q = (level: string) => `[jev-elevate-effort:${level}] Run the delegation at ${level}?`;
const INPUT = { description: 'WS1: refactor the parser', prompt: 'Refactor it.', subagent_type: 'code-engineer', model: 'opus' };
const call = (toolInput: Record<string, unknown> = INPUT, extra: Partial<HookInput> = {}): HookInput => ({ session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', tool_input: toolInput, ...extra });
const out = (o: Awaited<ReturnType<typeof onPreToolUse>>) => (o?.hookSpecificOutput ?? {}) as Record<string, any>;
const said = (o: Awaited<ReturnType<typeof onPostToolUse>>): string => String((o?.hookSpecificOutput as any)?.additionalContext ?? '');

function setup(sessionModel = 'claude-sonnet-5') {
  const logs: Array<Record<string, any>> = [];
  const turns = new Map<string, any>();
  const approvals = memoryApprovals();
  const d: HookDeps = {
    readMode: async () => 'on',
    readSessionModel: () => sessionModel,
    readQuotaStrategy: async () => 'unknown',
    dispatch: async () => flashRec,
    log: (e) => logs.push(e as Record<string, any>),
    readTurn: (s) => turns.get(s ?? '') ?? null,
    saveTurn: (s, st) => void turns.set(s ?? '', st),
    readConfig: () => ({}) as any,
    approvals,
    now: () => T0,
    env: {},
    downgrades: undefined
  };
  return { d, logs, approvals, post: (q: string, label: string) => onPostToolUse(answered(q, label), d) };
}

describe('review 1: an effort answer keeps the model binding when the marker names a higher level', () => {
  it('pure: prescription xhigh for sonnet, marker max: stored at xhigh for sonnet, and opus is not covered', () => {
    const asked = noteEffortDenied({ approvals: [] }, 'xhigh', 100, 'sonnet');
    const done = recordEffortApproval(asked, { level: 'max', scope: 'session', created_at: 200 }, 200);

    expect(done.approval).toMatchObject({ level: 'xhigh', model: 'sonnet', scope: 'session' });
    expect(claimEffortApproval(done.state, 'xhigh', 300, 'opus').approval).toBeNull();
    expect(claimEffortApproval(done.state, 'xhigh', 300, 'sonnet').approval).not.toBeNull();
  });

  it('the same binding when the marker names the same level (the case that already held)', () => {
    const asked = noteEffortDenied({ approvals: [] }, 'xhigh', 100, 'sonnet');
    expect(recordEffortApproval(asked, { level: 'xhigh', scope: 'session', created_at: 200 }, 200).approval.model).toBe('sonnet');
  });

  it('hook: a bare [jev-elevate-effort:max] answer after a xhigh/sonnet prescription does not cover opus', async () => {
    const { post, approvals } = setup();
    approvals.denyEffort!('s1', 'xhigh', T0, 'sonnet');
    await post(EFFORT_Q('max'), 'Yes, for this session');

    const stored = approvals.states.get('s1')!.effortApprovals![0];
    expect(stored).toMatchObject({ level: 'xhigh', model: 'sonnet' });
    expect(approvals.claimEffort!('s1', 'xhigh', T0, 'opus')).toBeNull();
  });
});

describe('review 2: a once No never withdraws a session Yes', () => {
  it('pure (model): a once No leaves the session approval and drops the unused once one; a session No drops both', () => {
    const base = { approvals: [{ model: 'opus', scope: 'session' as const, created_at: 1 }, { model: 'opus', scope: 'once' as const, created_at: 2, turn: 'p1' }] };
    const once = recordDecline(base, { model: 'opus', scope: 'once', created_at: 3, turn: 'p1' });
    expect(once.approvals).toEqual([{ model: 'opus', scope: 'session', created_at: 1 }]);
    expect(recordDecline(base, { model: 'opus', scope: 'session', created_at: 3 }).approvals).toEqual([]);
  });

  it('pure (effort): the same', () => {
    const base = {
      approvals: [],
      effortApprovals: [{ level: 'xhigh' as const, scope: 'session' as const, created_at: 1 }, { level: 'xhigh' as const, scope: 'once' as const, created_at: 2, turn: 'p1' }]
    };
    const once = recordEffortDecline(base, { level: 'xhigh', noEffort: 'high', scope: 'once', created_at: 3, turn: 'p1' });
    expect(once.effortApprovals).toEqual([{ level: 'xhigh', scope: 'session', created_at: 1 }]);
    expect(recordEffortDecline(base, { level: 'xhigh', noEffort: 'high', scope: 'session', created_at: 3 }).effortApprovals).toBeUndefined();
  });

  it('hook: after Yes for this session and a once No, the next prompt still launches opus with no question', async () => {
    const { d, post, approvals } = setup();
    await post(MODEL_Q('opus'), 'Yes, for this session');
    await post(MODEL_Q('opus'), 'No, proceed on sonnet');

    expect(approvals.states.get('s1')!.approvals).toHaveLength(1);
    expect(await onPreToolUse(call(INPUT, { prompt_id: 'p2' }), d)).toBeNull();
  });

  it('hook: the effort-below story: session Yes up to high, xhigh denied, once No, next prompt opus at high is not asked', async () => {
    const { d, post, approvals } = setup('claude-opus-5');
    approvals.deny('s1', 'opus', T0);
    await post(MODEL_Q('opus'), 'Yes, for this session');
    await post(MODEL_Q('opus'), 'No, proceed on sonnet');
    expect(approvals.states.get('s1')!.approvals).toHaveLength(1);
    expect(await onPreToolUse(call({ ...INPUT, model: 'opus' }, { prompt_id: 'p2' }), d)).toBeNull();
  });

  it('Antigravity pure: a once No keeps a session approval, drops a once one; a session No drops both', () => {
    const base = {
      approvals: [
        { model: 'pro', scope: 'session' as const, created_at: 1 },
        { model: 'pro', scope: 'once' as const, created_at: 2, turn: 't' }
      ]
    };
    const once = agyRecordDecline(base, { model: 'pro', scope: 'once', created_at: 3, turn: 't' });
    expect(once!.state.approvals).toEqual([{ model: 'pro', scope: 'session', created_at: 1 }]);
    expect(agyRecordDecline(base, { model: 'pro', scope: 'session', created_at: 3 })!.state.approvals).toEqual([]);
  });

  it('Antigravity store: the session Yes survives a once No and covers the next user message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-r2321-'));
    try {
      const store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
      store.record('c1', { model: 'pro', scope: 'session', created_at: 1 });
      store.recordDecline!('c1', { model: 'pro', scope: 'once', created_at: 2, turn: antigravityTurnKey('first message') });
      expect(store.snapshot!('c1').approvals).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review 3: the session No of the effort question lowers to the question\'s own No level', () => {
  it('pure: resolveEffortDecline uses the level noted when the question was prescribed; with none noted (or a once No) it keeps what it has', () => {
    const asked = noteEffortDenied({ approvals: [] }, 'xhigh', 100, 'sonnet', 'medium');
    const sessionNo = { level: 'xhigh' as const, noEffort: 'high' as const, scope: 'session' as const, created_at: 200 };
    expect(resolveEffortDecline(asked, sessionNo).noEffort).toBe('medium');
    expect(resolveEffortDecline({ approvals: [] }, sessionNo).noEffort).toBe('high');
    expect(resolveEffortDecline(asked, { ...sessionNo, scope: 'once', noEffort: 'low' }).noEffort).toBe('low');
    expect(normalizeApprovalState(JSON.parse(JSON.stringify(asked))).effortDeniedNo).toEqual({ xhigh: 'medium' });
  });

  it('hook: the session No runs every later launch at the level the question offered, and the line says so', async () => {
    const { d, post, approvals } = setup();
    approvals.denyEffort!('s1', 'xhigh', T0, 'sonnet', 'medium'); // the cost gate's question: "No, run at medium"

    const told = await post(EFFORT_Q('xhigh'), "No, don't ask again this session");
    const launch = out(await onPreToolUse(call({ description: 'd', effort: 'xhigh' }, { prompt_id: 'p2' }), d));

    expect(said(told)).toBe('[jev] Recorded: No for effort xhigh for this session; launches run at medium.');
    expect(approvals.states.get('s1')!.effortDeclines![0].noEffort).toBe('medium');
    expect([launch.permissionDecision, launch.updatedInput.effort]).toEqual(['allow', 'medium']);
  });

  it('hook: with no gate (the question\'s No is "run at high") the session No still lowers to high', async () => {
    const { post, approvals } = setup();
    approvals.denyEffort!('s1', 'xhigh', T0, undefined, 'high');
    const told = await post(EFFORT_Q('xhigh'), "No, don't ask again this session");
    expect(said(told)).toContain('launches run at high');
  });

  it('a deny of the effort question notes the No level (the gate\'s, else high)', async () => {
    const { d, approvals } = setup();
    await onPreToolUse(call({ description: 'd', effort: 'xhigh' }), d);
    expect(approvals.states.get('s1')!.effortDeniedNo).toEqual({ xhigh: 'high' });
  });
});

describe('review 4: Antigravity reads the effort cap from the model\'s own tier only', () => {
  it('a stronger tier\'s prescription does not raise the cap of a weaker one\'s answer', () => {
    const state = { approvals: [], denied: { 'pro-xhigh': 100, 'flash-high': 200 } };
    expect(prescribedEffortFor(state, 'flash-xhigh')).toBe('high');
    expect(prescribedEffortFor(state, 'pro-max')).toBe('xhigh');
  });

  it('the store holds the answer to the own-tier cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-r2321-'));
    try {
      const store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
      store.deny('c1', 'pro-xhigh', 100);
      store.deny('c1', 'flash-high', 200);
      expect(store.recordWithResult!('c1', { model: 'flash-xhigh', scope: 'session', created_at: 300 })?.model).toBe('flash-high');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review 5: the once-No line names the model the launch runs on', () => {
  it('Claude Code: a label naming another model does not change the line (the clamp runs on the session model)', async () => {
    const { d, post } = setup();
    const told = await post(MODEL_Q('opus'), 'No, proceed on haiku');
    expect(said(told)).toBe('[jev] Recorded: No for opus for this delegation (this turn); the next launch runs on sonnet.');
    expect(out(await onPreToolUse(call(), d)).updatedInput.model).toBe('sonnet');
  });
});

describe('review 7: a Workflow spends a once No', () => {
  const WF = (model: string): HookInput => ({ session_id: 's1', prompt_id: 'p1', tool_name: 'Workflow', tool_input: { script: `await agent('p', { model: '${model}' })` } as any });

  it('the first Workflow of the turn is denied without the question, the next one is asked about again', async () => {
    const { d, post, logs } = setup();
    await post(MODEL_Q('opus'), 'No, proceed on sonnet');

    const first = out(await onPreToolUse(WF('opus'), d));
    const second = out(await onPreToolUse(WF('opus'), d));

    expect(first.permissionDecisionReason).toContain('declined opus for this delegation');
    expect(first.permissionDecisionReason).not.toContain('Ask the user');
    expect(second.permissionDecision).toBe('deny');
    expect(second.permissionDecisionReason).toContain('[jev-elevate:opus');
    expect(logs.filter((l) => l.tool_name === 'Workflow').map((l) => l.elevation)).toEqual(['declined-once', 'denied']);
  });

  it('a session No is not spent: every Workflow of the session is denied without the question', async () => {
    const { d, post } = setup();
    await post(MODEL_Q('opus'), "No, don't ask again this session");
    for (let i = 0; i < 3; i++) expect(out(await onPreToolUse(WF('opus'), d)).permissionDecisionReason).toContain('declined opus for this session');
  });
});

describe('unchanged', () => {
  it('recordApproval still drops the declines it contradicts', () => {
    const declined = recordDecline({ approvals: [] }, { model: 'opus', scope: 'session', created_at: 1 });
    expect(recordApproval(declined, { model: 'opus', scope: 'session', created_at: 2 }, 2).state.declines).toBeUndefined();
  });
});

describe('review 7 (Antigravity): a script launch spends a once No', () => {
  it('the first script launch of the turn is denied without the question, the next one is asked about again', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-r2321-'));
    try {
      const store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
      const turn = antigravityTurnKey('first message');
      store.recordDecline!('c1', { model: 'pro', scope: 'once', created_at: 1, turn });
      const ctx = {
        approvalStore: store,
        sessionId: 'c1',
        requestedModel: 'pro',
        typeName: 'run_workflow',
        sessionCeilingTier: 'flash',
        isOrchestrator: false,
        nowMs: 10,
        transcriptPath: undefined,
        promptHash: turn,
        signature: 'sig'
      };
      const first = resolveChoiceElevation(ctx);
      const second = resolveChoiceElevation(ctx);

      expect([first.decision, first.elevation]).toEqual(['deny', 'declined-once']);
      expect(second.elevation).toBe('denied');
      expect(second.reason).toContain('[jev-elevate:pro]');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a session No is not spent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-r2321-'));
    try {
      const store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
      store.recordDecline!('c2', { model: 'pro', scope: 'session', created_at: 1 });
      const ctx = { approvalStore: store, sessionId: 'c2', requestedModel: 'pro', typeName: 'run_workflow', sessionCeilingTier: 'flash', isOrchestrator: false, nowMs: 10, transcriptPath: undefined, promptHash: 'x', signature: 's' };
      for (let i = 0; i < 3; i++) expect(resolveChoiceElevation(ctx).elevation).toBe('declined-session');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review 6 (Antigravity): an answer whose row is not read in time writes no row yet', () => {
  it('no_row: no elevation_answer row and no queued line at PostToolUse (the PreToolUse pull writes the one row; see review2-2321)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-r2321-home-'));
    try {
      fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
      const config = path.join(home, '.config', 'jev', 'config.json');
      fs.writeFileSync(config, JSON.stringify({ defaults: { mode: 'on' } }));
      const transcript = path.join(home, 'transcript_full.jsonl');
      fs.writeFileSync(transcript, '');
      const run = Bun.spawnSync(['bun', path.join(import.meta.dir, '..', 'antigravity', 'hook.ts'), 'post-tool-use'], {
        stdin: new TextEncoder().encode(
          JSON.stringify({
            conversationId: 'cn1',
            transcriptPath: transcript,
            stepIdx: 7,
            lastUserInput: 'Invoke expert on pro',
            modelName: 'gemini-3.8-flash-low',
            toolCall: { id: 'call_ask', name: 'ask_question', args: { questions: [{ question: "[jev-elevate:pro] Allow it?", options: ['Yes, once', 'No'] }] } }
          })
        ),
        env: { ...process.env, HOME: home, JEV_CONFIG_FILE: config }
      });
      expect(run.exitCode).toBe(0);
      const rows = fs
        .readFileSync(path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(rows.find((r) => r.event === 'ask_answer').outcome).toBe('no_row');
      expect(rows.filter((r) => r.event === 'elevation_answer')).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
