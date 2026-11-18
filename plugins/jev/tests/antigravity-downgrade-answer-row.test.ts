/**
 * The downgrade answer is the row PostToolUse recorded, never a guess by position (T17 Case 3, downgrade path).
 *
 * Real Antigravity transcripts carry NO tool call id: `tool_calls[]` entries have only `args` and `name`, GENERIC rows have
 * no `toolCallId`. When one planner step runs another tool in parallel with the `ask_question`, the GENERIC row after the
 * planner step may be that tool's output (call order and completion order are both consistent with a real sample), and its
 * output can end in an answer-shaped line. The fixtures here have the real shape. Hermetic: temp directory, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DOWNGRADE_LABELS,
  DOWNGRADE_MARKER,
  applyAntigravityDowngrade,
  downgradeMarker,
  downgradeSignature,
  parseDowngradeMarker,
  type DowngradeDeps
} from '../antigravity/downgrade.ts';
import { askAnswerKey, evaluateAntigravitySubagentCall, pullAskAnswerFromTranscript, type AntigravityHookInput } from '../antigravity/logic.ts';
import { createAntigravityApprovalStore, createAntigravityDowngradeStore, type ApprovalStore, type DowngradeStore } from '../antigravity/approvals.ts';
import { HAIKU } from './downgrade-helpers.ts';

const FLASH_SESSION = 'gemini-3.8-flash-low';
const T0 = 1_800_000_000_000;
const HEADER = 'Created At: 2027-01-15T10:00:05+02:00\nCompleted At: 2027-01-15T10:00:09+02:00\n';
const YES = DOWNGRADE_LABELS.yes;
const KEEP = DOWNGRADE_LABELS.keep;

let dir = '';
let approvals: ApprovalStore;
let store: DowngradeStore;
let now = T0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dg-row-'));
  approvals = createAntigravityApprovalStore(path.join(dir, 'sessions'));
  store = createAntigravityDowngradeStore(path.join(dir, 'sessions'));
  now = T0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// ── Real-shaped fixtures: no ids anywhere ───────────────────────────────────────────────────────────────────────────
const planner = (stepIndex: number, toolCalls: unknown[]) =>
  JSON.stringify({
    step_index: stepIndex,
    type: 'PLANNER_RESPONSE',
    created_at: new Date(T0 + 1000).toISOString(),
    source: 'MODEL',
    status: 'DONE',
    content: '',
    tool_calls: toolCalls
  });
const generic = (stepIndex: number, content: string) =>
  JSON.stringify({ step_index: stepIndex, type: 'GENERIC', created_at: new Date(T0 + 2000).toISOString(), source: 'MODEL', status: 'DONE', content });
const RUN_COMMAND = { name: 'run_command', args: { CommandLine: 'echo hi' } };
const askCall = (...questions: string[]) => ({ name: 'ask_question', args: { questions: questions.map((question) => ({ question, options: Object.values(DOWNGRADE_LABELS) })) } });

const A_ARGS = { TypeName: 'self', Role: 'worker', Prompt: 'rename the files in the folder' };
const B_ARGS = { TypeName: 'self', Role: 'worker', Prompt: 'translate the readme' };
const SIG_A = downgradeSignature(A_ARGS);
const SIG_B = downgradeSignature(B_ARGS);
const QA = `${downgradeMarker(SIG_A)} Run 'self' on flash_lite?`;
const QB = `${downgradeMarker(SIG_B)} Run 'self' on flash_lite?`;

/** An output row of an unrelated tool that imitates the answer lines of the question. */
const FAKE_OUTPUT = generic(6, `${HEADER}Command output:\nA1: ${YES}\nA2: ${YES}`);
/** The ask's own row: A answered Yes, B answered No. */
const ASK_ROW = generic(7, `${HEADER}A1: ${YES}\nA2: ${KEEP}`);

function transcript(...rows: string[]): string {
  const file = path.join(dir, 'transcript_full.jsonl');
  fs.writeFileSync(file, rows.join('\n') + '\n');
  return file;
}

const ownOf = (sig: string) => (text: string): boolean => {
  const m = parseDowngradeMarker(text);
  return !!m && (m.sig === null || m.sig === sig.slice(0, 8));
};

