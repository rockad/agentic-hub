/**
 * v2.3.18 small fixes:
 * 1. every harness reads the mode through src/core/mode-policy.ts, so an unknown mode string behaves as off everywhere;
 * 2. the Antigravity sessions directory is created by the first real write, never eagerly;
 * 3. ask_question answer matching picks the answer of the prescribed question (index or marker) and never reads a bare
 *    answer for one question of several, with questions given as strings or as objects;
 * 4. one documented default session model for Antigravity;
 * 5. agent_call rows are written for invoke_subagent only;
 * 6. an elevation decline answered after a mode change is not recorded (Claude Code).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isModeOff, modeBehaviour } from '../src/core/mode-policy.ts';
import { DEFAULT_ANTIGRAVITY_SESSION_MODEL } from '../src/core/session-defaults.ts';
import { modelTierRank, applyLowQuotaClamp } from '../src/core/governance.ts';
import { maybeStartCatalogueRefresh } from '../claude/refresh-trigger.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';
import { runPreflight } from '../antigravity/preflight.ts';
import {
  askQuestionCount,
  extractAskAnswer,
  evaluateAntigravitySubagentCall,
  pollForAskAnswer,
  pullElevationAnswerDetailed
} from '../antigravity/logic.ts';
import { onPostToolUse, onPreToolUse, type HookInput } from '../claude/hook.ts';
import { lastDeniedAtMs } from '../claude/logic.ts';
import { memoryApprovals } from './elevation-helpers.ts';

const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const MARK = '[jev-elevate:pro] Allow subagent expert to run on pro (session ceiling: flash)?';

describe('1. mode through the shared helper', () => {
  it('isModeOff is true for off and for anything unknown, false for on and on-demand', () => {
    for (const m of ['off', 'bogus', '', 'ON', undefined, null]) expect(isModeOff(m as string)).toBe(true);
    for (const m of ['on', 'on-demand']) expect(isModeOff(m)).toBe(false);
    expect(modeBehaviour('bogus')).toEqual(modeBehaviour('off'));
  });

  it('applyLowQuotaClamp: an unknown mode changes nothing, like off (before: it fell into the on-demand warning branch)', () => {
    const view = { active: { pool: 'gemini', strategy: 'conserve', min_remaining: 0.1 } } as any;
    for (const mode of ['off', 'bogus'] as const) {
      expect(applyLowQuotaClamp('pro', view, mode as any, false)).toMatchObject({ tier: 'pro', wasClampedByQuota: false });
      expect(applyLowQuotaClamp('pro', view, mode as any, false).quotaWarning).toBeUndefined();
    }
    expect(applyLowQuotaClamp('pro', view, 'on', false).wasClampedByQuota).toBe(true);
    expect(applyLowQuotaClamp('pro', view, 'on-demand', false).quotaWarning).toBeDefined();
  });

  it('the catalogue refresh trigger runs in mode on only; an unknown mode is off', () => {
    for (const mode of ['off', 'on-demand', 'bogus']) {
      expect(maybeStartCatalogueRefresh({ env: {}, readMode: () => mode as any })).toBe('mode-off');
    }
  });
});

describe('processes under a temporary HOME', () => {
  let home = '';
  const cfgFile = () => path.join(home, '.config', 'jev', 'config.json');
  const setMode = (mode: string) => fs.writeFileSync(cfgFile(), JSON.stringify({ defaults: { mode } }));
  const jevDir = () => path.join(home, '.config', 'jev');
  const sessionsDir = () => path.join(jevDir(), 'antigravity-sessions');
  const decisionsFile = () => path.join(jevDir(), 'antigravity_decisions.jsonl');
  const decisionRows = (): Record<string, any>[] =>
    fs.existsSync(decisionsFile()) ? fs.readFileSync(decisionsFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-2318-'));
    fs.mkdirSync(jevDir(), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' }));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const run = (event: string, input: object) =>
    Bun.spawnSync(['bun', HOOK, event], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: cfgFile(), JEV_DOWNGRADE: 'off' }
    });
  const askPost = (questions: unknown, content: string, extra: Record<string, unknown> = {}) => ({
    conversationId: 'conv-2318',
    modelName: 'gemini-3.8-flash-low',
    content,
    toolCall: { name: 'ask_question', args: { questions } },
    ...extra
  });
  const elevate = () => ({
    conversationId: 'conv-2318',
    lastUserInput: 'Invoke expert on pro',
    modelName: 'gemini-3.8-flash-low',
    toolCall: { id: 'c1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } }
  });

  it('an unknown mode behaves as off in the Antigravity hook: no output, no row, no session file or directory', () => {
    setMode('bogus');
    const pre = run('pre-tool-use', elevate());
    expect(pre.exitCode).toBe(0);
    expect(pre.stdout.toString()).toBe('');
    const post = run('post-tool-use', askPost([{ question: MARK }], 'A1: Yes, once'));
    expect(post.stdout.toString().trim()).toBe('{}');
    expect(fs.existsSync(sessionsDir())).toBe(false);
    expect(fs.existsSync(decisionsFile())).toBe(false);
  });

  it('an unknown mode behaves as off in the Antigravity pre-flight: nothing is written, nothing injected', async () => {
    setMode('bogus');
    const keys = ['HOME', 'JEV_CONFIG_FILE', 'JEV_TELEMETRY_FILE'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.HOME = home;
    process.env.JEV_CONFIG_FILE = cfgFile();
    process.env.JEV_TELEMETRY_FILE = path.join(home, 'telemetry.jsonl');
    clearConfigCacheForTesting();
    let stdout = '';
    const origLog = console.log;
    console.log = (m: string) => {
      stdout += m;
    };
    try {
      await runPreflight(JSON.stringify({ conversationId: 'c', modelName: 'gemini-3.8-flash-low', lastUserInput: 'please refactor the billing module', invocationNum: 1 }), {
        autoHeal: () => {}
      });
    } finally {
      console.log = origLog;
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      clearConfigCacheForTesting();
    }
    expect(JSON.parse(stdout)).toEqual({});
    expect(fs.existsSync(sessionsDir())).toBe(false);
    expect(fs.existsSync(path.join(home, 'telemetry.jsonl'))).toBe(false);
  });

  it('2. mode on-demand: PostToolUse (ask_question, invoke_subagent) creates no sessions directory', () => {
    setMode('on-demand');
    run('post-tool-use', askPost([{ question: MARK }], 'A1: Yes, once'));
    run('post-tool-use', askPost([{ question: 'Deploy now?' }], 'A1: Yes'));
    run('post-tool-use', { conversationId: 'conv-2318', toolCall: { name: 'invoke_subagent', args: { Model: 'flash' } } });
    expect(fs.existsSync(sessionsDir())).toBe(false);
  });

  it('2. mode on: an ask_question that is no elevation answer writes no approvals file; the first real write creates the directory', () => {
    setMode('on');
    run('post-tool-use', askPost([{ question: 'Deploy now?' }], 'A1: Yes'));
    expect(fs.existsSync(path.join(sessionsDir(), 'conv-2318.approvals.json'))).toBe(false);
    expect(JSON.parse(run('pre-tool-use', elevate()).stdout.toString()).decision).toBe('deny');
    expect(fs.existsSync(path.join(sessionsDir(), 'conv-2318.approvals.json'))).toBe(true);
  });

  describe('3. ask_question with three questions, the elevation marker in the middle', () => {
    const ANSWERS = 'A1: Yes, for this session\nA2: Yes, once\nA3: No, proceed on flash';
    const stateScopes = (): string[] => {
      const f = path.join(sessionsDir(), 'conv-2318.approvals.json');
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).approvals.map((a: { scope: string }) => a.scope) : [];
    };

    it.each([
      ['objects', [{ question: 'Deploy now?' }, { question: MARK }, { question: 'Tag it?' }]],
      ['plain strings', ['Deploy now?', MARK, 'Tag it?']]
    ])('records the middle question\'s own answer (%s), not the session scope of question 1', (_label, questions) => {
      setMode('on');
      expect(JSON.parse(run('pre-tool-use', elevate()).stdout.toString()).decision).toBe('deny');
      run('post-tool-use', askPost(questions, ANSWERS));
      expect(stateScopes()).toEqual(['once']);
      expect(decisionRows().find((r) => r.event === 'ask_answer')).toMatchObject({ marker_found: true, outcome: 'recorded' });
    });

    it('a middle answer of "No" approves nothing even when the neighbours say Yes (it is recorded as a decline)', () => {
      setMode('on');
      run('pre-tool-use', elevate());
      run('post-tool-use', askPost(['Deploy now?', MARK, 'Tag it?'], 'A1: Yes, for this session\nA2: No, proceed on flash\nA3: Yes, for this session'));
      expect(stateScopes()).toEqual([]);
      expect(decisionRows().find((r) => r.event === 'ask_answer')?.outcome).toBe('recorded');
      expect(decisionRows().find((r) => r.event === 'elevation_answer')).toMatchObject({ answer: 'no', scope: 'once', recorded: true });
    });

    it('a bare string answer for a three-question ask is nobody\'s answer: nothing is approved', () => {
      setMode('on');
      run('pre-tool-use', elevate());
      run('post-tool-use', askPost(['Deploy now?', MARK, 'Tag it?'], 'Yes, for this session'));
      expect(stateScopes()).toEqual([]);
      expect(decisionRows().find((r) => r.event === 'ask_answer')?.outcome).toBe('no_row');
    });

    it('control: a bare string answer to a lone elevation question still approves', () => {
      setMode('on');
      run('pre-tool-use', elevate());
      run('post-tool-use', askPost([MARK], 'Yes, once'));
      expect(stateScopes()).toEqual(['once']);
    });
  });

  describe('5. agent_call rows are for invoke_subagent only', () => {
    it('a PreToolUse for another tool name, or none, writes no agent_call row', () => {
      setMode('on');
      for (const toolCall of [{ name: 'run_command', args: { CommandLine: 'ls' } }, { name: 'ask_question', args: {} }, undefined]) {
        const p = run('pre-tool-use', { conversationId: 'conv-2318', modelName: 'gemini-3.8-flash-low', toolCall });
        expect(p.exitCode).toBe(0);
        expect(p.stdout.toString()).toBe('');
      }
      expect(decisionRows().filter((r) => r.event === 'agent_call')).toEqual([]);
    });

    it('control: an invoke_subagent call writes its row, named invoke_subagent', () => {
      setMode('on');
      run('pre-tool-use', elevate());
      const rows = decisionRows().filter((r) => r.event === 'agent_call');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tool_name: 'invoke_subagent', decision: 'deny' });
    });
  });
});

describe('3. answer extraction, unit', () => {
  let dir = '';
  const f = () => path.join(dir, 't.jsonl');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-2318-pull-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (questions: unknown, content: string, id?: string) =>
    fs.writeFileSync(
      f(),
      [
        JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'ask_question', ...(id ? { id } : {}), args: { questions } }] }),
        JSON.stringify({ step_index: 6, type: 'GENERIC', ...(id ? { toolCallId: id } : {}), content })
      ].join('\n') + '\n'
  );

  it('askQuestionCount: array length, a lone string is one, anything else unknown', () => {
    expect(askQuestionCount({ questions: [1, 2, 3] })).toBe(3);
    expect(askQuestionCount({ questions: 'one' })).toBe(1);
    expect(askQuestionCount({})).toBeUndefined();
    expect(askQuestionCount(undefined)).toBeUndefined();
  });

  it('a bare answer is read for question 0 of a lone question and for nothing else', () => {
    expect(extractAskAnswer({ content: 'Yes, once' }, 0)).toBe('Yes, once');
    expect(extractAskAnswer({ content: 'Yes, once' }, 0, undefined, 1)).toBe('Yes, once');
    expect(extractAskAnswer({ content: 'Yes, once' }, 0, undefined, 3)).toBeNull();
    expect(extractAskAnswer({ content: 'Yes, once' }, 1)).toBeNull();
    expect(extractAskAnswer({ content: 'Yes, once' }, 2, undefined, 3)).toBeNull();
  });

  it('pollForAskAnswer passes the question count on', async () => {
    expect(await pollForAskAnswer({ content: 'Yes, once' }, 0, { questionCount: 3 })).toBeNull();
    expect(await pollForAskAnswer({ content: 'Yes, once' }, 0, { questionCount: 1 })).toBe('Yes, once');
  });

  it.each([
    ['objects, no tool call id', [{ question: 'a' }, { question: MARK }, { question: 'c' }], undefined],
    ['plain strings, no tool call id', ['a', MARK, 'c'], undefined],
    ['objects, with a tool call id', [{ question: 'a' }, { question: MARK }, { question: 'c' }], 'ask_1'],
    ['plain strings, with a tool call id', ['a', MARK, 'c'], 'ask_1']
  ])('the transcript pull reads line A2 of the middle question (%s)', (_l, questions, id) => {
    write(questions, 'A1: Yes, once\nA2: Yes, for this session\nA3: Yes, once', id);
    expect(pullElevationAnswerDetailed(f(), 'pro')).toMatchObject({ approved: true, scope: 'session', answerKey: id ? 'ask_1#1' : 'step:6#1' });
    write(questions, 'A1: Yes, once\nA2: User Skipped\nA3: Yes, once', id);
    expect(pullElevationAnswerDetailed(f(), 'pro')).toMatchObject({ approved: false });
  });

  it('the transcript pull never reads a bare answer for one of three questions', () => {
    write(['a', MARK, 'c'], 'Yes, once');
    expect(pullElevationAnswerDetailed(f(), 'pro')).toMatchObject({ approved: false });
    write([MARK], 'Yes, once');
    expect(pullElevationAnswerDetailed(f(), 'pro')).toMatchObject({ approved: true, scope: 'once' });
  });
});

describe('4. one default session model', () => {
  it('is the lower of the two ids the code used, and a flash-class model', () => {
    expect(DEFAULT_ANTIGRAVITY_SESSION_MODEL).toBe('gemini-3.8-flash-low');
    expect(modelTierRank(DEFAULT_ANTIGRAVITY_SESSION_MODEL)).toBeLessThan(modelTierRank('gemini-pro'));
  });

  it('an unknown session (no model anywhere) is held to the flash ceiling: pro is asked about', () => {
    const d = evaluateAntigravitySubagentCall({ conversationId: 'c', toolCall: { name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'x', Model: 'pro' } } }, { mode: 'on' });
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('[jev-elevate:pro]');
  });

  it('no source file still spells a session-model default of its own', () => {
    const root = path.join(import.meta.dir, '..');
    for (const rel of ['antigravity/logic.ts', 'antigravity/preflight.ts']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      expect(src).not.toMatch(/\|\|\s*'gemini[-a-z0-9.]*'/);
    }
  });
});

describe('6. Claude Code: an elevation decline after a mode change is not recorded', () => {
  const T0 = 1_800_000_000_000;
  const MARKED = `[jev-elevate:opus] Run the code-engineer delegation on opus (session sonnet): refactor the parser module?`;
  const answered = (label: string): Record<string, any> => ({
    tool_name: 'AskUserQuestion',
    session_id: 's1',
    tool_input: { questions: [{ question: MARKED }] },
    tool_response: { answers: { [MARKED]: label } }
  });
  const INPUT = { description: 'WS1: refactor the parser', prompt: 'Refactor it.', subagent_type: 'code-engineer', model: 'opus' };
  const call = (): HookInput => ({ session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', tool_input: INPUT });

  function setup(config: { value: Record<string, unknown> }) {
    const clock = { t: T0 };
    const approvals = memoryApprovals();
    const answers: unknown[][] = [];
    const d: any = {
      readMode: async () => 'on',
      readSessionModel: () => 'claude-sonnet-5',
      readQuotaStrategy: async () => 'unknown',
      dispatch: async () => ({ subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 }),
      log: () => {},
      approvals,
      downgrades: { peek: () => ({ off: false, answered: false, asked: false, rating: null }), remember: () => {}, claim: () => ({ kind: 'none' }), answer: (...a: unknown[]) => void answers.push(a) },
      now: () => clock.t,
      readConfig: () => config.value,
      env: {}
    };
    return { d, answers, clock, approvals };
  }
  const stampAt = (ms: number) => ({ defaults: { modeChangedAt: new Date(ms).toISOString() } });

  it('lastDeniedAtMs: the latest note for the model or a stronger one, whatever the window; null without one', () => {
    expect(lastDeniedAtMs({ approvals: [], denied: { opus: 5, sonnet: 9 } }, 'sonnet')).toBe(9);
    expect(lastDeniedAtMs({ approvals: [], denied: { sonnet: 9 } }, 'opus')).toBeNull();
    expect(lastDeniedAtMs({ approvals: [] }, 'opus')).toBeNull();
  });

  it('deny at T0, mode change at T0+500, "No, proceed on sonnet" at T0+1000: no downgrade entry', async () => {
    const config = { value: {} as Record<string, unknown> };
    const { d, answers, clock } = setup(config);
    expect(((await onPreToolUse(call(), d))?.hookSpecificOutput as any).permissionDecision).toBe('deny');
    config.value = stampAt(T0 + 500);
    clock.t = T0 + 1000;
    await onPostToolUse(answered('No, proceed on sonnet') as HookInput, d);
    expect(answers).toEqual([]);
  });

  it('a question asked after the mode change (a fresh denial) is declined and recorded as before', async () => {
    const config = { value: stampAt(T0 - 500) as Record<string, unknown> };
    const { d, answers, clock } = setup(config);
    await onPreToolUse(call(), d); // denial at T0, after the change
    clock.t = T0 + 1000;
    await onPostToolUse(answered('No, proceed on sonnet') as HookInput, d);
    expect(answers).toHaveLength(1);
    expect(answers[0].slice(0, 3)).toEqual(['s1', '*', 'elevation declined']);
  });

  it('control: no stamp, or no denial on record, records the decline as before', async () => {
    const noStamp = setup({ value: {} });
    await onPreToolUse(call(), noStamp.d);
    await onPostToolUse(answered('No, proceed on sonnet') as HookInput, noStamp.d);
    expect(noStamp.answers).toHaveLength(1);

    const noDenial = setup({ value: stampAt(T0 + 500) });
    noDenial.clock.t = T0 + 1000;
    await onPostToolUse(answered('No, proceed on sonnet') as HookInput, noDenial.d);
    expect(noDenial.answers).toHaveLength(1);
  });
});
