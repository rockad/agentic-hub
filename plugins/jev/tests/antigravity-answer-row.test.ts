import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateAntigravitySubagentCall, pullElevationAnswerFromTranscript } from '../antigravity/logic.ts';
import { createAntigravityApprovalStore, type ApprovalStore } from '../antigravity/approvals.ts';

/**
 * The live failure (Antigravity, real transcript): one PLANNER_RESPONSE step called run_command and ask_question in
 * parallel. Real transcripts carry NO tool call id (tool_calls[] entries have only `args` and `name`, GENERIC steps
 * have no toolCallId), so the row of the question can only be found by the step_index PostToolUse reports. The
 * command's output row (step 6) came first and ended in "A1: Yes, for the next 5 minutes"; the question's own row
 * (step 7) said "A1: Yes, once". The pull took step 6 and approved a broader scope than the user gave.
 */
const DENIED_AT = Date.parse('2026-11-18T10:00:00.000Z');
const HEADER = 'Created At: 2026-11-18T10:00:05+02:00\nCompleted At: 2026-11-18T10:00:09+02:00\n';

const planner = (stepIndex: number, toolCalls: unknown[]) =>
  JSON.stringify({
    step_index: stepIndex,
    type: 'PLANNER_RESPONSE',
    created_at: '2026-11-18T10:00:01.000Z',
    source: 'MODEL',
    status: 'DONE',
    content: '',
    tool_calls: toolCalls
  });
const generic = (stepIndex: number, content: string) =>
  JSON.stringify({
    step_index: stepIndex,
    type: 'GENERIC',
    created_at: '2026-11-18T10:00:06.000Z',
    source: 'MODEL',
    status: 'DONE',
    content
  });

const RUN_COMMAND = { name: 'run_command', args: { CommandLine: 'echo hi' } };
const ASK = {
  name: 'ask_question',
  args: { questions: [{ question: "[jev-elevate:pro] Allow subagent 'expert' to run on pro (session ceiling: flash)?" }] }
};
const CMD_OUTPUT = generic(6, `${HEADER}Command output:\nA1: Yes, for the next 5 minutes`);
const ASK_ROW = generic(7, `${HEADER}A1: Yes, once`);