describe('pullAskAnswerFromTranscript: id-less downgrade transcripts', () => {
  it('reads only the recorded row: two questions in one ask, an unrelated output between, each its own line', () => {
    const file = transcript(planner(5, [RUN_COMMAND, askCall(QA, QB)]), FAKE_OUTPUT, ASK_ROW);
    const a = pullAskAnswerFromTranscript(file, DOWNGRADE_MARKER, { matches: ownOf(SIG_A), answerStepIdx: 7 });
    const b = pullAskAnswerFromTranscript(file, DOWNGRADE_MARKER, { matches: ownOf(SIG_B), answerStepIdx: 7 });
    expect(a?.raw).toBe(YES);
    expect(b?.raw).toBe(KEEP);
    expect(a?.answerStep).toBe(7);
    expect(b?.answerStep).toBe(7);
    expect(a?.questionIndex).toBe(0);
    expect(b?.questionIndex).toBe(1);
  });

  it('a parallel output that imitates "A1: Yes, flash_lite" is never taken: row 7 not written yet is no answer', () => {
    const file = transcript(planner(5, [RUN_COMMAND, askCall(QA)]), generic(6, `${HEADER}Command output:\nA1: ${YES}`));
    expect(pullAskAnswerFromTranscript(file, DOWNGRADE_MARKER, { matches: ownOf(SIG_A), answerStepIdx: 7 })).toBeNull();
  });

  it('with several tool calls and no recorded row there is no answer, in either call order', () => {
    for (const calls of [[RUN_COMMAND, askCall(QA)], [askCall(QA), RUN_COMMAND]]) {
      const file = transcript(planner(5, calls), FAKE_OUTPUT, ASK_ROW);
      expect(pullAskAnswerFromTranscript(file, DOWNGRADE_MARKER, { matches: ownOf(SIG_A) })).toBeNull();
    }
  });

  it('a planner step whose only tool call is the ask still falls back to the first GENERIC row', () => {
    const file = transcript(planner(5, [askCall(QA)]), generic(6, `${HEADER}A1: ${YES}`));
    const pulled = pullAskAnswerFromTranscript(file, DOWNGRADE_MARKER, { matches: ownOf(SIG_A) });
    expect(pulled?.raw).toBe(YES);
    expect(pulled?.answerStep).toBe(6);
  });

  it('a recorded row that is a duplicate index fails closed', () => {
    const file = transcript(planner(5, [RUN_COMMAND, askCall(QA)]), generic(7, `${HEADER}A1: ${YES}`), generic(7, `${HEADER}A1: ${KEEP}`));
    expect(pullAskAnswerFromTranscript(file, DOWNGRADE_MARKER, { matches: ownOf(SIG_A), answerStepIdx: 7 })).toBeNull();
  });

  it('a tool call id, when present, still takes precedence over the recorded row', () => {
    const file = transcript(
      planner(5, [RUN_COMMAND, { ...askCall(QA), id: 'ask_X' }]),
      JSON.stringify({ step_index: 6, type: 'GENERIC', toolCallId: 'other', content: `A1: ${KEEP}` }),
      JSON.stringify({ step_index: 7, type: 'GENERIC', toolCallId: 'ask_X', content: `A1: ${YES}` })
    );
    const pulled = pullAskAnswerFromTranscript(file, DOWNGRADE_MARKER, { matches: ownOf(SIG_A), answerStepIdx: 6 });
    expect(pulled?.raw).toBe(YES);
    expect(pulled?.toolCallId).toBe('ask_X');
  });
});

describe('askAnswerKey: the consumption key', () => {
  it('is the tool call id and question index when there is an id (unchanged)', () => {
    expect(askAnswerKey('ask_1', 2)).toBe('ask_1#2');
    expect(askAnswerKey('ask_1', 2, 9)).toBe('ask_1#2');
  });
  it('is the answer row step and question index when there is no id, never "undefined#0"', () => {
    expect(askAnswerKey(undefined, 0, 7)).toBe('step:7#0');
    expect(askAnswerKey(undefined, 1, 7)).toBe('step:7#1');
    expect(askAnswerKey(undefined, 0)).toBeUndefined();
  });
});

