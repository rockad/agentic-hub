/**
 * 2.3.21 re-review fixes. Owner rule: a once No ("No, proceed on <session model>" / "No, run at <level>") applies to the next covering
 * launch in the SAME turn even when a standing "Yes, for this session" covers it; within that turn the live once No wins over the session
 * Yes, which is kept (not deleted) and applies again in later turns. A session No still drops contradicting approvals and a Yes still
 * drops contradicting declines. Plus the Antigravity answer row: on-demand says `mode`, and a late row writes one row per answer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPostToolUse, onPreToolUse, type HookDeps, type HookInput } from '../claude/hook.ts';
import { claimDecline, recordApproval, recordDecline, type Dispatch } from '../claude/logic.ts';
import { claimUnlessDeclined, evaluateAntigravitySubagentCall, type AntigravityHookInput } from '../antigravity/logic.ts';
import { antigravityTurnKey, createAntigravityApprovalStore, type ApprovalStore } from '../antigravity/approvals.ts';
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
const WF = (model: string): HookInput => ({ session_id: 's1', prompt_id: 'p1', tool_name: 'Workflow', tool_input: { script: `await agent('p', { model: '${model}' })` } as any });

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
const agentCalls = (logs: Array<Record<string, any>>) => logs.filter((l) => l.event === 'agent_call');

describe('finding 1 (Claude, model): a once No wins over a session Yes within its turn', () => {
  it('pure: a once No and a session Yes overlap, claimDecline finds the No, and the session Yes is untouched', () => {
    const yes = recordApproval({ approvals: [] }, { model: 'opus', scope: 'session', created_at: 1 }, 1).state;
    const state = recordDecline(yes, { model: 'opus', scope: 'once', created_at: 2, turn: 'p1' });
    expect(state.approvals).toHaveLength(1);
    expect(claimDecline(state, 'opus', undefined, { turn: 'p1' }).decline).toMatchObject({ scope: 'once' });
    expect(claimDecline(state, 'opus', undefined, { turn: 'p2' }).decline).toBeNull();
  });

  it('hook: deny, Yes for this session, No proceed on sonnet in p1: the next launch in p1 is clamped, the one after and p2 use the session Yes', async () => {
    const { d, post, approvals, logs } = setup();
    expect(out(await onPreToolUse(call(), d)).permissionDecision).toBe('deny');
    await post(MODEL_Q('opus'), 'Yes, for this session');
    const told = await post(MODEL_Q('opus'), 'No, proceed on sonnet');
    expect(String((told?.hookSpecificOutput as any)?.additionalContext)).toContain('the next launch runs on sonnet');

    const first = out(await onPreToolUse(call(), d));
    expect([first.permissionDecision, first.updatedInput.model]).toEqual(['allow', 'sonnet']);
    // The once No is spent; the session Yes was kept and covers the rest of the turn and every later turn.
    expect(approvals.states.get('s1')!.declines ?? []).toEqual([]);
    expect(approvals.states.get('s1')!.approvals).toHaveLength(1);
    expect(await onPreToolUse(call(), d)).toBeNull();
    expect(await onPreToolUse(call(INPUT, { prompt_id: 'p2' }), d)).toBeNull();

    expect(agentCalls(logs).map((l) => [l.elevation, l.approval_scope ?? l.decline_scope ?? null])).toEqual([
      ['denied', null],
      ['declined-once', 'once'],
      ['approved', 'session'],
      ['approved', 'session']
    ]);
  });

  it('hook: a session No still drops the session Yes, and a Yes after a No still drops the decline', async () => {
    const { d, post, approvals } = setup();
    await post(MODEL_Q('opus'), 'Yes, for this session');
    await post(MODEL_Q('opus'), "No, don't ask again this session");
    expect(approvals.states.get('s1')!.approvals).toEqual([]);
    expect(out(await onPreToolUse(call(), d)).updatedInput.model).toBe('sonnet');

    await post(MODEL_Q('opus'), 'Yes, for this session');
    expect(approvals.states.get('s1')!.declines).toBeUndefined();
    expect(await onPreToolUse(call(), d)).toBeNull();
  });

  it('hook: a Workflow holding the model is denied (the once No spent) in the No turn, then runs on the session Yes', async () => {
    const { d, post } = setup();
    await post(MODEL_Q('opus'), 'Yes, for this session');
    await post(MODEL_Q('opus'), 'No, proceed on sonnet');

    expect(out(await onPreToolUse(WF('opus'), d)).permissionDecisionReason).toContain('declined opus for this delegation');
    expect(await onPreToolUse(WF('opus'), d)).toBeNull();
  });
});

describe('finding 3 (Claude, effort): a once No wins over a session Yes within its turn', () => {
  const EFFORT_CALL = { description: 'd', effort: 'xhigh' };

  it('hook: session Yes for xhigh, once No "run at high" in p1: the next xhigh launch of p1 runs at high, p2 launches at xhigh', async () => {
    const { d, post, approvals, logs } = setup();
    approvals.denyEffort!('s1', 'xhigh', T0, undefined, 'high');
    await post(EFFORT_Q('xhigh'), 'Yes, for this session');
    await post(EFFORT_Q('xhigh'), 'No, run at high');
    expect(approvals.states.get('s1')!.effortApprovals).toHaveLength(1);

    const first = out(await onPreToolUse(call(EFFORT_CALL), d));
    expect([first.permissionDecision, first.updatedInput.effort]).toEqual(['allow', 'high']);
    expect(approvals.states.get('s1')!.effortDeclines ?? []).toEqual([]);
    // Spent: the rest of the turn and the later turns use the session Yes.
    expect(await onPreToolUse(call(EFFORT_CALL), d)).toBeNull();
    expect(await onPreToolUse(call(EFFORT_CALL, { prompt_id: 'p2' }), d)).toBeNull();
    expect(agentCalls(logs).map((l) => l.effort_decision)).toEqual(['declined', 'approved', 'approved']);
  });

  it('hook: a Workflow holding the effort is denied (the once No spent) in the No turn, then runs on the session Yes', async () => {
    const { d, post, approvals } = setup();
    approvals.denyEffort!('s1', 'xhigh', T0, undefined, 'high');
    await post(EFFORT_Q('xhigh'), 'Yes, for this session');
    await post(EFFORT_Q('xhigh'), 'No, run at high');
    const wf: HookInput = { session_id: 's1', prompt_id: 'p1', tool_name: 'Workflow', tool_input: { script: "await agent('p', { effort: 'xhigh' })" } as any };

    expect(out(await onPreToolUse(wf, d)).permissionDecisionReason).toContain('declined effort xhigh for this delegation');
    expect(await onPreToolUse(wf, d)).toBeNull();
  });
});

describe('finding 2 (Antigravity): a once No wins over a session Yes within its turn', () => {
  const SESSION = 'gemini-3.8-flash-low';
  const PROMPT = 'Invoke expert on pro';
  const invoke = (conv: string, over: Partial<AntigravityHookInput> = {}): AntigravityHookInput => ({
    conversationId: conv,
    lastUserInput: PROMPT,
    modelName: SESSION,
    toolCall: { id: 'call_1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } },
    ...over
  });
  let dir = '';
  let store: ApprovalStore;
  const evalAt = (input: AntigravityHookInput, extra: object = {}) =>
    evaluateAntigravitySubagentCall(input, { approvals: store, sessionModelOverride: SESSION, now: () => 1_000_000, ...extra });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-r2-2321-'));
    store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('the next launch of the No turn is clamped, the once No is spent, and the kept session Yes covers the rest of the turn and later turns', () => {
    store.record('c1', { model: 'pro', scope: 'session', created_at: 1 });
    store.recordDecline!('c1', { model: 'pro', scope: 'once', created_at: 2, turn: antigravityTurnKey(PROMPT) });
    expect(store.snapshot!('c1').approvals).toHaveLength(1);

    const first = evalAt(invoke('c1'));
    expect([first.decision, first.elevation, first.declineScope, first.overwrite]).toEqual(['allow', 'declined-once', 'once', { Model: 'flash' }]);
    expect(store.snapshot!('c1').declines ?? []).toEqual([]);

    const second = evalAt(invoke('c1'));
    expect([second.decision, second.elevation, second.approvalScope]).toEqual(['allow', 'approved', 'session']);
    const later = evalAt(invoke('c1', { lastUserInput: 'a different message' }));
    expect([later.decision, later.elevation, later.approvalScope]).toEqual(['allow', 'approved', 'session']);
  });

  it('a once No of another turn does not hold the session Yes back', () => {
    store.record('c2', { model: 'pro', scope: 'session', created_at: 1 });
    store.recordDecline!('c2', { model: 'pro', scope: 'once', created_at: 2, turn: antigravityTurnKey('an earlier message') });
    expect(evalAt(invoke('c2')).elevation).toBe('approved');
  });

  it('claimUnlessDeclined: choice mode defers to a live No (and spends nothing); clamp mode and no No claim as before', () => {
    store.record('c3', { model: 'pro', scope: 'once', created_at: 1, turn: antigravityTurnKey(PROMPT) });
    store.recordDecline!('c3', { model: 'pro', scope: 'once', created_at: 2, turn: antigravityTurnKey(PROMPT) });
    const ectx = { turn: antigravityTurnKey(PROMPT), config: null };
    expect(claimUnlessDeclined(store, 'c3', 'pro', 5, undefined, ectx, 'choice')).toBeNull();
    expect(store.snapshot!('c3').declines).toHaveLength(1); // the No was only peeked
    // The once Yes was dropped by the once No (an unused once approval it contradicts), so a clamp-mode claim finds none either.
    expect(claimUnlessDeclined(store, 'c3', 'pro', 5, undefined, ectx, 'clamp')).toBeNull();
    store.record('c3', { model: 'pro', scope: 'session', created_at: 6 });
    expect(claimUnlessDeclined(store, 'c3', 'pro', 7, undefined, ectx, 'clamp')).toMatchObject({ scope: 'session' });
  });
});

describe('findings 4 and 5 (Antigravity): the answer row', () => {
  const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
  const SESSION = 'gemini-3.8-flash-low';
  const PROMPT = 'Invoke expert on pro';
  let home = '';
  const config = () => path.join(home, '.config', 'jev', 'config.json');
  const setMode = (mode: string) => fs.writeFileSync(config(), JSON.stringify({ defaults: { mode } }));
  const run = (event: string, input: object) =>
    Bun.spawnSync(['bun', HOOK, event], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: config(), JEV_DOWNGRADE: 'off', JEV_ELEVATION: '' }
    });
  const rows = (): Array<Record<string, any>> => {
    const f = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const ASK = { id: 'call_ask', name: 'ask_question', args: { questions: [{ question: "[jev-elevate:pro] Allow it?", options: ['Yes, once', 'No'] }] } };
  const post = (conv: string, transcriptPath: string, extra: Record<string, unknown> = {}) =>
    run('post-tool-use', { conversationId: conv, transcriptPath, stepIdx: 7, lastUserInput: PROMPT, modelName: SESSION, toolCall: ASK, ...extra });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-r2-2321-proc-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' }));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('finding 4: on-demand gives reason "mode" whether or not the answer row was read', () => {
    setMode('on-demand');
    const transcript = path.join(home, 'transcript_full.jsonl');
    fs.writeFileSync(transcript, '');
    expect(post('od-late', transcript).exitCode).toBe(0);
    const late = rows().filter((r) => r.event === 'elevation_answer');
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ recorded: false, reason: 'mode', answer: null, mode: 'on-demand' });

    expect(post('od-read', transcript, { content: 'A1: Yes, once' }).exitCode).toBe(0);
    expect(rows().filter((r) => r.event === 'elevation_answer' && r.session_id === 'od-read')).toMatchObject([{ recorded: false, reason: 'mode', answer: 'yes', scope: 'once' }]);
  });

  it('finding 5: a late answer row writes no row and queues no line at PostToolUse, and the PreToolUse pull writes the one row', () => {
    setMode('on');
    const conv = 'late1';
    const transcript = path.join(home, 'transcript_full.jsonl');
    const stamp = (ms: number) => new Date(Date.now() + ms).toISOString();
    const planner = JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: stamp(1000), source: 'MODEL', status: 'DONE', content: '', tool_calls: [{ name: ASK.name, args: ASK.args }] }); // real transcripts carry no tool call id
    fs.writeFileSync(transcript, planner + '\n');

    // 1. The first launch is denied with the question (the denial the answer belongs to).
    const invoke = { conversationId: conv, transcriptPath: transcript, lastUserInput: PROMPT, modelName: SESSION, toolCall: { id: 'call_1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } } };
    expect(JSON.parse(run('pre-tool-use', invoke).stdout.toString()).decision).toBe('deny');

    // 2. The question is answered, but its row is not in the transcript within the wait: no elevation_answer row, no queued line.
    expect(post(conv, transcript).exitCode).toBe(0);
    expect(rows().filter((r) => r.event === 'elevation_answer')).toEqual([]);
    expect(rows().find((r) => r.event === 'ask_answer')).toMatchObject({ outcome: 'no_row' });
    const notice = path.join(home, '.config', 'jev', 'antigravity-sessions', `${conv}.answer-notice.json`);
    expect(fs.existsSync(notice)).toBe(false);

    // 3. The row lands; the next launch pulls it and writes the single row, recorded.
    fs.appendFileSync(transcript, JSON.stringify({ step_index: 7, type: 'GENERIC', created_at: stamp(2000), source: 'MODEL', status: 'DONE', content: 'A1: Yes, once' }) + '\n');
    const pulled = JSON.parse(run('pre-tool-use', invoke).stdout.toString());
    expect(pulled.decision).toBe('allow');
    expect(rows().filter((r) => r.event === 'elevation_answer')).toMatchObject([{ recorded: true, answer: 'yes', scope: 'once', model: 'pro' }]);
  });
});
