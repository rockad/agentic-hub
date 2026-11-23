/**
 * 2.3.21 (Claude Code): an answered elevation (or effort) question counts as given. No window, no denial needed; Jev's own effort cap
 * stays; the options are 'Yes, once' (bound to the turn, no clock), 'Yes, for this session', 'No, proceed on <alias>' (this delegation)
 * and "No, don't ask again this session"; the answer hook tells the assistant what was recorded; every answer writes an
 * `elevation_answer` row; a deny says what is stored.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPostToolUse, onPreToolUse, telemetryEvent, type HookDeps, type HookInput } from '../claude/hook.ts';
import { normalizeApprovalState, type Dispatch } from '../claude/logic.ts';
import { memoryApprovals } from './elevation-helpers.ts';

const SAMPLE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'posttooluse-askuserquestion.json'), 'utf8'));
const flashRec: Dispatch = { subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };
const T0 = 1_800_000_000_000;
const MIN = 60_000;

const answered = (question: string, label: string, extra: Record<string, unknown> = {}): HookInput => {
  const s = { ...structuredClone(SAMPLE), prompt_id: 'p1', session_id: 's1' };
  for (const part of [s.tool_input, s.tool_response]) {
    part.questions[0].question = question;
    part.answers = { [question]: label };
  }
  return { ...s, ...extra } as HookInput;
};
const MODEL_Q = (model: string, effort = '') => `[jev-elevate:${model}${effort ? `:${effort}` : ''}] Run the delegation on ${model}?`;
const EFFORT_Q = (level: string) => `[jev-elevate-effort:${level}] Run the delegation at ${level}?`;
const INPUT = { description: 'WS1: refactor the parser', prompt: 'Refactor it.', subagent_type: 'code-engineer', model: 'opus' };
const call = (toolInput: Record<string, unknown> = INPUT, extra: Partial<HookInput> = {}): HookInput => ({ session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', tool_input: toolInput, ...extra });
const out = (o: Awaited<ReturnType<typeof onPreToolUse>>) => (o?.hookSpecificOutput ?? {}) as Record<string, any>;
const said = (o: Awaited<ReturnType<typeof onPostToolUse>>): string => String((o?.hookSpecificOutput as any)?.additionalContext ?? '');

function setup(overrides: Partial<HookDeps> = {}) {
  const logs: Array<Record<string, any>> = [];
  const turns = new Map<string, any>();
  const approvals = memoryApprovals();
  const clock = { t: T0 };
  const mode = { value: 'on' };
  const config = { value: {} as Record<string, unknown> };
  const d: HookDeps = {
    readMode: async () => mode.value as 'on',
    readSessionModel: () => 'claude-sonnet-5',
    readQuotaStrategy: async () => 'unknown',
    dispatch: async () => flashRec,
    log: (e) => logs.push(e as Record<string, any>),
    readTurn: (s) => turns.get(s ?? '') ?? null,
    saveTurn: (s, st) => void turns.set(s ?? '', st),
    readConfig: () => config.value as any,
    approvals,
    now: () => clock.t,
    env: {},
    ...overrides
  };
  const post = (q: string, label: string, extra: Record<string, unknown> = {}) => onPostToolUse(answered(q, label, extra), d);
  return { d, logs, approvals, clock, mode, config, post, advance: (ms: number) => void (clock.t += ms) };
}

describe('an answer counts as given: no window, no denial needed', () => {
  it('an answer asked before any denial is recorded, carries no effort (at most high), and approves the launch that follows', async () => {
    const { d, post, approvals } = setup();
    const told = await post(MODEL_Q('opus', 'xhigh'), 'Yes, for this session');

    expect(approvals.states.get('s1')!.approvals).toEqual([{ model: 'opus', scope: 'session', created_at: T0 }]);
    expect(said(told)).toBe('[jev] Recorded: opus, for this session up to high. Relaunch now.');
    expect(await onPreToolUse(call(), d)).toBeNull();
  });

  it.each([[20], [90], [600]])('an answer %i minutes after the denial is recorded', async (minutes) => {
    const { d, post, advance, approvals } = setup();
    await onPreToolUse(call(), d);
    advance(minutes * MIN);
    await post(MODEL_Q('opus'), 'Yes, for this session');

    expect(approvals.states.get('s1')!.approvals).toHaveLength(1);
    expect(await onPreToolUse(call(), d)).toBeNull();
  });

  it('an answer 15 minutes and 36 seconds after the denial, asked before any launch, is recorded (the live failure)', async () => {
    const { d, post, advance } = setup();
    await post(MODEL_Q('opus'), 'Yes, once');
    advance(15 * MIN + 36_000);
    expect(await onPreToolUse(call(), d)).toBeNull();
  });
});

describe("Jev's effort cap stays", () => {
  it('the effort Jev prescribed caps the answer even when the marker names a higher effort', async () => {
    const { d, post, approvals } = setup();
    approvals.deny('s1', 'opus', T0, 'xhigh'); // what Jev prescribed

    const told = await post(MODEL_Q('opus', 'max'), 'Yes, for this session');

    expect(approvals.states.get('s1')!.approvals[0]).toMatchObject({ model: 'opus', effort: 'xhigh' });
    expect(said(told)).toContain('up to xhigh');
    void d;
  });

  it('the prescription never expires: the cap holds 3 hours later', async () => {
    const { post, advance, approvals } = setup();
    approvals.deny('s1', 'opus', T0, 'xhigh');
    advance(180 * MIN);

    await post(MODEL_Q('opus', 'max'), 'Yes, once');

    expect(approvals.states.get('s1')!.approvals[0].effort).toBe('xhigh');
  });

  it('a marker that names no effort carries none, and a question asked before any denial approves no effort', async () => {
    const { post, approvals } = setup();
    approvals.deny('s1', 'opus', T0, 'xhigh');
    await post(MODEL_Q('opus'), 'Yes, for this session');
    expect(approvals.states.get('s1')!.approvals[0]).not.toHaveProperty('effort');

    const fresh = setup();
    await fresh.post(MODEL_Q('opus', 'max'), 'Yes, for this session');
    expect(fresh.approvals.states.get('s1')!.approvals[0]).not.toHaveProperty('effort');
  });

  it('the effort question: held to the highest level Jev prescribed (none: high), model kept as the marker names it', async () => {
    const { post, approvals } = setup();
    await post(EFFORT_Q('max'), 'Yes, for this session');
    expect(approvals.states.get('s1')!.effortApprovals![0].level).toBe('high');

    approvals.denyEffort!('s1', 'xhigh', T0);
    await post(EFFORT_Q('max'), 'Yes, once');
    expect(approvals.states.get('s1')!.effortApprovals!.map((a) => a.level)).toEqual(['high', 'xhigh']);
  });
});

describe('the scopes', () => {
  it('Yes, once has no clock: bound to the turn, used by the first covering launch, gone at the next prompt', async () => {
    const { d, post, advance, approvals } = setup();
    await post(MODEL_Q('opus'), 'Yes, once');
    expect(approvals.states.get('s1')!.approvals[0]).toMatchObject({ scope: 'once', turn: 'p1' });
    advance(4 * 60 * MIN);

    expect(await onPreToolUse(call(), d)).toBeNull(); // 4 hours later, same turn
    expect(out(await onPreToolUse(call(), d)).permissionDecision).toBe('deny'); // used

    await post(MODEL_Q('opus'), 'Yes, once');
    expect(out(await onPreToolUse(call(INPUT, { prompt_id: 'p2' }), d)).permissionDecision).toBe('deny'); // a new prompt
  });

  it('a once is used by exactly one of two parallel launches (one atomic claim)', async () => {
    const { d, post } = setup();
    await post(MODEL_Q('opus'), 'Yes, once');

    const results = await Promise.all([onPreToolUse(call(), d), onPreToolUse(call(), d)]);

    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => out(r).permissionDecision === 'deny')).toHaveLength(1);
  });

  it('the 5 minute scope is gone: the label is not an answer, and an old file with one is read as expired', async () => {
    const { d, post, approvals } = setup();
    const told = await post(MODEL_Q('opus'), 'Yes, for the next 5 minutes');

    expect(approvals.states.get('s1')?.approvals ?? []).toEqual([]);
    expect(said(told)).toContain('[jev] Not recorded: the answer was not one of the four exact labels');
    expect(said(told)).toContain("'Yes, once', 'Yes, for this session', 'No, proceed on <session model>', \"No, don't ask again this session\"");
    expect(normalizeApprovalState({ approvals: [{ model: 'opus', scope: '5min', created_at: T0, expires_at: T0 + 5 * MIN }] }).approvals).toEqual([]);
    expect(out(await onPreToolUse(call(), d)).permissionDecision).toBe('deny');
  });

  it('the questions name exactly four options, in order, and no timed scope (model and effort)', async () => {
    const { d } = setup();
    const model = String(out(await onPreToolUse(call(), d)).permissionDecisionReason);
    const effort = String(out(await onPreToolUse(call({ description: 'd', effort: 'max' }), d)).permissionDecisionReason);

    expect(model).toContain("with these labels: 'Yes, once', 'Yes, for this session', 'No, proceed on sonnet', \"No, don't ask again this session\"");
    expect(effort).toContain("with these labels: 'Yes, once', 'Yes, for this session', 'No, run at high', \"No, don't ask again this session\"");
    expect(model + effort).not.toContain('5 minutes');
  });
});

describe('a No', () => {
  it("'No, proceed on sonnet' clamps only the next launch of that model in the turn, without another deny", async () => {
    const { d, post, logs, approvals } = setup();
    await onPreToolUse(call(), d);
    const told = await post(MODEL_Q('opus'), 'No, proceed on sonnet');

    const first = out(await onPreToolUse(call(), d));
    const second = out(await onPreToolUse(call(), d));

    expect(said(told)).toBe('[jev] Recorded: No for opus for this delegation (this turn); the next launch runs on sonnet.');
    expect(approvals.states.get('s1')!.approvals).toEqual([]);
    expect([first.permissionDecision, first.updatedInput.model]).toEqual(['allow', 'sonnet']);
    expect(second.permissionDecision).toBe('deny'); // that No was spent
    expect(logs.filter((l) => l.event === 'agent_call').map((l) => l.elevation)).toEqual(['denied', 'declined-once', 'denied']);
  });

  it("'No, proceed on sonnet' is dropped at the next prompt", async () => {
    const { d, post } = setup();
    await post(MODEL_Q('opus'), 'No, proceed on sonnet');

    expect(out(await onPreToolUse(call(INPUT, { prompt_id: 'p2' }), d)).permissionDecision).toBe('deny');
  });

  it("\"No, don't ask again this session\" clamps every later launch of that model (or stronger) silently, whatever the prompt", async () => {
    const { d, post, logs } = setup();
    const told = await post(MODEL_Q('opus'), "No, don't ask again this session");

    for (const prompt of ['p1', 'p2', 'p3']) {
      const o = out(await onPreToolUse(call(INPUT, { prompt_id: prompt }), d));
      expect([o.permissionDecision, o.updatedInput.model]).toEqual(['allow', 'sonnet']);
      expect(o.permissionDecisionReason).toContain('declined opus for this session');
    }
    const fable = out(await onPreToolUse(call({ ...INPUT, model: 'fable' }), d));

    expect(said(told)).toBe('[jev] Recorded: No for opus for this session; launches run on sonnet.');
    expect(fable.updatedInput.model).toBe('sonnet'); // a stronger model is covered
    expect(logs.filter((l) => l.event === 'agent_call').map((l) => l.elevation)).toEqual(['declined-session', 'declined-session', 'declined-session', 'declined-session']);
    expect(logs.filter((l) => l.event === 'agent_call')[0]).toMatchObject({ decision: 'allow', clamped_from: 'opus', clamped_to: 'sonnet' });
    expect(logs.every((l) => l.event !== 'agent_call' || l.decision !== 'ask')).toBe(true);
  });

  it('a later Yes for the model replaces its No, and a No replaces its approval', async () => {
    const { d, post, approvals } = setup();
    await post(MODEL_Q('opus'), "No, don't ask again this session");
    await post(MODEL_Q('opus'), 'Yes, for this session');
    expect(approvals.states.get('s1')!.declines ?? []).toEqual([]);
    expect(await onPreToolUse(call(), d)).toBeNull();

    await post(MODEL_Q('opus'), "No, don't ask again this session");
    expect(approvals.states.get('s1')!.approvals).toEqual([]);
    expect(out(await onPreToolUse(call(), d)).updatedInput.model).toBe('sonnet');
  });

  it('the effort question: No, run at high lowers the next launch; the session No lowers every launch at that level to high', async () => {
    const { d, post, logs } = setup();
    await post(EFFORT_Q('max'), 'No, run at high');
    const once = out(await onPreToolUse(call({ description: 'd', effort: 'max' }), d));
    expect([once.permissionDecision, once.updatedInput.effort]).toEqual(['allow', 'high']);
    expect(out(await onPreToolUse(call({ description: 'd', effort: 'max' }), d)).permissionDecision).toBe('deny');

    await post(EFFORT_Q('max'), "No, don't ask again this session");
    for (const prompt of ['p1', 'p2']) {
      const o = out(await onPreToolUse(call({ description: 'd', effort: 'max' }, { prompt_id: prompt }), d));
      expect([o.permissionDecision, o.updatedInput.effort]).toEqual(['allow', 'high']);
    }
    expect(logs.filter((l) => l.event === 'agent_call').map((l) => l.elevation)).toEqual(['declined-once', 'denied', 'declined-session', 'declined-session']);
  });

  it('a Workflow whose script holds a declined model is denied without the question', async () => {
    const { d, post } = setup();
    await post(MODEL_Q('opus'), "No, don't ask again this session");

    const o = out(await onPreToolUse({ session_id: 's1', prompt_id: 'p1', tool_name: 'Workflow', tool_input: { script: "await agent('p', { model: 'opus' })" } as any }, d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('declined opus for this session');
    expect(o.permissionDecisionReason).not.toContain('Ask the user');
  });
});

describe('the line the assistant gets', () => {
  it.each([
    ['Yes, once', '[jev] Recorded: opus, once (this turn) up to high. Relaunch now.'],
    ['Yes, for this session', '[jev] Recorded: opus, for this session up to high. Relaunch now.'],
    ['No, proceed on sonnet', '[jev] Recorded: No for opus for this delegation (this turn); the next launch runs on sonnet.'],
    ["No, don't ask again this session", '[jev] Recorded: No for opus for this session; launches run on sonnet.']
  ])('%s', async (label, line) => {
    const { post } = setup();

    expect(said(await post(MODEL_Q('opus'), label))).toBe(line);
  });

  it('is one line of additionalContext on PostToolUse, for every marker answer', async () => {
    const { post } = setup();
    const o = await post(MODEL_Q('opus'), 'Yes, once');

    expect(o).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[jev] Recorded: opus, once (this turn) up to high. Relaunch now.' } });
    expect(said(o)).not.toContain('\n');
  });

  it('not recorded, label: it says so and lists the four labels', async () => {
    const told = said(await setup().post(MODEL_Q('opus'), 'sure, go ahead'));

    expect(told).toMatch(/^\[jev\] Not recorded: the answer was not one of the four exact labels\./);
    expect(told).toContain("'Yes, once'");
  });

  it('not recorded, marker: a marker that is malformed or names an unknown model', async () => {
    for (const q of ['[jev-elevate:gpt] Run it?', '[jev-elevate-effort:ludicrous] Run it?']) {
      const { post, approvals, logs } = setup();
      const told = said(await post(q, 'Yes, once'));

      expect(told).toContain('[jev] Not recorded: the question\'s marker is malformed or names an unknown model');
      expect(approvals.states.get('s1')?.approvals ?? []).toEqual([]);
      expect(logs.find((l) => l.event === 'elevation_answer')).toMatchObject({ recorded: false, reason: 'marker', model: null });
    }
  });

  it('not recorded, write: the store failed', async () => {
    const { d } = setup();
    const broken = { ...d, approvals: { ...memoryApprovals(), record: () => { throw new Error('lock timeout'); } } };

    const told = said(await onPostToolUse(answered(MODEL_Q('opus'), 'Yes, once'), broken));

    expect(told).toContain('[jev] Not recorded: the state file could not be written.');
  });

  it('not recorded, mode: on-demand records nothing and says Jev is not on', async () => {
    const { post, mode, approvals, logs } = setup();
    mode.value = 'on-demand';

    const told = said(await post(MODEL_Q('opus'), 'Yes, once'));

    expect(told).toContain('[jev] Not recorded: Jev is not on');
    expect(approvals.states.size).toBe(0);
    expect(logs.find((l) => l.event === 'elevation_answer')).toMatchObject({ recorded: false, reason: 'mode', answer: 'yes', scope: 'once', mode: 'on-demand' });
  });

  it('off: no line, no row, nothing written', async () => {
    const { post, mode, logs, approvals } = setup();
    mode.value = 'off';

    expect(await post(MODEL_Q('opus'), 'Yes, once')).toBeNull();
    expect(logs).toEqual([]);
    expect(approvals.states.size).toBe(0);
  });
});

describe('the elevation_answer row', () => {
  it('one row per marker answer, in the decisions log, with the join keys, and the telemetry row carries the same fields', async () => {
    const { post, logs, d } = setup();
    d.saveTurn!('s1', { turn: 'turn-abc', promptId: 'p1', mode: 'on', intent: { models: [], cost: false } as any, at: '2026-11-23T10:00:00.000Z' });

    await post(MODEL_Q('opus', 'xhigh'), 'Yes, for this session', { tool_use_id: 'toolu_ask1' });

    const row = logs.find((l) => l.event === 'elevation_answer')!;
    expect(row).toMatchObject({
      hook: 'PostToolUse',
      event: 'elevation_answer',
      kind: 'model',
      model: 'opus',
      effort: null,
      answer: 'yes',
      scope: 'session',
      recorded: true,
      turn: 'turn-abc',
      toolUseId: 'toolu_ask1',
      mode: 'on',
      session_id: 's1'
    });
    expect(row).not.toHaveProperty('reason');
    expect(telemetryEvent(row)).toMatchObject({ harness: 'claude', toolOrHook: 'PostToolUse', event: 'elevation_answer', kind: 'model', model: 'opus', answer: 'yes', scope: 'session', recorded: true, turn: 'turn-abc', toolUseId: 'toolu_ask1', mode: 'on' });
  });

  it('records the cap stored: the effort Jev prescribed, and effort-kind rows carry the level', async () => {
    const { post, logs, approvals } = setup();
    approvals.deny('s1', 'opus', T0, 'xhigh');
    await post(MODEL_Q('opus', 'max'), 'Yes, once');
    await post(EFFORT_Q('xhigh'), 'No, run at high');

    const rows = logs.filter((l) => l.event === 'elevation_answer');
    expect(rows[0]).toMatchObject({ kind: 'model', effort: 'xhigh', answer: 'yes', scope: 'once' });
    expect(rows[1]).toMatchObject({ kind: 'effort', model: null, answer: 'no', scope: 'once', recorded: true });
  });

  it('a label that is not one of the four: recorded false, reason label', async () => {
    const { post, logs } = setup();
    await post(MODEL_Q('opus'), 'Yes, for the next 5 minutes');

    expect(logs.find((l) => l.event === 'elevation_answer')).toMatchObject({ recorded: false, reason: 'label', answer: null, scope: null, model: 'opus' });
  });
});

describe('what a deny says is stored', () => {
  const reasonOf = async (d: HookDeps, input = call()) => String(out(await onPreToolUse(input, d)).permissionDecisionReason);

  it('none: no approval for the model in this session', async () => {
    const { d, logs } = setup();

    expect(await reasonOf(d)).toContain('Stored: no approval for opus in this session.');
    expect(logs.find((l) => l.event === 'agent_call')).toMatchObject({ stored: 'none' });
  });

  it('once-used: the once approval was used by an earlier launch in this turn', async () => {
    const { d, post, logs } = setup();
    await post(MODEL_Q('opus'), 'Yes, once');
    await onPreToolUse(call(), d);

    expect(await reasonOf(d)).toContain('Stored: the once approval was used by an earlier launch in this turn.');
    expect(logs.filter((l) => l.event === 'agent_call').pop()).toMatchObject({ stored: 'once-used' });
  });

  it('once-stale: a once approval from an earlier turn was dropped', async () => {
    const { d, post, logs } = setup();
    await post(MODEL_Q('opus'), 'Yes, once');

    expect(await reasonOf(d, call(INPUT, { prompt_id: 'p2' }))).toContain('Stored: a once approval from an earlier turn was dropped.');
    expect(logs.find((l) => l.event === 'agent_call')).toMatchObject({ stored: 'once-stale' });
  });

  it('effort-below: the session approval covers the model up to high; this call asks xhigh', async () => {
    const { d, post, logs } = setup({ costGateMode: () => 'enforce', readSessionModel: () => 'claude-sonnet-5-5' });
    await post(MODEL_Q('opus'), 'Yes, for this session'); // no effort: at most high

    const reason = await reasonOf(d, { ...call({ ...INPUT, effort: 'xhigh' }), effort: 'high' } as HookInput); // the session runs at high

    expect(reason).toContain('Stored: the session approval covers opus up to high; this call asks xhigh.');
    expect(logs.find((l) => l.event === 'agent_call')).toMatchObject({ stored: 'effort-below' });
  });

  it('the effort deny says it too, and the telemetry row carries the field', async () => {
    const { d, post, logs } = setup();
    await post(EFFORT_Q('xhigh'), 'Yes, for this session'); // held to high (nothing prescribed)

    const reason = await reasonOf(d, call({ description: 'd', effort: 'xhigh' }));

    expect(reason).toContain('Stored: the session approval covers effort up to high; this call asks xhigh.');
    const row = logs.find((l) => l.event === 'agent_call')!;
    expect(row.stored).toBe('effort-below');
    expect(telemetryEvent(row)).toMatchObject({ stored: 'effort-below' });
  });
});

describe('a mode change voids everything', () => {
  it('approvals, declines and prescriptions from before the stamp count for nothing', async () => {
    const { d, post, config, advance, approvals } = setup();
    await post(MODEL_Q('opus'), 'Yes, for this session');
    await post(MODEL_Q('fable'), "No, don't ask again this session");
    approvals.deny('s1', 'opus', T0, 'xhigh');
    expect(await onPreToolUse(call(), d)).toBeNull();

    config.value = { defaults: { modeChangedAt: new Date(T0 + 500).toISOString() } };
    advance(MIN);

    expect(out(await onPreToolUse(call(), d)).permissionDecision).toBe('deny'); // the approval is void
    // The prescription is void too: a Yes now carries no effort even though the marker names one and 'xhigh' was on record.
    await post(MODEL_Q('opus', 'max'), 'Yes, for this session');
    expect(approvals.states.get('s1')!.approvals.at(-1)).not.toHaveProperty('effort');
  });
});

describe('the live hook process', () => {
  const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
  let home = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-elev-2321-'));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = (event: string, input: object) =>
    Bun.spawnSync(['bun', HOOK, event], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, 'config.json'), JEV_OPENROUTER_API_KEY: '', JEV_DOWNGRADE: 'off', JEV_ELEVATION: '' }
    });
  const agent = (prompt = 'p1') => ({ session_id: 'sx', prompt_id: prompt, tool_name: 'Agent', tool_input: INPUT });
  const decisionRows = () =>
    fs.readFileSync(path.join(home, '.config', 'jev', 'claude_decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('answer before any launch, a line on stdout, an elevation_answer row, then one allow and a deny that says the once was used', () => {
    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5' });

    const told = run('post-tool-use', answered(MODEL_Q('opus', 'xhigh'), 'Yes, once', { session_id: 'sx', tool_use_id: 'toolu_p1' }));
    const first = run('pre-tool-use', agent());
    const second = JSON.parse(run('pre-tool-use', agent()).stdout.toString()).hookSpecificOutput;

    expect(JSON.parse(told.stdout.toString()).hookSpecificOutput).toEqual({
      hookEventName: 'PostToolUse',
      additionalContext: '[jev] Recorded: opus, once (this turn) up to high. Relaunch now.'
    });
    expect(first.stdout.toString()).toBe('');
    expect(second.permissionDecision).toBe('deny');
    expect(second.permissionDecisionReason).toContain('Stored: the once approval was used by an earlier launch in this turn.');
    expect(decisionRows().find((r) => r.event === 'elevation_answer')).toMatchObject({ kind: 'model', model: 'opus', recorded: true, scope: 'once', toolUseId: 'toolu_p1', mode: 'on' });
  });

  it('two parallel processes, one once: exactly one runs; a new prompt drops what is left', async () => {
    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5' });
    run('post-tool-use', answered(MODEL_Q('opus'), 'Yes, once', { session_id: 'sx' }));
    const procs = [0, 1].map(() => Bun.spawn(['bun', HOOK, 'pre-tool-use'], { stdin: new TextEncoder().encode(JSON.stringify(agent())), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, 'config.json'), JEV_OPENROUTER_API_KEY: '', JEV_DOWNGRADE: 'off', JEV_ELEVATION: '' } }));
    const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text() })));

    expect(results.map((r) => r.code)).toEqual([0, 0]);
    expect(results.filter((r) => r.out === '')).toHaveLength(1);
    expect(results.filter((r) => r.out.includes('"deny"'))).toHaveLength(1);
  });

  it('on-demand writes the row (recorded false, reason mode) and says Jev is not on; off writes nothing', () => {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode: 'on-demand' } }));
    const told = run('post-tool-use', answered(MODEL_Q('opus'), 'Yes, once', { session_id: 'sx' }));

    expect(JSON.parse(told.stdout.toString()).hookSpecificOutput.additionalContext).toContain('[jev] Not recorded: Jev is not on');
    expect(decisionRows().find((r) => r.event === 'elevation_answer')).toMatchObject({ recorded: false, reason: 'mode', mode: 'on-demand' });
    expect(fs.existsSync(path.join(home, '.config', 'jev', 'claude-sessions', 'sx.approvals.json'))).toBe(false);

    const before = fs.readFileSync(path.join(home, '.config', 'jev', 'claude_decisions.jsonl'), 'utf8');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode: 'off' } }));
    const offTold = run('post-tool-use', answered(MODEL_Q('opus'), 'Yes, once', { session_id: 'sx' }));

    expect(offTold.stdout.toString()).toBe('');
    expect(fs.readFileSync(path.join(home, '.config', 'jev', 'claude_decisions.jsonl'), 'utf8')).toBe(before);
  });
});