describe('answer row: the live failure (id-less real-shaped transcript)', () => {
  let dir = '';
  let file = '';
  const write = (...lines: string[]) => fs.writeFileSync(file, lines.join('\n') + '\n');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-answer-row-'));
    file = path.join(dir, 'transcript_full.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('with the recorded stepIdx 7 the answer is the question\'s own row: scope once, not 5min', () => {
    write(planner(5, [RUN_COMMAND, ASK]), CMD_OUTPUT, ASK_ROW);
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT, 7)).toEqual({ approved: true, scope: 'once' });
  });

  it('without a recorded stepIdx and several tool calls in the planner step there is no answer', () => {
    write(planner(5, [RUN_COMMAND, ASK]), CMD_OUTPUT, ASK_ROW);
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT)).toBeNull();
  });

  it('the order of the planner tool calls does not matter: no recorded stepIdx is still no answer', () => {
    write(planner(5, [ASK, RUN_COMMAND]), CMD_OUTPUT, ASK_ROW);
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT)).toBeNull();
  });

  it('with only step 6 written and stepIdx 7 recorded there is no answer yet', () => {
    write(planner(5, [RUN_COMMAND, ASK]), CMD_OUTPUT);
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT, 7)).toBeNull();
  });

  it('a recorded stepIdx never reads another row, even one that says Yes', () => {
    write(planner(5, [RUN_COMMAND, ASK]), CMD_OUTPUT, generic(7, `${HEADER}A1: No, proceed on flash`));
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT, 7)).toEqual({ approved: false });
  });

  it('a recorded stepIdx must point at a GENERIC row after the question', () => {
    write(planner(5, [RUN_COMMAND, ASK]), planner(7, [RUN_COMMAND]), CMD_OUTPUT);
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT, 7)).toBeNull();
    // A row from before the question is not its answer either.
    write(generic(2, `${HEADER}A1: Yes, for this session`), planner(5, [RUN_COMMAND, ASK]), CMD_OUTPUT);
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT, 2)).toBeNull();
  });

  it('a planner step whose only tool call is the question still falls back to the first GENERIC row', () => {
    write(planner(5, [ASK]), generic(6, `${HEADER}A1: Yes, once`));
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT)).toEqual({ approved: true, scope: 'once' });
  });

  it('a planner step with no tool call (marker only in prose) has no fallback', () => {
    write(
      JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', content: 'About [jev-elevate:pro] Allow?' }),
      generic(6, `${HEADER}A1: Yes, once`)
    );
    expect(pullElevationAnswerFromTranscript(file, 'pro')).toBeNull();
    expect(pullElevationAnswerFromTranscript(file, 'pro', undefined, 6)).toEqual({ approved: true, scope: 'once' });
  });

  it('a tool call id, when present, still takes precedence over the recorded stepIdx', () => {
    write(
      planner(5, [RUN_COMMAND, { ...ASK, id: 'ask_X' }]),
      JSON.stringify({ step_index: 6, type: 'GENERIC', toolCallId: 'other', content: 'A1: Yes, for this session' }),
      JSON.stringify({ step_index: 7, type: 'GENERIC', toolCallId: 'ask_X', content: 'A1: Yes, once' })
    );
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT, 6)).toEqual({ approved: true, scope: 'once' });
    // With an id and no row for it yet, a recorded stepIdx does not substitute another row.
    write(planner(5, [{ ...ASK, id: 'ask_X' }]), generic(6, 'A1: Yes, once'));
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT, 6)).toBeNull();
  });
});

describe('answer row: the approvals store records the step against a pending denial', () => {
  let dir = '';
  let store: ApprovalStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-answer-row-store-'));
    store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('records only while a denial is pending, and reads it back for that model', () => {
    expect(store.noteAnswerStep?.('s1', 'pro', 7, 1000)).toBe(false);
    expect(store.getAnswerStep?.('s1', 'pro', 1000)).toBeNull();
    store.deny('s1', 'pro', 1000);
    expect(store.noteAnswerStep?.('s1', 'pro', 7, 2000)).toBe(true);
    expect(store.getAnswerStep?.('s1', 'pro', 3000)).toBe(7);
    expect(store.getAnswerStep?.('other', 'pro', 3000)).toBeNull();
  });

  it('a fresh denial forgets the step of the previous question', () => {
    store.deny('s1', 'pro', 1000);
    store.noteAnswerStep?.('s1', 'pro', 7, 2000);
    store.deny('s1', 'pro', 3000);
    expect(store.getAnswerStep?.('s1', 'pro', 3500)).toBeNull();
  });

  it('recording the approval consumes the step with the denial', () => {
    store.deny('s1', 'pro', 1000);
    store.noteAnswerStep?.('s1', 'pro', 7, 2000);
    expect(store.record('s1', { model: 'pro', scope: 'once', created_at: 4000 })).toBe(true);
    expect(store.getAnswerStep?.('s1', 'pro', 4500)).toBeNull();
  });

  it('rejects a step that is not a non-negative integer', () => {
    store.deny('s1', 'pro', 1000);
    expect(store.noteAnswerStep?.('s1', 'pro', -1, 2000)).toBe(false);
    expect(store.noteAnswerStep?.('s1', 'pro', 1.5, 2000)).toBe(false);
  });
});

