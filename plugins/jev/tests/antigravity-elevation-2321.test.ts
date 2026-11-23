/**
 * 2.3.21 (Antigravity): the same rules as Claude Code. An answered `[jev-elevate:<model>]` question counts as given (no window, no denial
 * needed); Jev's effort cap stays (the effort is the suffix of the model key: an answer is held to what Jev prescribed, else `high`);
 * 'Yes, once' is bound to the user turn (the hash of `lastUserInput`) and has no clock; the No labels decline (this delegation, or the
 * session); there is no 5 minute scope; every marker answer writes an `elevation_answer` row and queues one line for the model, which the
 * next pre-invocation delivers; a deny says what is stored.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateAntigravitySubagentCall, type AntigravityHookInput } from '../antigravity/logic.ts';
import { antigravityTurnKey, createAntigravityApprovalStore, type ApprovalStore } from '../antigravity/approvals.ts';

const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const PREFLIGHT = path.join(import.meta.dir, '..', 'antigravity', 'preflight.ts');
const MIN = 60_000;
const SESSION = 'gemini-3.8-flash-low';
const PROMPT = 'Invoke expert on pro';

const invoke = (conv: string, over: Partial<AntigravityHookInput> = {}, model = 'pro'): AntigravityHookInput => ({
  conversationId: conv,
  lastUserInput: PROMPT,
  modelName: SESSION,
  toolCall: { id: 'call_1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: model } },
  ...over
});

describe('the logic (in process)', () => {
  let dir = '';
  let store: ApprovalStore;
  const evalAt = (input: AntigravityHookInput, now: number, extra: object = {}) => evaluateAntigravitySubagentCall(input, { approvals: store, sessionModelOverride: SESSION, now: () => now, ...extra });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-2321-'));
    store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each([[20], [90], [600]])('an answer %i minutes after the denial is recorded, and approves the retry', (minutes) => {
    const T = 1_000_000;
    expect(evalAt(invoke('c1'), T).decision).toBe('deny');

    store.record('c1', { model: 'pro', scope: 'session', created_at: T + minutes * MIN });

    expect(evalAt(invoke('c1'), T + minutes * MIN + 1).decision).toBe('allow');
  });

  it('an answer asked before any denial is recorded', () => {
    expect(store.record('c2', { model: 'pro', scope: 'session', created_at: 5 })).toBe(true);
    expect(evalAt(invoke('c2'), 10).decision).toBe('allow');
  });

  it('Jev\'s prescribed effort caps the answer even when the marker names a higher one; none prescribed: high', () => {
    store.deny('c3', 'pro-high', 100);
    expect(store.recordWithResult!('c3', { model: 'pro-xhigh', scope: 'session', created_at: 200 })?.model).toBe('pro-high');
    // No expiry: the cap holds 3 hours later too.
    store.deny('c4', 'pro-xhigh', 100);
    expect(store.recordWithResult!('c4', { model: 'pro-max', scope: 'session', created_at: 100 + 180 * MIN })?.model).toBe('pro-xhigh');
    // Nothing prescribed: the marker's effort is held to high; a key with no effort suffix is left alone.
    expect(store.recordWithResult!('c5', { model: 'pro-xhigh', scope: 'session', created_at: 1 })?.model).toBe('pro-high');
    expect(store.recordWithResult!('c6', { model: 'claude-opus-5-5', scope: 'session', created_at: 1 })?.model).toBe('claude-opus-5-5');
  });

  it('a once is bound to the turn: one of two launches of the turn wins, a new user message drops it', () => {
    store.record('c7', { model: 'pro', scope: 'once', created_at: 1, turn: antigravityTurnKey(PROMPT) });

    const results = [evalAt(invoke('c7'), 10), evalAt(invoke('c7'), 11)];
    const next = evalAt(invoke('c7', { lastUserInput: 'a new message' }), 12);

    expect(results.map((r) => r.decision)).toEqual(['allow', 'deny']);
    expect(results[1].stored).toBe('once-used');
    expect(results[1].reason).toContain('Stored: the once approval was used by an earlier launch in this turn.');
    expect(next.decision).toBe('deny');
  });

  it('once-stale and effort-below, and none', () => {
    store.record('c8', { model: 'pro', scope: 'once', created_at: 1, turn: antigravityTurnKey('an earlier message') });
    const stale = evalAt(invoke('c8'), 10);
    expect(stale.stored).toBe('once-stale');
    expect(stale.reason).toContain('Stored: a once approval from an earlier turn was dropped.');

    expect(evalAt(invoke('c9'), 10)).toMatchObject({ stored: 'none' });
    expect(evalAt(invoke('c9'), 10).reason).toContain('Stored: no approval for pro in this session.');

    store.record('c10', { model: 'gemini-4-argon-high', scope: 'session', created_at: 1 });
    const below = evalAt(invoke('c10', {}, 'gemini-4-argon-xhigh'), 10, { costGateMode: 'enforce' });
    expect(below.decision).toBe('deny');
    expect(below.stored).toBe('effort-below');
    expect(below.reason).toContain('up to high; this call asks xhigh.');
  });

  it('the denial text names exactly four options and no timed scope', () => {
    const d = evalAt(invoke('c11'), 10);

    expect(d.reason).toContain("with four options in this order: 'Yes, once', 'Yes, for this session', 'No, proceed on flash', \"No, don't ask again this session\"");
    expect(d.reason).not.toContain('5 minutes');
  });

  it('a once No clamps only the next launch of the turn; a session No clamps every later launch (and stronger), silently', () => {
    store.recordDecline!('c12', { model: 'pro', scope: 'once', created_at: 1, turn: antigravityTurnKey(PROMPT) });
    const first = evalAt(invoke('c12'), 10);
    const second = evalAt(invoke('c12'), 11);
    expect([first.decision, first.overwrite, first.elevation, first.declineScope]).toEqual(['allow', { Model: 'flash' }, 'declined-once', 'once']);
    expect(second.decision).toBe('deny');

    store.recordDecline!('c13', { model: 'pro', scope: 'session', created_at: 1 });
    for (const lastUserInput of ['one', 'two', 'three']) {
      const d = evalAt(invoke('c13', { lastUserInput }), 10);
      expect([d.decision, d.overwrite, d.elevation]).toEqual(['allow', { Model: 'flash' }, 'declined-session']);
    }
  });

  it('a Yes drops the No it contradicts and a No drops the approval', () => {
    store.recordDecline!('c14', { model: 'pro', scope: 'session', created_at: 1 });
    store.record('c14', { model: 'pro', scope: 'session', created_at: 2 });
    expect(store.snapshot!('c14').declines ?? []).toEqual([]);
    expect(evalAt(invoke('c14'), 10).elevation).toBe('approved');

    store.recordDecline!('c14', { model: 'pro', scope: 'session', created_at: 3 });
    expect(store.snapshot!('c14').approvals).toEqual([]);
    expect(evalAt(invoke('c14'), 10).elevation).toBe('declined-session');
  });

  it('old approval files: a 5min record is dropped, a once with no turn is never live, and a session record loads', () => {
    const sessions = path.join(dir, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, 'c15.approvals.json'),
      JSON.stringify({ approvals: [{ model: 'pro', scope: '5min', created_at: 1 }, { model: 'pro', scope: 'once', created_at: 1 }, { model: 'flash', scope: 'session', created_at: 1 }] })
    );

    expect(store.snapshot!('c15').approvals.map((a) => a.scope)).toEqual(['once', 'session']);
    expect(evalAt(invoke('c15'), 10).decision).toBe('deny'); // pro: not covered by the old once, nor by a flash session record
  });

  it('a mode change voids approvals, declines and the prescription from before it', () => {
    const stamp = { defaults: { modeChangedAt: new Date(1000).toISOString() } };
    store.record('c16', { model: 'pro', scope: 'session', created_at: 500 });
    store.recordDecline!('c17', { model: 'pro', scope: 'session', created_at: 500 });

    expect(evalAt(invoke('c16'), 2000, { config: stamp }).decision).toBe('deny');
    expect(evalAt(invoke('c17'), 2000, { config: stamp }).decision).toBe('deny');
    store.deny('c18', 'pro-high', 500); // prescribed before the change: void, so the marker's xhigh is held to high anyway
    expect(store.recordWithResult!('c18', { model: 'pro-xhigh', scope: 'session', created_at: 2000 }, undefined, stamp)?.model).toBe('pro-high');
  });
});

describe('the real hook process', () => {
  let home = '';
  const config = () => path.join(home, '.config', 'jev', 'config.json');
  const setMode = (mode: string) => fs.writeFileSync(config(), JSON.stringify({ defaults: { mode } }));
  const env = () => ({ ...process.env, HOME: home, JEV_CONFIG_FILE: config(), JEV_DOWNGRADE: 'off', JEV_ELEVATION: '' });
  const run = (event: string, input: object) => Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env() });
  const decisionsFile = () => path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
  const rows = (): Array<Record<string, any>> =>
    fs.existsSync(decisionsFile()) ? fs.readFileSync(decisionsFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const approvalsOf = (conv: string): any[] => {
    const f = path.join(home, '.config', 'jev', 'antigravity-sessions', `${conv}.approvals.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).approvals : [];
  };
  const pre = (conv: string, over: Partial<AntigravityHookInput> = {}) => JSON.parse(run('pre-tool-use', invoke(conv, over)).stdout.toString());
  const answer = (conv: string, label: string, question = "[jev-elevate:pro] Allow subagent 'expert' to run on pro?", extra: Record<string, unknown> = {}) =>
    run('post-tool-use', {
      conversationId: conv,
      lastUserInput: PROMPT,
      modelName: SESSION,
      toolCall: { id: 'call_ask', name: 'ask_question', args: { questions: [{ question, options: ['Yes, once', 'No'] }] } },
      content: `A1: ${label}`,
      ...extra
    });
  const preflight = (conv: string): string[] => {
    const p = Bun.spawnSync(['bun', PREFLIGHT], { stdin: new TextEncoder().encode(JSON.stringify({ conversationId: conv, modelName: SESSION, lastUserInput: 'continue', invocationNum: 2 })), env: { ...env(), JEV_OPENROUTER_API_KEY: '' } });
    const parsed = p.stdout.toString().trim() ? JSON.parse(p.stdout.toString()) : {};
    return (parsed.injectSteps ?? []).map((s: any) => String(s.ephemeralMessage ?? '')).filter(Boolean);
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-2321-proc-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' }));
    setMode('on');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('an answer before any denial is recorded, capped at high (pro-xhigh is held to pro-high), logged, and approves the launch', () => {
    const post = answer('cp1', 'Yes, for this session', "[jev-elevate:pro-xhigh] Allow subagent 'expert' to run on pro at xhigh?");

    expect(post.stdout.toString().trim()).toBe('{}');
    expect(approvalsOf('cp1')).toMatchObject([{ model: 'pro-high', scope: 'session' }]);
    expect(rows().find((r) => r.event === 'elevation_answer')).toMatchObject({
      harness: 'antigravity',
      kind: 'model',
      model: 'pro-xhigh',
      effort: 'high',
      answer: 'yes',
      scope: 'session',
      recorded: true,
      session_id: 'cp1',
      callKey: 'call_ask',
      mode: 'on'
    });
    expect(rows().find((r) => r.event === 'ask_answer')).toMatchObject({ outcome: 'recorded' });
  });

  it('the line for the model is queued at the answer and delivered once by the next pre-invocation', () => {
    answer('cp2', 'Yes, once');

    const first = preflight('cp2');
    const second = preflight('cp2');

    expect(first.join('\n')).toContain('[jev] Recorded: pro, once (this turn) up to high. Relaunch now.');
    expect(second.join('\n')).not.toContain('[jev] Recorded');
  });

  it('a Yes, once is used by the first launch of the turn, and a new user message drops what is left', () => {
    answer('cp3', 'Yes, once');

    expect(pre('cp3').decision).toBe('allow');
    expect(pre('cp3').decision).toBe('deny');
    answer('cp3', 'Yes, once');
    expect(pre('cp3', { lastUserInput: 'a different message' }).decision).toBe('deny');
  });

  it('the 5 minute label is not an answer: recorded false, reason label, and the line lists the four labels', () => {
    answer('cp4', 'Yes, for the next 5 minutes');

    expect(approvalsOf('cp4')).toEqual([]);
    expect(rows().find((r) => r.event === 'elevation_answer')).toMatchObject({ recorded: false, reason: 'label', answer: null, scope: null });
    expect(preflight('cp4').join('\n')).toContain('[jev] Not recorded: the answer was not one of the four exact labels');
  });

  it('a No (this delegation) clamps the next launch only; the session No clamps every later launch, logged declined-session', () => {
    answer('cp5', 'No, proceed on flash');
    const once = pre('cp5');
    expect([once.decision, once.overwrite]).toEqual(['allow', { Model: 'flash' }]);
    expect(pre('cp5').decision).toBe('deny');
    expect(rows().filter((r) => r.event === 'agent_call').map((r) => r.elevation)).toEqual(['declined-once', 'denied']);

    answer('cp6', "No, don't ask again this session");
    for (const lastUserInput of ['m1', 'm2', 'm3']) {
      const d = pre('cp6', { lastUserInput });
      expect([d.decision, d.overwrite]).toEqual(['allow', { Model: 'flash' }]);
    }
    expect(rows().filter((r) => r.event === 'agent_call' && r.session_id === 'cp6').map((r) => [r.elevation, r.decline_scope])).toEqual([
      ['declined-session', 'session'],
      ['declined-session', 'session'],
      ['declined-session', 'session']
    ]);
    expect(preflight('cp6').join('\n')).toContain('[jev] Recorded: No for pro for this session; launches run on flash.');
  });

  it('on-demand writes the row (recorded false, reason mode) and records nothing; off writes nothing', () => {
    setMode('on-demand');
    answer('cp7', 'Yes, once');

    expect(approvalsOf('cp7')).toEqual([]);
    expect(rows().find((r) => r.event === 'elevation_answer')).toMatchObject({ recorded: false, reason: 'mode', answer: 'yes', scope: 'once', mode: 'on-demand' });
    expect(fs.existsSync(path.join(home, '.config', 'jev', 'antigravity-sessions'))).toBe(false);

    const before = fs.readFileSync(decisionsFile(), 'utf8');
    setMode('off');
    const post = answer('cp8', 'Yes, once');
    expect(post.stdout.toString().trim()).toBe('{}');
    expect(fs.readFileSync(decisionsFile(), 'utf8')).toBe(before);
  });

  it('a marker that does not parse: recorded false, reason marker', () => {
    answer('cp9', 'Yes, once', "[jev-elevate:Pro Plus] Allow it?");

    expect(rows().find((r) => r.event === 'elevation_answer')).toMatchObject({ recorded: false, reason: 'marker', model: null });
  });

  it('a late PostToolUse for the same answer row records nothing twice (the key is consumed): no second row', () => {
    answer('cp10', 'Yes, once', undefined, { stepIdx: 7 });
    answer('cp10', 'Yes, once', undefined, { stepIdx: 7 });

    expect(rows().filter((r) => r.event === 'elevation_answer')).toHaveLength(1);
    expect(approvalsOf('cp10')).toHaveLength(1);
  });
});
