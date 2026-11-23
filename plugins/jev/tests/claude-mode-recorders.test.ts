/**
 * Claude Code hooks and the mode (src/core/mode-policy.ts):
 * - the answer recorders (approvals, downgrade answers) are decisions: on-demand and off record nothing, so an answer
 *   given there cannot approve a stale denial from an earlier mode `on`;
 * - off writes nothing at all, whichever hook entry point runs (checked on the real hook process under a temporary HOME);
 * - on-demand keeps the one write telemetry needs, the session model record;
 * - a dialog-mode `ask` while the permission mode approves without a dialog logs `auto_approve_warning`, and never
 *   changes the decision; the choice and clamp flows never ask in any permission mode.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPostToolUse, onPreToolUse, type DowngradeStore, type HookDeps, type HookInput } from '../claude/hook.ts';
import { isAutoApprovePermissionMode, type Dispatch } from '../claude/logic.ts';
import { answerDowngrade, claimDowngrade } from '../claude/downgrade.ts';
import { voidStalePending } from '../src/core/downgrade-state.ts';
import { memoryApprovals } from './elevation-helpers.ts';

const SAMPLE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'posttooluse-askuserquestion.json'), 'utf8'));
const flashRec: Dispatch = { subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };

/** The recorded PostToolUse payload with the question and the chosen label replaced. */
function answered(question: string, label: string, extra: Record<string, unknown> = {}): Record<string, any> {
  const s = { ...structuredClone(SAMPLE), prompt_id: 'p1' }; // the prompt the question was asked in (the calls' prompt_id)
  for (const part of [s.tool_input, s.tool_response]) {
    part.questions[0].question = question;
    part.answers = { [question]: label };
  }
  return { ...s, ...extra };
}
const MARKED = (model: string) => `[jev-elevate:${model}] Run the code-engineer delegation on ${model} (session sonnet): refactor the parser module?`;
const DOWNGRADE_Q = '[jev-downgrade:haiku] Run the delegation on haiku instead of sonnet?';