describe('answer row: PreToolUse pull through evaluateAntigravitySubagentCall', () => {
  let dir = '';
  let store: ApprovalStore;
  const nowMs = Date.parse('2026-11-18T10:00:10.000Z');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-answer-row-eval-'));
    store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const call = (file: string) =>
    evaluateAntigravitySubagentCall(
      {
        conversationId: '00000000-0000-4000-8000-0000000000aa',
        transcriptPath: file,
        modelName: 'gemini-3.8-flash-low',
        lastUserInput: 'p',
        toolCall: { id: 'sub', name: 'invoke_subagent', args: { TypeName: 'expert', Model: 'pro' } }
      },
      { approvals: store, sessionModelOverride: 'gemini-3.8-flash-low', now: () => nowMs }
    );
  const SID = '00000000-0000-4000-8000-0000000000aa';

  it('the live failure: step 6 says 5min, step 7 says once; with stepIdx 7 recorded the scope is once', () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, [planner(5, [RUN_COMMAND, ASK]), CMD_OUTPUT, ASK_ROW].join('\n') + '\n');
    store.deny(SID, 'pro', nowMs - 5000);
    expect(store.noteAnswerStep?.(SID, 'pro', 7, nowMs - 1000)).toBe(true);
    const d = call(file);
    expect(d.decision).toBe('allow');
    expect(d.approvalScope).toBe('once');
    expect(d.pullFallback).toBe(true);
  });

  it('without a recorded stepIdx the user is asked again instead of getting the 5min scope', () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, [planner(5, [RUN_COMMAND, ASK]), CMD_OUTPUT, ASK_ROW].join('\n') + '\n');
    store.deny(SID, 'pro', nowMs - 5000);
    const d = call(file);
    expect(d.decision).toBe('deny');
    expect(d.approvalScope).toBeUndefined();
    expect(store.claim(SID, 'pro', nowMs + 1)).toBeNull();
  });

  it('with only step 6 written and stepIdx 7 recorded nothing is approved', () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, [planner(5, [RUN_COMMAND, ASK]), CMD_OUTPUT].join('\n') + '\n');
    store.deny(SID, 'pro', nowMs - 5000);
    store.noteAnswerStep?.(SID, 'pro', 7, nowMs - 1000);
    const d = call(file);
    expect(d.decision).toBe('deny');
    expect(store.claim(SID, 'pro', nowMs + 1)).toBeNull();
  });
});

describe('answer row: through the real hook process', () => {
  const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
  const CONV = '00000000-0000-4000-8000-0000000000bb';
  let home = '';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-answer-row-proc-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'),
      JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' })
    );
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function run(event: string, input: object) {
    return Bun.spawnSync(['bun', HOOK, event], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json') }
    });
  }
  const elevate = (transcriptPath: string) => ({
    conversationId: CONV,
    transcriptPath,
    lastUserInput: 'Invoke expert on pro',
    modelName: 'gemini-3.8-flash-low',
    toolCall: { name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } }
  });
  const askDone = (transcriptPath: string) => ({
    conversationId: CONV,
    transcriptPath,
    stepIdx: 7,
    modelName: 'gemini-3.8-flash-low',
    toolCall: { name: 'ask_question', args: ASK.args }
  });
  const stateFile = () => path.join(home, '.config', 'jev', 'antigravity-sessions', `${CONV}.approvals.json`);
  const decisionRows = () =>
    fs
      .readFileSync(path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('PostToolUse records stepIdx 7 against the denial even when the row is not written yet (no_row); the pull then reads row 7 only', () => {
    const transcript = path.join(home, 'transcript_full.jsonl');
    // Antigravity flushes the question's own row after the hook: only the command output (step 6) is there.
    fs.writeFileSync(transcript, [planner(5, [RUN_COMMAND, ASK]), CMD_OUTPUT].join('\n') + '\n');

    expect(JSON.parse(run('pre-tool-use', elevate(transcript)).stdout.toString()).decision).toBe('deny');
    const post = run('post-tool-use', askDone(transcript));
    expect(post.exitCode).toBe(0);
    expect(decisionRows().find((r) => r.event === 'ask_answer').outcome).toBe('no_row');
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).answerSteps).toEqual({ pro: 7 });

    // Row 7 not there yet: still denied (the user is asked again), and nothing approved from step 6.
    expect(JSON.parse(run('pre-tool-use', elevate(transcript)).stdout.toString()).decision).toBe('deny');

    // The row arrives: now the pull reads it, and the scope is once, not the 5 minutes from step 6.
    fs.appendFileSync(transcript, ASK_ROW + '\n');
    // The previous denial reset the recorded step (a fresh question), so the hook records it again.
    run('post-tool-use', askDone(transcript));
    const out = JSON.parse(run('pre-tool-use', elevate(transcript)).stdout.toString());
    expect(out.decision).toBe('allow');
    const call = decisionRows().filter((r) => r.event === 'agent_call').pop();
    expect(call.approval_scope).toBe('once');
  });

  it('without a PostToolUse the pull approves nothing from a multi-tool planner step', () => {
    const transcript = path.join(home, 'transcript_full.jsonl');
    fs.writeFileSync(transcript, [planner(5, [RUN_COMMAND, ASK]), CMD_OUTPUT, ASK_ROW].join('\n') + '\n');
    expect(JSON.parse(run('pre-tool-use', elevate(transcript)).stdout.toString()).decision).toBe('deny');
    expect(JSON.parse(run('pre-tool-use', elevate(transcript)).stdout.toString()).decision).toBe('deny');
  });
});