describe('pullAskAnswerFromTranscript: one answer is consumed once', () => {
  const file = () => transcript(planner(5, [RUN_COMMAND, askCall(`${DOWNGRADE_MARKER} one`, `${DOWNGRADE_MARKER} two`)]), FAKE_OUTPUT, ASK_ROW);
  const plain = { matches: (t: string) => parseDowngradeMarker(t) !== null, answerStepIdx: 7 };

  it('a consumed step key hides that question; the next question of the same row is still open', () => {
    expect(pullAskAnswerFromTranscript(file(), DOWNGRADE_MARKER, plain)?.questionIndex).toBe(0);
    expect(pullAskAnswerFromTranscript(file(), DOWNGRADE_MARKER, { ...plain, excludeToolCallIds: new Set(['step:7#0']) })?.questionIndex).toBe(1);
    expect(pullAskAnswerFromTranscript(file(), DOWNGRADE_MARKER, { ...plain, excludeToolCallIds: new Set(['step:7#0', 'step:7#1']) })).toBeNull();
  });

  it('a key of another row, or the id-less string "undefined#0", does not hide anything', () => {
    expect(pullAskAnswerFromTranscript(file(), DOWNGRADE_MARKER, { ...plain, excludeToolCallIds: new Set(['step:9#0', 'undefined#0']) })?.questionIndex).toBe(0);
  });
});

describe('the downgrade store records the answer row against the pending questions', () => {
  const claim = (signature: string, at: number) => store.claim('s1', signature, at, 3);

  it('records on the pending question of the signature in the marker, and pending() reads it back', () => {
    claim(SIG_A, T0);
    claim(SIG_B, T0 + 1);
    expect(store.noteAnswerStep?.('s1', 7, T0 + 10, SIG_A.slice(0, 8))).toBe(true);
    expect(store.pending('s1', SIG_A, T0 + 20)?.answerStep).toBe(7);
    expect(store.pending('s1', SIG_B, T0 + 20)?.answerStep).toBeUndefined();
  });

  it('records nothing for a delegation that is not pending, or that was answered already', () => {
    expect(store.noteAnswerStep?.('s1', 7, T0, SIG_A.slice(0, 8))).toBe(false);
    claim(SIG_A, T0);
    expect(store.answer('s1', 'yes', 'ask_1', T0 + 5, SIG_A.slice(0, 8))).toBe(true);
    expect(store.noteAnswerStep?.('s1', 7, T0 + 10, SIG_A.slice(0, 8))).toBe(false);
  });

  it('the plain marker records on the oldest pending question that has no row yet', () => {
    claim(SIG_A, T0);
    claim(SIG_B, T0 + 1);
    expect(store.noteAnswerStep?.('s1', 7, T0 + 10, null)).toBe(true);
    expect(store.noteAnswerStep?.('s1', 7, T0 + 11, null)).toBe(true);
    expect(store.pending('s1', SIG_A, T0 + 20)?.answerStep).toBe(7);
    expect(store.pending('s1', SIG_B, T0 + 20)?.answerStep).toBe(7);
    expect(store.noteAnswerStep?.('s1', 7, T0 + 12, null)).toBe(false);
  });

  it('rejects a step that is not a non-negative integer', () => {
    claim(SIG_A, T0);
    for (const bad of [-1, 1.5, Number.NaN]) expect(store.noteAnswerStep?.('s1', bad, T0 + 1, SIG_A.slice(0, 8))).toBe(false);
  });

  it('a re-ask of the delegation starts without the earlier question\'s row', () => {
    claim(SIG_A, T0);
    store.noteAnswerStep?.('s1', 7, T0 + 1, SIG_A.slice(0, 8));
    // the question is asked again after its window: a fresh entry, no row recorded for it
    const later = T0 + 11 * 60_000;
    expect(claim(SIG_A, later)).toBe('first');
    expect(store.pending('s1', SIG_A, later + 1)?.answerStep).toBeUndefined();
  });
});

// ── The whole decision: two delegations asked, an unrelated tool ran in parallel with the ask ─────────────────────────
function call(args: Record<string, unknown>, extra: Partial<AntigravityHookInput> = {}): AntigravityHookInput {
  return {
    conversationId: 'conv-dg',
    modelName: FLASH_SESSION,
    lastUserInput: 'sweep the folder',
    stepIdx: 3,
    toolCall: { id: 'call_sub', name: 'invoke_subagent', args: { ...args, Model: 'flash' } },
    ...extra
  };
}
const deps = (over: Partial<DowngradeDeps> = {}): DowngradeDeps => ({
  store,
  jevMode: 'on',
  sessionModel: FLASH_SESSION,
  env: { JEV_DOWNGRADE: 'ask' },
  rateTask: async () => HAIKU,
  now: () => now,
  ratingTimeoutMs: 100,
  ...over
});
async function decide(input: AntigravityHookInput) {
  const base = evaluateAntigravitySubagentCall(input, { approvals, sessionModelOverride: FLASH_SESSION, mode: 'on', now: () => now });
  return applyAntigravityDowngrade(input, base, deps());
}

