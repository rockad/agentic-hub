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