/**
 * Review findings on the answer row (F2, F3).
 * F2: one answer must not approve two runs. After an approval is consumed a fresh denial clears the recorded step, and
 * the old question still matches through the 5 s slack on the planner row, so its first GENERIC row was read a second
 * time. The consumed answer row (`step:<n>#<q>`, or `<id>#<q>`) is remembered in the session state.
 * F3: the question index comes from the question PostToolUse saw, not from whichever ask in the planner step matched.
 */
describe('answer row: one answer approves one run (F2)', () => {
  let dir = '';
  let store: ApprovalStore;
  const SID = '00000000-0000-4000-8000-0000000000cc';
  const T = Date.parse('2026-11-18T10:00:00.000Z');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-answer-row-f2-'));
    store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const lone = (askRow: string) =>
    [
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        created_at: new Date(T + 1000).toISOString(),
        content: '',
        tool_calls: [ASK]
      }),
      askRow
    ].join('\n') + '\n';
  const row6 = JSON.stringify({
    step_index: 6,
    type: 'GENERIC',
    created_at: new Date(T + 2500).toISOString(),
    content: `${HEADER}A1: Yes, once`
  });
  const call = (file: string, typeName: string, nowMs: number) =>
    evaluateAntigravitySubagentCall(
      {
        conversationId: SID,
        transcriptPath: file,
        modelName: 'gemini-3.8-flash-low',
        lastUserInput: 'p',
        toolCall: { id: 'sub', name: 'invoke_subagent', args: { TypeName: typeName, Model: 'pro' } }
      },
      { approvals: store, sessionModelOverride: 'gemini-3.8-flash-low', now: () => nowMs }
    );

  it('a consumed once answer is not read again after a new denial for the same model', () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, lone(row6));
    store.deny(SID, 'pro', T);
    const first = call(file, 'expert', T + 3000);
    expect(first.decision).toBe('allow');
    expect(first.approvalScope).toBe('once');
    // A different TypeName resets the attempt counter; the denial the pull consumed is replaced by a new one.
    expect(call(file, 'other', T + 3500).decision).toBe('deny');
    const replay = call(file, 'other', T + 4000);
    expect(replay.decision).toBe('deny');
    expect(replay.approvalScope).toBeUndefined();
    expect(store.claim(SID, 'pro', T + 4001)).toBeNull();
  });

  it('a different row (a later question) is still read', () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, lone(row6));
    store.deny(SID, 'pro', T);
    expect(call(file, 'expert', T + 3000).decision).toBe('allow');
    expect(call(file, 'other', T + 3500).decision).toBe('deny');
    const later = [
      JSON.stringify({ step_index: 8, type: 'PLANNER_RESPONSE', created_at: new Date(T + 3600).toISOString(), content: '', tool_calls: [ASK] }),
      JSON.stringify({ step_index: 9, type: 'GENERIC', created_at: new Date(T + 3700).toISOString(), content: `${HEADER}A1: Yes, for this session` })
    ].join('\n');
    fs.writeFileSync(file, lone(row6) + later + '\n');
    const d = call(file, 'other', T + 4000);
    expect(d.decision).toBe('allow');
    expect(d.approvalScope).toBe('session');
  });

  it('the store refuses to record a second approval for an answer key it already consumed', () => {
    store.deny(SID, 'pro', 1000);
    expect(store.record(SID, { model: 'pro', scope: 'once', created_at: 2000 }, ['step:7#0'])).toBe(true);
    expect(store.claim(SID, 'pro', 2001)?.scope).toBe('once');
    store.deny(SID, 'pro', 3000);
    expect(store.record(SID, { model: 'pro', scope: 'once', created_at: 4000 }, ['step:7#0'])).toBe(false);
    expect(store.claim(SID, 'pro', 4001)).toBeNull();
    // Another key is fine.
    expect(store.record(SID, { model: 'pro', scope: 'once', created_at: 4000 }, ['step:9#0'])).toBe(true);
  });
});

