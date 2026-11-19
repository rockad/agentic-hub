/**
 * A mode change voids a pending denial (Antigravity). Live failure (check T24b): in mode `on` a `pro` subagent is denied
 * and the denial stored; the user switches to on-demand (the answer recorder rightly records nothing), answers the
 * `[jev-elevate:pro]` question "Yes, for this session" and switches back to `on`. The next `pro` call used to be allowed
 * through the pull fallback because the transcript answer is newer than the stored denial. Now the mode writers stamp
 * `modeChangedAt` and a denial older than the stamp is never approved: the call is denied again with a fresh question.
 *
 * Logic level (injected clock and config) plus the real hook process.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateAntigravitySubagentCall, type AntigravityHookInput } from '../antigravity/logic.ts';
import { applyAntigravityDowngrade, type DowngradeDeps } from '../antigravity/downgrade.ts';
import { createAntigravityApprovalStore, createAntigravityDowngradeStore, type ApprovalStore } from '../antigravity/approvals.ts';
import { denialPredatesModeChange, modeChangedAtMs } from '../src/core/mode-change.ts';
import { clearConfigCacheForTesting, writeModeState } from '../src/core/config.ts';
import { HAIKU } from './downgrade-helpers.ts';

const SID = '00000000-0000-4000-8000-0000000000dd';
const NOW = Date.parse('2026-11-18T10:00:10.000Z');
const DENIED_AT = NOW - 5000;
const HEADER = 'Created At: 2026-11-18T10:00:05+02:00\nCompleted At: 2026-11-18T10:00:09+02:00\n';
const stamp = (ms: number) => ({ defaults: { modeChangedAt: new Date(ms).toISOString() } });

const planner = (stepIndex: number, toolCalls: unknown[]) =>
  JSON.stringify({ step_index: stepIndex, type: 'PLANNER_RESPONSE', created_at: '2026-11-18T10:00:01.000Z', source: 'MODEL', status: 'DONE', content: '', tool_calls: toolCalls });
const generic = (stepIndex: number, content: string) =>
  JSON.stringify({ step_index: stepIndex, type: 'GENERIC', created_at: '2026-11-18T10:00:06.000Z', source: 'MODEL', status: 'DONE', content });
const RUN_COMMAND = { name: 'run_command', args: { CommandLine: 'echo hi' } };
const ASK = { name: 'ask_question', args: { questions: [{ question: "[jev-elevate:pro] Allow subagent 'expert' to run on pro (session ceiling: flash)?" }] } };
const CMD_OUTPUT = generic(6, `${HEADER}Command output:\nOK`);
const YES_SESSION_ROW = generic(7, `${HEADER}A1: Yes, for this session`);

describe('modeChangedAtMs and denialPredatesModeChange', () => {
  it('reads the stamp of every harness and of one harness; the later wins', () => {
    const cfg = { defaults: { modeChangedAt: '2026-11-18T10:00:00.000Z' }, harnesses: { antigravity: { modeChangedAt: '2026-11-18T11:00:00.000Z' }, 'claude-code': {} } };
    expect(modeChangedAtMs(cfg, 'antigravity')).toBe(Date.parse('2026-11-18T11:00:00.000Z'));
    expect(modeChangedAtMs(cfg, 'claude-code')).toBe(Date.parse('2026-11-18T10:00:00.000Z'));
    expect(modeChangedAtMs(cfg)).toBe(Date.parse('2026-11-18T10:00:00.000Z'));
  });

  it('a missing stamp (an older config), a bad value or no config means no restriction', () => {
    for (const cfg of [undefined, null, {}, { defaults: {} }, { defaults: { modeChangedAt: 'not a date' } }, { defaults: { modeChangedAt: '' } }]) {
      expect(modeChangedAtMs(cfg as any, 'antigravity')).toBeNull();
      expect(denialPredatesModeChange(1, cfg as any, 'antigravity')).toBe(false);
    }
  });

  it('a denial before the stamp predates the change; one at or after it does not', () => {
    const cfg = stamp(1000);
    expect([denialPredatesModeChange(999, cfg), denialPredatesModeChange(1000, cfg), denialPredatesModeChange(1001, cfg)]).toEqual([true, false, false]);
  });
});

describe('every mode writer stamps the change (writeModeState)', () => {
  let dir = '';
  let saved: string | undefined;
  beforeEach(() => {
    clearConfigCacheForTesting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-stamp-'));
    saved = process.env.JEV_CONFIG_FILE;
    process.env.JEV_CONFIG_FILE = path.join(dir, 'config.json');
  });
  afterEach(() => {
    clearConfigCacheForTesting();
    if (saved === undefined) delete process.env.JEV_CONFIG_FILE;
    else process.env.JEV_CONFIG_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const read = () => JSON.parse(fs.readFileSync(process.env.JEV_CONFIG_FILE!, 'utf8'));

  it('a change for every harness stamps defaults and each existing harness entry, with the instant it returns', async () => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ defaults: { mode: 'off' }, harnesses: { antigravity: { mode: 'off' } } }));
    const updatedAt = await writeModeState('on-demand');
    const cfg = read();
    expect(cfg.defaults).toMatchObject({ mode: 'on-demand', modeChangedAt: updatedAt });
    expect(cfg.harnesses.antigravity).toMatchObject({ mode: 'on-demand', modeChangedAt: updatedAt });
  });

  it('a change for one harness stamps that harness only', async () => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ defaults: { mode: 'off' } }));
    const updatedAt = await writeModeState('on', 'antigravity');
    const cfg = read();
    expect(cfg.harnesses.antigravity).toMatchObject({ mode: 'on', modeChangedAt: updatedAt });
    expect(cfg.defaults.modeChangedAt).toBeUndefined();
  });

  it('every later change moves the stamp forward', async () => {
    const first = await writeModeState('on');
    await Bun.sleep(5);
    const second = await writeModeState('on-demand');
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    expect(read().defaults.modeChangedAt).toBe(second);
  });
});

describe('Antigravity elevation pull fallback and the mode change', () => {
  let dir = '';
  let store: ApprovalStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mode-change-'));
    store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** The question was asked and answered "Yes, for this session" (row 7, its step recorded against the denial). */
  function deniedAndAnswered(): string {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, [planner(5, [RUN_COMMAND, ASK]), CMD_OUTPUT, YES_SESSION_ROW].join('\n') + '\n');
    store.deny(SID, 'pro', DENIED_AT);
    expect(store.noteAnswerStep?.(SID, 'pro', 7, DENIED_AT + 1000)).toBe(true);
    return file;
  }
  const proCall = (file: string): AntigravityHookInput => ({
    conversationId: SID,
    transcriptPath: file,
    modelName: 'gemini-3.8-flash-low',
    lastUserInput: 'p',
    toolCall: { id: 'sub', name: 'invoke_subagent', args: { TypeName: 'expert', Model: 'pro' } }
  });
  const evaluate = (file: string, config: unknown, now = NOW) =>
    evaluateAntigravitySubagentCall(proCall(file), { approvals: store, sessionModelOverride: 'gemini-3.8-flash-low', mode: 'on', config: config as any, now: () => now });

  it('deny in on, a mode change stamped after it, "Yes, for this session" in the transcript, back in on: denied, no approval recorded', () => {
    const file = deniedAndAnswered();

    const d = evaluate(file, stamp(DENIED_AT + 2000));

    expect(d.decision).toBe('deny');
    expect(d.elevation).toBe('denied');
    expect(d.pullFallback).toBe('mode_changed');
    expect(store.claim(SID, 'pro', NOW + 1)).toBeNull(); // nothing was approved
    // A fresh question, as for a first attempt: the denial is re-noted now and the old answer row is no longer attached to it.
    expect(store.wasDeniedRecently(SID, 'pro', NOW + 1)).toBe(NOW);
    expect(store.getAnswerStep?.(SID, 'pro', NOW + 1)).toBeNull();
    const again = evaluate(file, stamp(DENIED_AT + 2000), NOW + 1000);
    expect(again.decision).toBe('deny');
    expect(again.pullFallback).toBeUndefined();
  });

  it('control: no mode change since the denial, the late answer still allows exactly as before', () => {
    for (const config of [undefined, {}, stamp(DENIED_AT - 1000), { harnesses: { 'claude-code': { modeChangedAt: new Date(NOW).toISOString() } } }]) {
      store = createAntigravityApprovalStore(path.join(dir, `sessions-${Math.random()}`));
      const file = deniedAndAnswered();

      const d = evaluate(file, config);

      expect(d.decision).toBe('allow');
      expect(d.approvalScope).toBe('session');
      expect(d.pullFallback).toBe(true);
    }
  });

  it('on-demand writes nothing and decides nothing even with a stale denial and a stamp', () => {
    const file = deniedAndAnswered();
    const before = JSON.stringify(store.wasDeniedRecently(SID, 'pro', NOW));

    const d = evaluateAntigravitySubagentCall(proCall(file), { approvals: store, sessionModelOverride: 'gemini-3.8-flash-low', mode: 'on-demand', config: stamp(DENIED_AT + 2000) as any, now: () => NOW });

    expect(d.decision).toBe('pass');
    expect(JSON.stringify(store.wasDeniedRecently(SID, 'pro', NOW))).toBe(before);
  });
});