const INPUT = { description: 'WS1: refactor the parser', prompt: 'Refactor it.', subagent_type: 'code-engineer', model: 'opus' };
const call = (extra: Partial<HookInput> = {}): HookInput => ({ session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', tool_input: INPUT, ...extra });
const out = (o: Awaited<ReturnType<typeof onPreToolUse>>) => (o?.hookSpecificOutput ?? {}) as Record<string, any>;

type Log = Record<string, unknown>;

function setup(mode: { value: string }, overrides: Partial<HookDeps> = {}) {
  const logs: Log[] = [];
  const approvals = memoryApprovals();
  const answers: unknown[][] = [];
  const downgrades: DowngradeStore = {
    peek: () => ({ off: false, answered: false, asked: false, rating: null }),
    remember: () => {},
    claim: () => ({ kind: 'none' }) as any,
    answer: (...a) => void answers.push(a)
  };
  const d: HookDeps = {
    readMode: async () => mode.value as 'on',
    readSessionModel: () => 'claude-sonnet-5',
    readQuotaStrategy: async () => 'unknown',
    dispatch: async () => flashRec,
    log: (e) => logs.push(e as Log),
    approvals,
    downgrades,
    now: () => 1_800_000_000_000,
    env: {},
    ...overrides
  };
  return { d, logs, approvals, answers };
}

describe('the answer recorders respect the mode (unit)', () => {
  it('a stale mode-on denial, then on-demand and an answer "Yes, for this session": no approval; back in on, opus is denied', async () => {
    const mode = { value: 'on' };
    const { d, approvals } = setup(mode);

    expect(out(await onPreToolUse(call(), d)).permissionDecision).toBe('deny'); // the denial is on record

    mode.value = 'on-demand';
    await onPostToolUse({ ...answered(MARKED('opus'), 'Yes, for this session'), session_id: 's1' } as HookInput, d);
    expect(approvals.states.get('s1')?.approvals ?? []).toEqual([]);

    mode.value = 'on';
    expect(out(await onPreToolUse(call(), d)).permissionDecision).toBe('deny');
  });

  it.each(['on-demand', 'off'])('mode %s records no approval, no elevation decline and no downgrade answer', async (m) => {
    const mode = { value: 'on' };
    const { d, approvals, answers } = setup(mode);
    await onPreToolUse(call(), d); // a denial that would let an answer through in mode on
    mode.value = m;

    await onPostToolUse({ ...answered(MARKED('opus'), 'Yes, once'), session_id: 's1' } as HookInput, d);
    await onPostToolUse({ ...answered(MARKED('opus'), 'No, proceed on sonnet'), session_id: 's1' } as HookInput, d);
    await onPostToolUse({ ...answered(DOWNGRADE_Q, 'Yes, haiku'), session_id: 's1' } as HookInput, d);

    expect(approvals.states.get('s1')?.approvals ?? []).toEqual([]);
    expect(answers).toEqual([]);
  });

  it('control: in mode on the same answers are recorded', async () => {
    const mode = { value: 'on' };
    const { d, approvals, answers } = setup(mode);
    await onPreToolUse(call(), d);

    await onPostToolUse({ ...answered(MARKED('opus'), 'Yes, once'), session_id: 's1' } as HookInput, d);
    await onPostToolUse({ ...answered(DOWNGRADE_Q, 'Yes, haiku'), session_id: 's1' } as HookInput, d);

    expect(approvals.states.get('s1')?.approvals).toHaveLength(1);
    expect(answers).toHaveLength(1);
  });

  it('a mode that cannot be read records nothing', async () => {
    const mode = { value: 'on' };
    const { d, approvals } = setup(mode);
    await onPreToolUse(call(), d);

    await onPostToolUse({ ...answered(MARKED('opus'), 'Yes, once'), session_id: 's1' } as HookInput, {
      ...d,
      readMode: async () => {
        throw new Error('unreadable');
      }
    });

    expect(approvals.states.get('s1')?.approvals ?? []).toEqual([]);
  });
});

describe('permission mode and the dialog-mode ask', () => {
  it.each([
    ['bypassPermissions', true],
    ['auto', true],
    ['default', false],
    ['plan', false],
    ['acceptEdits', false],
    ['dontAsk', false],
    [undefined, false],
    ['something-new', false]
  ])('permission_mode %j: auto-approve is %j', (value, expected) => {
    expect(isAutoApprovePermissionMode(value)).toBe(expected);
  });

  it.each(['bypassPermissions', 'auto'])('dialog mode under %s still asks, and the row carries auto_approve_warning', async (permission_mode) => {
    const { d, logs } = setup({ value: 'on' }, { env: { JEV_ELEVATION: 'dialog' } });

    const o = out(await onPreToolUse(call({ permission_mode }), d));

    expect(o.permissionDecision).toBe('ask');
    expect(logs[0]).toMatchObject({ elevation: 'asked', auto_approve_warning: true });
  });

  it.each([['default'], ['plan'], ['acceptEdits'], ['dontAsk'], [undefined]])('dialog mode under %j asks without the warning', async (permission_mode) => {
    const { d, logs } = setup({ value: 'on' }, { env: { JEV_ELEVATION: 'dialog' } });

    const o = out(await onPreToolUse(call({ permission_mode }), d));

    expect(o.permissionDecision).toBe('ask');
    expect(logs[0]).not.toHaveProperty('auto_approve_warning');
  });

  it.each(['bypassPermissions', 'auto', 'default', 'plan', 'acceptEdits', 'dontAsk'])('choice and clamp never ask under %s, and carry no warning', async (permission_mode) => {
    const choice = setup({ value: 'on' });
    const clamp = setup({ value: 'on' }, { env: { JEV_ELEVATION: 'clamp' } });

    for (let i = 0; i < 4; i++) {
      expect(out(await onPreToolUse(call({ permission_mode }), choice.d)).permissionDecision).toBe('deny');
      expect(out(await onPreToolUse(call({ permission_mode }), clamp.d)).permissionDecision).toBe('allow');
    }
    expect([...choice.logs, ...clamp.logs].some((l) => 'auto_approve_warning' in l)).toBe(false);
  });
});

describe('the real hook process by mode', () => {
  const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
  let home = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-modes-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    setMode('on');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const configFile = (): string => path.join(home, '.config', 'jev', 'config.json');
  const setMode = (mode: string): void => fs.writeFileSync(configFile(), JSON.stringify({ defaults: { mode } }));
  const run = (event: string, input: object) =>
    Bun.spawnSync(['bun', HOOK, event], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: configFile(), JEV_OPENROUTER_API_KEY: '', OPENROUTER_API_KEY: '', JEV_DOWNGRADE: 'off', JEV_ELEVATION: '' }
    });
  const sessions = (): string => path.join(home, '.config', 'jev', 'claude-sessions');
  const approvalsOf = (session: string): unknown[] => {
    const file = path.join(sessions(), `${session}.approvals.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).approvals : [];
  };
  const agent = (session = 'sx') => ({ session_id: session, prompt_id: 'p1', tool_name: 'Agent', tool_input: INPUT });
  const decision = (p: ReturnType<typeof run>): string | null => (p.stdout.toString() ? JSON.parse(p.stdout.toString()).hookSpecificOutput.permissionDecision : null);

  /**
   * Every file under `dir` with a hash of its content: a file written, changed or removed shows. Bun's own transpiler cache
   * (`.bun`, written by the runtime whatever the hook does) is not Jev's and is left out.
   */
  function snapshot(dir: string): Array<[string, string]> {
    const rows: Array<[string, string]> = [];
    const walk = (d: string): void => {
      for (const name of fs.readdirSync(d).sort()) {
        if (d === dir && name === '.bun') continue;
        const p = path.join(d, name);
        if (fs.statSync(p).isDirectory()) {
          rows.push([path.relative(dir, p), 'dir']);
          walk(p);
        } else rows.push([path.relative(dir, p), createHash('sha256').update(fs.readFileSync(p)).digest('hex')]);
      }
    };
    walk(dir);
    return rows;
  }

  it('a stale mode-on denial, then on-demand and an answer: no approval is recorded; back in on, opus is denied', () => {
    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5' });
    expect(decision(run('pre-tool-use', agent()))).toBe('deny');

    setMode('on-demand');
    const post = run('post-tool-use', { ...answered(MARKED('opus'), 'Yes, for this session'), session_id: 'sx' });
    expect(post.exitCode).toBe(0);
    expect(JSON.parse(post.stdout.toString()).hookSpecificOutput.additionalContext).toContain('[jev] Not recorded: Jev is not on');
    expect(approvalsOf('sx')).toEqual([]);
    expect(run('pre-tool-use', agent()).stdout.toString()).toBe(''); // on-demand decides nothing

    setMode('on');
    expect(decision(run('pre-tool-use', agent()))).toBe('deny');
    expect(approvalsOf('sx')).toEqual([]);
  });

  it('an approval recorded before a mode change (stamped) is void: opus is denied again; an answer given after the change counts', () => {
    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5' });
    expect(decision(run('pre-tool-use', agent()))).toBe('deny');
    run('post-tool-use', { ...answered(MARKED('opus'), 'Yes, for this session'), session_id: 'sx' });
    expect(approvalsOf('sx')).toHaveLength(1);
    expect(run('pre-tool-use', agent()).stdout.toString()).toBe(''); // approved

    Bun.sleepSync(25);
    fs.writeFileSync(configFile(), JSON.stringify({ defaults: { mode: 'on', modeChangedAt: new Date().toISOString() } }));
    Bun.sleepSync(25);

    expect(decision(run('pre-tool-use', agent()))).toBe('deny'); // the mode changed: what was approved before it counts for nothing
    run('post-tool-use', { ...answered(MARKED('opus'), 'Yes, for this session'), session_id: 'sx' });
    expect(run('pre-tool-use', agent()).stdout.toString()).toBe(''); // the answer given after the change is the user's click and counts
  });

  it('control: with no mode change the late answer approves as before', () => {
    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5' });
    expect(decision(run('pre-tool-use', agent()))).toBe('deny');

    run('post-tool-use', { ...answered(MARKED('opus'), 'Yes, for this session'), session_id: 'sx' });

    expect(approvalsOf('sx')).toHaveLength(1);
  });

  it('on-demand keeps the session model record (telemetry needs it) and records no approval', () => {
    setMode('on-demand');

    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5' });
    run('post-model-switch', { session_id: 'sx', to_model: 'claude-opus-5-5' });

    const record = JSON.parse(fs.readFileSync(path.join(sessions(), 'sx.json'), 'utf8'));
    expect(record.model).toBe('claude-opus-5-5');
    expect(fs.readdirSync(sessions()).filter((n) => n.includes('approvals'))).toEqual([]);
  });

  it('off: no hook entry point writes, changes or removes anything under the HOME', () => {
    // State left by an earlier mode `on`: a session record, a denial with an approval, and a pinned workflow.
    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5' });
    run('pre-tool-use', agent());
    const wfScript = path.join(home, 'w.js');
    fs.writeFileSync(wfScript, "await agent('p')");
    run('pre-tool-use', { session_id: 'sx', prompt_id: 'p1', tool_name: 'Workflow', tool_use_id: 'toolu_01', cwd: home, tool_input: { scriptPath: wfScript } });
    expect(fs.readdirSync(path.join(home, '.config', 'jev', 'workflow-pins'))).toHaveLength(1);
    setMode('off');
    const before = snapshot(home);

    const results = [
      run('session-start', { session_id: 'sx', model: 'claude-opus-5-5' }),
      run('session-start', { session_id: 'sx' }), // a resume that names no model
      run('post-model-switch', { session_id: 'sx', to_model: 'claude-haiku-4' }),
      run('user-prompt-submit', { session_id: 'sx', prompt_id: 'p2', prompt: 'please refactor the billing module and run the tests' }),
      run('pre-tool-use', agent()),
      run('pre-tool-use', { session_id: 'sx', prompt_id: 'p2', tool_name: 'Workflow', tool_use_id: 'toolu_02', cwd: home, tool_input: { scriptPath: wfScript } }),
      run('post-tool-use', { ...answered(MARKED('opus'), 'Yes, for this session'), session_id: 'sx' }),
      run('post-tool-use', { ...answered(DOWNGRADE_Q, 'Yes, haiku'), session_id: 'sx' }),
      run('post-tool-use', { ...answered(MARKED('opus'), 'No, proceed on sonnet'), session_id: 'sx' }),
      run('post-tool-use', { hook_event_name: 'PostToolUse', tool_name: 'Workflow', session_id: 'sx', tool_use_id: 'toolu_01', tool_input: { scriptPath: wfScript }, tool_response: {} })
    ];

    expect(results.map((p) => [p.exitCode, p.stdout.toString()])).toEqual(results.map(() => [0, '']));
    expect(snapshot(home)).toEqual(before);
  });

  it('off on a bare HOME: no entry point creates a directory or a file', () => {
    fs.rmSync(path.join(home, '.config'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    setMode('off');
    const before = snapshot(home);

    for (const event of ['session-start', 'post-model-switch', 'user-prompt-submit', 'pre-tool-use', 'post-tool-use']) {
      run(event, { session_id: 'sx', model: 'claude-sonnet-5', to_model: 'claude-sonnet-5', prompt: 'please refactor the billing module', tool_name: 'Agent', tool_input: INPUT });
    }

    expect(snapshot(home)).toEqual(before);
  });
});

describe('a mode change voids a pending denial (Claude Code, unit)', () => {
  const T0 = 1_800_000_000_000;
  const stampAt = (ms: number) => ({ defaults: { modeChangedAt: new Date(ms).toISOString() } });

  function clocked(config: { value: Record<string, unknown> }) {
    const clock = { t: T0 };
    const s = setup({ value: 'on' }, { now: () => clock.t, readConfig: () => config.value as any });
    return { ...s, clock };
  }

  it('approve in on, a mode change stamped after it: the approval, a decline and the prescription all count for nothing; denied again with a fresh question', async () => {
    const config = { value: {} as Record<string, unknown> };
    const { d, approvals, clock } = clocked(config);
    expect(out(await onPreToolUse(call(), d)).permissionDecision).toBe('deny'); // the denial is on record at T0
    await onPostToolUse({ ...answered(MARKED('opus'), 'Yes, for this session'), session_id: 's1' } as HookInput, d);
    expect(await onPreToolUse(call(), d)).toBeNull();
    await onPostToolUse({ ...answered(MARKED('sonnet'), "No, don't ask again this session"), session_id: 's1' } as HookInput, d);

    config.value = stampAt(T0 + 500); // on -> on-demand -> on
    clock.t = T0 + 2000;

    expect(out(await onPreToolUse(call(), d)).permissionDecision).toBe('deny'); // asked again, as for a first attempt
    expect(approvals.states.get('s1')?.denied?.opus).toBe(T0 + 2000);
  });

  it('an answer given after the change is the user\'s click and counts; the voided prescription caps its effort at none (at most high)', async () => {
    const config = { value: stampAt(T0 + 500) as Record<string, unknown> };
    const { d, approvals, clock } = clocked(config);
    approvals.deny('s1', 'opus', T0, 'xhigh'); // prescribed before the mode change: void

    clock.t = T0 + 1000;
    await onPostToolUse({ ...answered(MARKED('opus') .replace('[jev-elevate:opus]', '[jev-elevate:opus:xhigh]'), 'Yes, for this session'), session_id: 's1' } as HookInput, d);

    expect(approvals.states.get('s1')?.approvals).toEqual([{ model: 'opus', scope: 'session', created_at: T0 + 1000 }]);
  });

  it('control: no mode change since the denial, the answer still approves exactly as before', async () => {
    const config = { value: stampAt(T0 - 500) }; // the last change is older than the denial
    const { d, approvals, clock } = clocked(config);
    await onPreToolUse(call(), d);

    clock.t = T0 + 1000;
    await onPostToolUse({ ...answered(MARKED('opus'), 'Yes, for this session'), session_id: 's1' } as HookInput, d);

    expect(approvals.states.get('s1')?.approvals).toHaveLength(1);
  });

  it('control: a config with no stamp puts no restriction on the answer', async () => {
    const config = { value: { defaults: { mode: 'on' } } as Record<string, unknown> };
    const { d, approvals, clock } = clocked(config);
    await onPreToolUse(call(), d);

    clock.t = T0 + 1000;
    await onPostToolUse({ ...answered(MARKED('opus'), 'Yes, once'), session_id: 's1' } as HookInput, d);

    expect(approvals.states.get('s1')?.approvals).toHaveLength(1);
  });

  it('a change made for another harness does not void a Claude Code denial', async () => {
    const config = { value: { harnesses: { antigravity: { modeChangedAt: new Date(T0 + 500).toISOString() } } } as Record<string, unknown> };
    const { d, approvals, clock } = clocked(config);
    await onPreToolUse(call(), d);

    clock.t = T0 + 1000;
    await onPostToolUse({ ...answered(MARKED('opus'), 'Yes, once'), session_id: 's1' } as HookInput, d);

    expect(approvals.states.get('s1')?.approvals).toHaveLength(1);
  });

  it('the downgrade recorder is handed the stale test: a question asked before the change does not count', async () => {
    const config = { value: stampAt(T0 + 500) };
    const { d, answers, clock } = clocked(config);
    clock.t = T0 + 1000;

    await onPostToolUse({ ...answered(DOWNGRADE_Q, 'Yes, haiku'), session_id: 's1' } as HookInput, d);

    expect(answers).toHaveLength(1);
    const stale = answers[0][4] as (askedAt: number) => boolean;
    expect([stale(T0), stale(T0 + 600)]).toEqual([true, false]);
  });

  it('answerDowngrade: an answer to a question asked before the change records nothing; the delegation is asked afresh', () => {
    const asked = claimDowngrade({ entries: [] }, 'sig-a', 'haiku', T0, true).state;
    const before = (t: number) => t < T0 + 500;

    const voided = answerDowngrade(asked, 'haiku', 'Yes, haiku', T0 + 1000, before);
    expect(voided.entries).toEqual([]); // the stale question is gone and nothing was recorded for the answer
    expect(claimDowngrade(voided, 'sig-a', 'haiku', T0 + 1000, true).result).toBe('first');

    // Control: with no stamp the same answer closes the question.
    const closed = answerDowngrade(asked, 'haiku', 'Yes, haiku', T0 + 1000);
    expect(closed.entries.map((e) => e.answered)).toEqual([true]);
  });

  it('voidStalePending drops only the unanswered questions the test rejects', () => {
    const state = {
      entries: [
        { kind: 'downgrade' as const, from: 'haiku', answered: false, signature: 'old', asked_at: T0, expires_at: T0 + 600_000 },
        { kind: 'downgrade' as const, from: 'haiku', answered: false, signature: 'new', asked_at: T0 + 900, expires_at: T0 + 600_000 },
        { kind: 'downgrade' as const, from: 'haiku', answered: true, signature: 'done', asked_at: T0, chosen: 'x', expires_at: T0 + 600_000 }
      ]
    };

    const { state: next, voided } = voidStalePending(state, (t) => t < T0 + 500);

    expect(voided).toBe(1);
    expect(next.entries.map((e) => e.signature)).toEqual(['new', 'done']);
    expect(voidStalePending(next, (t) => t < T0 + 500).voided).toBe(0);
  });
});