describe('answer row: the question index comes from the recorded question (F3)', () => {
  let dir = '';
  let file = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-answer-row-f3-'));
    file = path.join(dir, 'transcript_full.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const askA = { name: 'ask_question', args: { questions: [{ question: 'Deploy now?' }, { question: '[jev-elevate:pro] A?' }] } };
  const askB = { name: 'ask_question', args: { questions: [{ question: '[jev-elevate:pro] B?' }] } };
  const rowA = generic(6, `${HEADER}A1: Yes, for the next 5 minutes\nA2: Yes, once`);
  const rowB = generic(7, `${HEADER}A1: Yes, once`);

  it('reads the recorded question line, not the matched call\'s (last match)', () => {
    fs.writeFileSync(file, [planner(5, [askA, askB]), rowA, rowB].join('\n') + '\n');
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT, 6, 1)).toEqual({ approved: true, scope: 'once' });
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT, 7, 0)).toEqual({ approved: true, scope: 'once' });
  });

  it('reads the recorded question line when the matched call is the first one', () => {
    const rowAFirst = generic(7, `${HEADER}A1: Yes, for the next 5 minutes\nA2: Yes, once`);
    fs.writeFileSync(file, [planner(5, [askB, askA]), generic(6, `${HEADER}A1: Yes, once`), rowAFirst].join('\n') + '\n');
    expect(pullElevationAnswerFromTranscript(file, 'pro', DENIED_AT, 7, 1)).toEqual({ approved: true, scope: 'once' });
  });

  it('the store keeps the question index with the step and forgets both with the denial', () => {
    const store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
    store.deny('s1', 'pro', 1000);
    expect(store.noteAnswerStep?.('s1', 'pro', 6, 2000, 1)).toBe(true);
    expect(store.getAnswerStep?.('s1', 'pro', 3000)).toBe(6);
    expect(store.getAnswerQuestion?.('s1', 'pro', 3000)).toBe(1);
    store.deny('s1', 'pro', 4000);
    expect(store.getAnswerQuestion?.('s1', 'pro', 4500)).toBeNull();
  });

  it('through evaluateAntigravitySubagentCall: the recorded question index gives the scope the user chose', () => {
    const nowMs = Date.parse('2026-11-18T10:00:10.000Z');
    const store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
    const SID = '00000000-0000-4000-8000-0000000000dd';
    fs.writeFileSync(file, [planner(5, [askA, askB]), rowA, rowB].join('\n') + '\n');
    store.deny(SID, 'pro', nowMs - 5000);
    store.noteAnswerStep?.(SID, 'pro', 6, nowMs - 1000, 1);
    const d = evaluateAntigravitySubagentCall(
      {
        conversationId: SID,
        transcriptPath: file,
        modelName: 'gemini-3.8-flash-low',
        lastUserInput: 'p',
        toolCall: { id: 'sub', name: 'invoke_subagent', args: { TypeName: 'expert', Model: 'pro' } }
      },
      { approvals: store, sessionModelOverride: 'gemini-3.8-flash-low', now: () => nowMs }
    );
    expect(d.decision).toBe('allow');
    expect(d.approvalScope).toBe('once');
  });
});