describe('Antigravity downgrade question and the mode change', () => {
  const T0 = 1_800_000_000_000;
  let dir = '';
  let now = T0;
  let store: ReturnType<typeof createAntigravityDowngradeStore>;
  let approvals: ApprovalStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mode-change-dg-'));
    const sessions = path.join(dir, 'sessions');
    approvals = createAntigravityApprovalStore(sessions);
    store = createAntigravityDowngradeStore(sessions);
    now = T0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const input: AntigravityHookInput = {
    conversationId: 'conv-dg',
    modelName: 'gemini-3.8-flash-low',
    lastUserInput: 'sweep the folder',
    stepIdx: 10,
    toolCall: { id: 'c', name: 'invoke_subagent', args: { TypeName: 'self', Role: 'worker', Prompt: 'rename the files in the folder', Model: 'flash' } }
  };
  async function decide(config?: unknown) {
    const base = evaluateAntigravitySubagentCall(input, { approvals, sessionModelOverride: 'gemini-3.8-flash-low', mode: 'on', now: () => now });
    const deps: DowngradeDeps = {
      store,
      jevMode: 'on',
      sessionModel: 'gemini-3.8-flash-low',
      env: { JEV_DOWNGRADE: 'ask' },
      rateTask: async () => HAIKU,
      now: () => now,
      config: config as any
    };
    return applyAntigravityDowngrade(input, base, deps);
  }

  it('asked in on, a mode change after it: the retry is asked again with a fresh question, not let through as already asked', async () => {
    expect((await decide()).decision.decision).toBe('deny'); // the question, asked at T0
    now = T0 + 10_000;

    const r = await decide(stamp(T0 + 5000));

    expect(r.decision.decision).toBe('deny');
    expect(r.log.downgrade).toBe('asked');
  });

  it('control: no mode change, the retry passes as already asked', async () => {
    await decide();
    now = T0 + 10_000;

    for (const config of [undefined, stamp(T0 - 1000)]) {
      const r = await decide(config);
      expect(r.decision.decision).toBe('pass');
      expect(r.log.downgrade_skip).toBe('already-asked');
    }
  });

  it('an answer to a question asked before the change records nothing once it is voided', async () => {
    await decide();
    now = T0 + 10_000;

    expect(store.voidStale?.('conv-dg', (askedAt) => denialPredatesModeChange(askedAt, stamp(T0 + 5000)))).toBe(1);

    expect(store.answer('conv-dg', 'yes', undefined, now, null)).toBe(false);
    expect(store.voidStale?.('conv-dg', () => true)).toBe(0);
  });
});