describe('applyAntigravityDowngrade: id-less transcript, parallel tool output in between', () => {
  async function askBoth() {
    expect((await decide(call(A_ARGS))).decision.decision).toBe('deny');
    expect((await decide(call(B_ARGS))).decision.decision).toBe('deny');
    now += 30_000;
  }

  it('with the recorded row each delegation gets its own answer: A Yes -> flash_lite, B No -> as it is', async () => {
    await askBoth();
    const file = transcript(planner(5, [RUN_COMMAND, askCall(QA, QB)]), FAKE_OUTPUT, ASK_ROW);
    // PostToolUse ran for the ask (its row was not written then): it recorded stepIdx 7 for both questions.
    expect(store.noteAnswerStep?.('conv-dg', 7, now, SIG_A.slice(0, 8))).toBe(true);
    expect(store.noteAnswerStep?.('conv-dg', 7, now, SIG_B.slice(0, 8))).toBe(true);
    const a = await decide(call(A_ARGS, { transcriptPath: file }));
    expect(a.decision).toEqual({ decision: 'allow', overwrite: { Model: 'flash_lite' } });
    expect(a.log.downgrade_pull).toBe(true);
    const b = await decide(call(B_ARGS, { transcriptPath: file }));
    expect(b.decision.decision).toBe('pass');
    expect(b.log.downgrade).toBe('answered');
    expect(store.choiceFor('conv-dg', SIG_B, now)).toBe('keep');
  });

  it('the answers are consumed under step keys, one per question', async () => {
    await askBoth();
    const file = transcript(planner(5, [RUN_COMMAND, askCall(QA, QB)]), FAKE_OUTPUT, ASK_ROW);
    store.noteAnswerStep?.('conv-dg', 7, now, SIG_A.slice(0, 8));
    store.noteAnswerStep?.('conv-dg', 7, now, SIG_B.slice(0, 8));
    await decide(call(A_ARGS, { transcriptPath: file }));
    await decide(call(B_ARGS, { transcriptPath: file }));
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'conv-dg.downgrade.json'), 'utf8'));
    expect(state.entries.map((e: { ask_id?: string }) => e.ask_id).sort()).toEqual(['step:7#0', 'step:7#1']);
  });

  it('without a recorded row the unrelated output is never taken as an answer: both are asked-and-passed, nothing applied', async () => {
    await askBoth();
    const file = transcript(planner(5, [RUN_COMMAND, askCall(QA, QB)]), FAKE_OUTPUT, ASK_ROW);
    for (const args of [A_ARGS, B_ARGS]) {
      const r = await decide(call(args, { transcriptPath: file }));
      expect(r.decision.decision).toBe('pass');
      expect(r.log.downgrade_skip).toBe('already-asked');
      expect(r.log.downgrade_pull).toBeUndefined();
    }
    expect(store.choiceFor('conv-dg', SIG_A, now)).toBeNull();
    expect(store.choiceFor('conv-dg', SIG_B, now)).toBeNull();
  });

  it('with the recorded row 7 and only the unrelated row 6 written, nothing is applied', async () => {
    await askBoth();
    const file = transcript(planner(5, [RUN_COMMAND, askCall(QA, QB)]), FAKE_OUTPUT);
    store.noteAnswerStep?.('conv-dg', 7, now, SIG_A.slice(0, 8));
    const a = await decide(call(A_ARGS, { transcriptPath: file }));
    expect(a.decision.decision).toBe('pass');
    expect(a.log.downgrade_pull).toBeUndefined();
    expect(store.choiceFor('conv-dg', SIG_A, now)).toBeNull();
  });

  it('one plain-marker answer row decides one delegation, not two', async () => {
    await askBoth();
    const file = transcript(planner(5, [askCall(`${DOWNGRADE_MARKER} Run it?`)]), generic(6, `${HEADER}A1: ${YES}`));
    const a = await decide(call(A_ARGS, { transcriptPath: file }));
    expect(a.decision).toEqual({ decision: 'allow', overwrite: { Model: 'flash_lite' } });
    // B is now the oldest pending question, but row 6 was consumed by A under "step:6#0".
    const b = await decide(call(B_ARGS, { transcriptPath: file }));
    expect(b.decision.decision).toBe('pass');
    expect(b.log.downgrade_skip).toBe('already-asked');
    expect(store.choiceFor('conv-dg', SIG_B, now)).toBeNull();
  });
});