describe('answer row: the hook process records the question index and consumes the answer row (F2, F3)', () => {
  const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
  const CONV = '00000000-0000-4000-8000-0000000000ee';
  let home = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-answer-row-proc2-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'),
      JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' })
    );
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = (event: string, input: object) =>
    Bun.spawnSync(['bun', HOOK, event], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json') }
    });
  const elevate = (transcriptPath: string) => ({
    conversationId: CONV,
    transcriptPath,
    lastUserInput: 'Invoke expert on pro',
    modelName: 'gemini-3.8-flash-low',
    toolCall: { name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } }
  });
  const stateFile = () => path.join(home, '.config', 'jev', 'antigravity-sessions', `${CONV}.approvals.json`);

  it('two asks with the marker in one planner step: the answer line is the one of the question PostToolUse saw', () => {
    const transcript = path.join(home, 'transcript_full.jsonl');
    const askA = { name: 'ask_question', args: { questions: [{ question: 'Deploy now?' }, { question: '[jev-elevate:pro] A?' }] } };
    const askB = { name: 'ask_question', args: { questions: [{ question: '[jev-elevate:pro] B?' }] } };
    fs.writeFileSync(
      transcript,
      [
        planner(5, [askA, askB]),
        generic(6, `${HEADER}A1: Yes, for the next 5 minutes\nA2: Yes, once`),
        generic(7, `${HEADER}A1: Yes, once`)
      ].join('\n') + '\n'
    );
    expect(JSON.parse(run('pre-tool-use', elevate(transcript)).stdout.toString()).decision).toBe('deny');
    run('post-tool-use', { conversationId: CONV, transcriptPath: transcript, stepIdx: 6, modelName: 'gemini-3.8-flash-low', toolCall: { name: 'ask_question', args: askA.args } });
    // PostToolUse itself read row 6 line 2 (once) and recorded it; the state keeps the question index.
    const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    expect(state.approvals.map((a: { scope: string }) => a.scope)).toEqual(['once']);
    expect(state.consumedAnswers).toEqual(['step:6#1']);
  });

  it('a late second PostToolUse for the same answer row cannot approve a later denial', () => {
    const transcript = path.join(home, 'transcript_full.jsonl');
    fs.writeFileSync(transcript, [planner(5, [ASK]), generic(6, `${HEADER}A1: Yes, once`)].join('\n') + '\n');
    const post = { conversationId: CONV, transcriptPath: transcript, stepIdx: 6, modelName: 'gemini-3.8-flash-low', toolCall: { name: 'ask_question', args: ASK.args } };
    run('pre-tool-use', elevate(transcript));
    run('post-tool-use', post);
    expect(JSON.parse(run('pre-tool-use', elevate(transcript)).stdout.toString()).decision).toBe('allow');
    // A new denial, then the same PostToolUse delivered again.
    const other = { ...elevate(transcript), toolCall: { name: 'invoke_subagent', args: { TypeName: 'other', Prompt: 'x', Model: 'pro' } } };
    expect(JSON.parse(run('pre-tool-use', other).stdout.toString()).decision).toBe('deny');
    run('post-tool-use', post);
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).approvals).toEqual([]);
  });
});