describe('the real Antigravity hook process and the mode change', () => {
  const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
  const CONV = '00000000-0000-4000-8000-0000000000ee';
  let home = '';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mode-change-proc-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' }));
    setConfig({ defaults: { mode: 'on' } });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const configFile = () => path.join(home, '.config', 'jev', 'config.json');
  const setConfig = (cfg: object) => fs.writeFileSync(configFile(), JSON.stringify(cfg));
  const run = (event: string, input: object) =>
    Bun.spawnSync(['bun', HOOK, event], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: configFile() }
    });
  const elevate = (transcriptPath: string) => ({
    conversationId: CONV,
    transcriptPath,
    lastUserInput: 'Invoke expert on pro',
    modelName: 'gemini-3.8-flash-low',
    toolCall: { name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } }
  });
  const askDone = (transcriptPath: string) => ({ conversationId: CONV, transcriptPath, stepIdx: 7, modelName: 'gemini-3.8-flash-low', toolCall: { name: 'ask_question', args: ASK.args } });
  const decisionOf = (p: ReturnType<typeof run>) => JSON.parse(p.stdout.toString()).decision;
  const rows = (): Record<string, any>[] =>
    fs.readFileSync(path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const approvalsOnDisk = (): unknown[] => {
    const f = path.join(home, '.config', 'jev', 'antigravity-sessions', `${CONV}.approvals.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).approvals : [];
  };
  const transcript = () => {
    const file = path.join(home, 'transcript_full.jsonl');
    fs.writeFileSync(file, [planner(5, [RUN_COMMAND, ASK]), CMD_OUTPUT, YES_SESSION_ROW].join('\n') + '\n');
    return file;
  };

  it('deny, a stamped mode change, then the answer is recorded: no approval (outcome mode_changed), and the next pro call is denied again', () => {
    const file = transcript();
    expect(decisionOf(run('pre-tool-use', elevate(file)))).toBe('deny');

    Bun.sleepSync(25);
    setConfig({ defaults: { mode: 'on', modeChangedAt: new Date().toISOString() } });
    Bun.sleepSync(25);
    expect(run('post-tool-use', askDone(file)).exitCode).toBe(0);
    expect(rows().find((r) => r.event === 'ask_answer').outcome).toBe('mode_changed');
    expect(approvalsOnDisk()).toEqual([]);

    expect(decisionOf(run('pre-tool-use', elevate(file)))).toBe('deny');
    expect(rows().filter((r) => r.event === 'agent_call').pop().pull_fallback).toBe('mode_changed');
    expect(approvalsOnDisk()).toEqual([]);
  });

  it('control: no mode change, the same answer is recorded and the next pro call is allowed', () => {
    const file = transcript();
    expect(decisionOf(run('pre-tool-use', elevate(file)))).toBe('deny');

    run('post-tool-use', askDone(file));
    expect(rows().find((r) => r.event === 'ask_answer').outcome).toBe('recorded');

    expect(decisionOf(run('pre-tool-use', elevate(file)))).toBe('allow');
  });
});
