/**
 * 2.3.21 (Antigravity): an answer PostToolUse could not read in time (outcome no_row, mode on) to a question Jev never prescribed (no denial on
 * record for the model) is noted as a pending question, and the next launch of the model pulls the answer from the transcript: a Yes allows, a No
 * clamps, with exactly one `elevation_answer` row per answer. With a denial on record nothing changes; on-demand writes no state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateAntigravitySubagentCall, type AntigravityHookInput } from '../antigravity/logic.ts';
import { clearPendingQuestion, createAntigravityApprovalStore, getPendingQuestion, noteAnswerStep, noteDenied, notePendingQuestion, recordApproval } from '../antigravity/approvals.ts';
import { ANSWER_PENDING_LINE } from '../src/core/elevation-answer.ts';

const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const SESSION = 'gemini-3.8-flash-low';
const PROMPT = 'Invoke expert on pro';
const ASK = { name: 'ask_question', args: { questions: [{ question: '[jev-elevate:pro] Allow it?', options: ['Yes, once', 'No'] }] } };

describe('pending question notes (pure)', () => {
  it('a note stands for its model and weaker ones, is dropped by clear only (not by a denial), and is voided by a mode change', () => {
    const noted = notePendingQuestion({ approvals: [] }, 'pro', 7, 1000, 0)!;
    expect(noted.pendingQuestions).toEqual({ pro: { stepIdx: 7, questionIdx: 0, asked_at: 1000 } });
    expect(getPendingQuestion(noted, 'pro')).toMatchObject({ stepIdx: 7 });
    expect(getPendingQuestion(noted, 'flash')).toMatchObject({ stepIdx: 7 }); // a stronger note covers a weaker request
    expect(getPendingQuestion(notePendingQuestion({ approvals: [] }, 'flash', 3, 1000)!, 'pro')).toBeNull();
    expect(getPendingQuestion(noted, 'pro', { defaults: { modeChangedAt: new Date(2000).toISOString() } })).toBeNull();
    expect(getPendingQuestion(noted, 'pro', { defaults: { modeChangedAt: new Date(500).toISOString() } })).not.toBeNull();
    expect(clearPendingQuestion(noted, 'pro')!.pendingQuestions).toBeUndefined();
    expect(clearPendingQuestion({ approvals: [] }, 'pro')).toBeNull();
    // A denial for the model does not drop a standing note: its answer row is still to be read at the next pull.
    expect(noteDenied(noted, 'pro', 2000).pendingQuestions).toEqual(noted.pendingQuestions);
  });

  it('no note is written when a denial covers the model', () => {
    expect(notePendingQuestion(noteDenied({ approvals: [] }, 'pro', 500), 'pro', 7, 1000)).toBeNull();
    expect(notePendingQuestion({ approvals: [] }, 'pro', -1, 1000)).toBeNull();
  });

  it('the store round-trips a note through the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pq-'));
    try {
      const store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
      expect(store.notePendingQuestion!('c1', 'pro', 7, 1000, 0)).toBe(true);
      expect(store.getPendingQuestion!('c1', 'pro')).toEqual({ stepIdx: 7, questionIdx: 0, asked_at: 1000 });
      store.clearPendingQuestion!('c1', 'pro');
      expect(store.getPendingQuestion!('c1', 'pro')).toBeNull();
      store.deny('c1', 'pro', 1);
      expect(store.notePendingQuestion!('c1', 'pro', 7, 1000)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an unprompted question answered late (process)', () => {
  let home = '';
  let transcript = '';
  const config = () => path.join(home, '.config', 'jev', 'config.json');
  const setConfig = (defaults: Record<string, unknown>) => fs.writeFileSync(config(), JSON.stringify({ defaults }));
  const run = (event: string, input: object) =>
    Bun.spawnSync(['bun', HOOK, event], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: config(), JEV_DOWNGRADE: 'off', JEV_ELEVATION: '' }
    });
  const rows = (): Array<Record<string, any>> => {
    const f = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const answerRows = () => rows().filter((r) => r.event === 'elevation_answer');
  const sessionsDir = () => path.join(home, '.config', 'jev', 'antigravity-sessions');
  const state = (conv: string): Record<string, any> => {
    const f = path.join(sessionsDir(), `${conv}.approvals.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  };
  const notices = (conv: string): string[] => {
    const f = path.join(sessionsDir(), `${conv}.answer-notice.json`);
    return fs.existsSync(f) ? JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8'))).split('","') : [];
  };
  const stamp = (ms: number) => new Date(Date.now() + ms).toISOString();
  const invoke = (conv: string, prompt = PROMPT) => ({ conversationId: conv, transcriptPath: transcript, lastUserInput: prompt, modelName: SESSION, toolCall: { id: 'call_1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } } });
  const launch = (conv: string, prompt = PROMPT) => JSON.parse(run('pre-tool-use', invoke(conv, prompt)).stdout.toString());
  const post = (conv: string) => run('post-tool-use', { conversationId: conv, transcriptPath: transcript, stepIdx: 7, lastUserInput: PROMPT, modelName: SESSION, toolCall: { id: 'call_ask', ...ASK } });
  const askedAndAnsweredLate = (conv: string, questionAtMs = -60_000) => {
    // The question is in the transcript (real transcripts carry no tool call id), its answer row is not yet.
    fs.writeFileSync(transcript, JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: stamp(questionAtMs), source: 'MODEL', status: 'DONE', content: '', tool_calls: [ASK] }) + '\n');
    expect(post(conv).exitCode).toBe(0);
  };
  const answerRow = (text: string) =>
    fs.appendFileSync(transcript, JSON.stringify({ step_index: 7, type: 'GENERIC', created_at: stamp(0), source: 'MODEL', status: 'DONE', content: `A1: ${text}` }) + '\n');

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pq-proc-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' }));
    transcript = path.join(home, 'transcript_full.jsonl');
    setConfig({ mode: 'on' });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('PostToolUse notes the question as pending and queues the line, with no elevation_answer row', () => {
    askedAndAnsweredLate('pq1');

    expect(state('pq1').pendingQuestions).toMatchObject({ pro: { stepIdx: 7, questionIdx: 0 } });
    expect(notices('pq1').join('')).toContain(ANSWER_PENDING_LINE);
    expect(answerRows()).toEqual([]);
    expect(rows().find((r) => r.event === 'ask_answer')).toMatchObject({ outcome: 'no_row' });
  });

  it('Yes once: the next launch is allowed, one recorded row, the note is cleared, and the answer is not read twice', () => {
    askedAndAnsweredLate('pq2');
    answerRow('Yes, once');

    const first = launch('pq2');
    expect(first.decision).toBe('allow');
    expect(answerRows()).toMatchObject([{ recorded: true, answer: 'yes', scope: 'once', model: 'pro' }]);
    expect(state('pq2').pendingQuestions).toBeUndefined();
    expect(state('pq2').consumedAnswers).toEqual(['step:7#0']);
    // The once approval was spent by the launch and the row is consumed: the next launch is denied, not approved again.
    expect(launch('pq2').decision).toBe('deny');
    expect(answerRows()).toHaveLength(1);
  });

  it('No: the next launch is clamped to the session model, one recorded row', () => {
    askedAndAnsweredLate('pq3');
    answerRow('No, proceed on flash');

    const out = launch('pq3');
    expect([out.decision, out.overwrite]).toEqual(['allow', { Model: 'flash' }]);
    expect(answerRows()).toMatchObject([{ recorded: true, answer: 'no', scope: 'once', model: 'pro' }]);
    expect(state('pq3').pendingQuestions).toBeUndefined();
  });

  it('a mode change after the question voids the note: the launch is denied afresh and nothing is read', () => {
    askedAndAnsweredLate('pq4');
    answerRow('Yes, for this session');
    setConfig({ mode: 'on', modeChangedAt: stamp(60_000) });

    expect(launch('pq4').decision).toBe('deny');
    expect(answerRows()).toEqual([]);
    expect(state('pq4').approvals ?? []).toEqual([]);
  });

  it('with a denial on record no note is written and no pending line is queued (the existing path reads the answer)', () => {
    fs.writeFileSync(transcript, '');
    expect(launch('pq5').decision).toBe('deny');
    askedAndAnsweredLate('pq5', 1000); // the question follows the denial

    expect(state('pq5').pendingQuestions).toBeUndefined();
    expect(state('pq5').answerSteps).toMatchObject({ pro: 7 });
    expect(notices('pq5').join('')).not.toContain(ANSWER_PENDING_LINE);
    expect(answerRows()).toEqual([]);

    answerRow('Yes, once');
    expect(launch('pq5').decision).toBe('allow');
    expect(answerRows()).toMatchObject([{ recorded: true, answer: 'yes', scope: 'once' }]);
  });

  it('on-demand is unchanged: reason mode, no state, no line', () => {
    setConfig({ mode: 'on-demand' });
    askedAndAnsweredLate('pq6');

    expect(answerRows()).toMatchObject([{ recorded: false, reason: 'mode' }]);
    expect(fs.existsSync(path.join(sessionsDir(), 'pq6.approvals.json'))).toBe(false);
    expect(notices('pq6')).toEqual([]);
  });
});

describe('a consumed answer is not re-read (logic)', () => {
  it('a pending note whose answer row is already consumed reads nothing: the launch is denied', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pq-logic-'));
    try {
      const transcript = path.join(dir, 'transcript_full.jsonl');
      const now = Date.now();
      fs.writeFileSync(
        transcript,
        [
          JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: new Date(now - 1000).toISOString(), tool_calls: [ASK] }),
          JSON.stringify({ step_index: 7, type: 'GENERIC', created_at: new Date(now).toISOString(), content: 'A1: Yes, for this session' })
        ].join('\n') + '\n'
      );
      const store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
      store.notePendingQuestion!('c1', 'pro', 7, now, 0);
      // The row already produced an answer elsewhere (consumed under its step key); its approval is of another turn, so none is live.
      store.record('c1', { model: 'pro', scope: 'once', created_at: now, turn: 'another-turn' }, ['step:7#0']);
      const input: AntigravityHookInput = {
        conversationId: 'c1',
        transcriptPath: transcript,
        lastUserInput: PROMPT,
        modelName: SESSION,
        toolCall: { id: 'call_1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } }
      };
      const decision = evaluateAntigravitySubagentCall(input, { approvals: store, sessionModelOverride: SESSION, now: () => now + 10 });
      expect(decision.decision).toBe('deny');
      expect(store.snapshot!('c1').approvals.filter((a) => a.scope === 'session')).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a pending answer keeps its own turn, and its note outlives a denial (process)', () => {
  let home = '';
  let transcript = '';
  const NEXT = 'a different message';
  const config = () => path.join(home, '.config', 'jev', 'config.json');
  const run = (event: string, input: object) =>
    Bun.spawnSync(['bun', HOOK, event], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: config(), JEV_DOWNGRADE: 'off', JEV_ELEVATION: '' }
    });
  const rows = (): Array<Record<string, any>> => {
    const f = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const answerRows = () => rows().filter((r) => r.event === 'elevation_answer');
  const state = (conv: string): Record<string, any> => {
    const f = path.join(home, '.config', 'jev', 'antigravity-sessions', `${conv}.approvals.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  };
  const stamp = (ms: number) => new Date(Date.now() + ms).toISOString();
  const launch = (conv: string, prompt = PROMPT) =>
    JSON.parse(
      run('pre-tool-use', { conversationId: conv, transcriptPath: transcript, lastUserInput: prompt, modelName: SESSION, toolCall: { id: 'call_1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } } }).stdout.toString()
    );
  const askedAndAnsweredLate = (conv: string, questionAtMs = -60_000) => {
    fs.writeFileSync(transcript, JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: stamp(questionAtMs), source: 'MODEL', status: 'DONE', content: '', tool_calls: [ASK] }) + '\n');
    expect(run('post-tool-use', { conversationId: conv, transcriptPath: transcript, stepIdx: 7, lastUserInput: PROMPT, modelName: SESSION, toolCall: { id: 'call_ask', ...ASK } }).exitCode).toBe(0);
  };
  const answerRow = (text: string) =>
    fs.appendFileSync(transcript, JSON.stringify({ step_index: 7, type: 'GENERIC', created_at: stamp(0), source: 'MODEL', status: 'DONE', content: `A1: ${text}` }) + '\n');

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pq-turn-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' }));
    fs.writeFileSync(config(), JSON.stringify({ defaults: { mode: 'on' } }));
    transcript = path.join(home, 'transcript_full.jsonl');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('a once Yes given in an earlier turn is not claimed: one stale row, a denial with a fresh question, the row never read again', () => {
    askedAndAnsweredLate('t1');
    answerRow('Yes, once');

    const out = launch('t1', NEXT);
    expect(out.decision).toBe('deny');
    expect(out.reason).toContain('[jev-elevate:pro]');
    expect(answerRows()).toMatchObject([{ recorded: false, reason: 'stale', answer: 'yes', scope: 'once', model: 'pro' }]);
    expect(state('t1').approvals ?? []).toEqual([]);
    expect(state('t1').pendingQuestions).toBeUndefined();
    expect(state('t1').consumedAnswers).toEqual(['step:7#0']);
    expect(launch('t1', NEXT).decision).toBe('deny');
    expect(answerRows()).toHaveLength(1);
  });

  it('a once No given in an earlier turn is not applied: stale row, denied with the question', () => {
    askedAndAnsweredLate('t2');
    answerRow('No, proceed on flash');

    const out = launch('t2', NEXT);
    expect([out.decision, out.overwrite]).toEqual(['deny', undefined]);
    expect(out.reason).toContain('[jev-elevate:pro]');
    expect(answerRows()).toMatchObject([{ recorded: false, reason: 'stale', answer: 'no', scope: 'once' }]);
    expect(state('t2').declines ?? []).toEqual([]);
  });

  it('a session Yes stays valid across turns', () => {
    askedAndAnsweredLate('t3');
    answerRow('Yes, for this session');

    expect(launch('t3', NEXT).decision).toBe('allow');
    expect(answerRows()).toMatchObject([{ recorded: true, answer: 'yes', scope: 'session' }]);
    expect(launch('t3', 'yet another message').decision).toBe('allow');
  });

  it('the denial path keeps the turn too: a once Yes read at a launch of a later turn is stale', () => {
    fs.writeFileSync(transcript, '');
    expect(launch('t4').decision).toBe('deny');
    askedAndAnsweredLate('t4', 1000);
    expect(state('t4').answerTurns).toMatchObject({ pro: expect.any(String) });
    answerRow('Yes, once');

    expect(launch('t4', NEXT).decision).toBe('deny');
    expect(answerRows()).toMatchObject([{ recorded: false, reason: 'stale', answer: 'yes', scope: 'once' }]);
  });

  it('a row still missing at the first launch is read at the second: the note survives the denial, and a once is claimed only in the same turn', () => {
    askedAndAnsweredLate('t5');
    expect(launch('t5').decision).toBe('deny'); // the row is not there yet: the question is asked, the note is kept
    expect(state('t5').pendingQuestions).toMatchObject({ pro: { stepIdx: 7 } });
    expect(answerRows()).toEqual([]);

    answerRow('Yes, once');
    expect(launch('t5').decision).toBe('allow');
    expect(answerRows()).toMatchObject([{ recorded: true, answer: 'yes', scope: 'once' }]);
    expect(state('t5').pendingQuestions).toBeUndefined();
  });

  it('the same, with a turn change before the second launch: the once answer is stale', () => {
    askedAndAnsweredLate('t6');
    expect(launch('t6').decision).toBe('deny');
    answerRow('Yes, once');

    expect(launch('t6', NEXT).decision).toBe('deny');
    expect(answerRows()).toMatchObject([{ recorded: false, reason: 'stale', answer: 'yes', scope: 'once' }]);
    expect(state('t6').pendingQuestions).toBeUndefined();
  });
});

describe('answer-turn pruning (pure)', () => {
  it('recordApproval prunes answerTurns with answerSteps and answerQuestions like answerSteps and answerQuestions', () => {
    let state = noteDenied({ approvals: [] }, 'pro', 100);
    state = noteAnswerStep(state, 'pro', 7, 200, 0, 'turn-a')!;
    state = noteDenied(state, 'flash', 150);
    state = noteAnswerStep(state, 'flash', 9, 250, 0, 'turn-b')!;
    expect(state.answerTurns).toEqual({ pro: 'turn-a', flash: 'turn-b' });

    const done = recordApproval(state, { model: 'pro', scope: 'session', created_at: 300 }, 300)!;
    // The approval's model and stronger ones are pruned; the weaker model's bookkeeping stays, answerTurns like the other two.
    expect(done.state.answerSteps).toEqual({ flash: 9 });
    expect(done.state.answerQuestions).toEqual({ flash: 0 });
    expect(done.state.answerTurns).toEqual({ flash: 'turn-b' });
    // The three maps are pruned by the same rule (as answerSteps always was).
    const flash = recordApproval(state, { model: 'flash', scope: 'session', created_at: 300 }, 300)!;
    expect(Object.keys(flash.state.answerTurns ?? {})).toEqual(Object.keys(flash.state.answerSteps ?? {}));
  });
});

describe('a late wrong-label answer (process)', () => {
  let home = '';
  let transcript = '';
  const config = () => path.join(home, '.config', 'jev', 'config.json');
  const run = (event: string, input: object) =>
    Bun.spawnSync(['bun', HOOK, event], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: config(), JEV_DOWNGRADE: 'off', JEV_ELEVATION: '' }
    });
  const rows = (): Array<Record<string, any>> => {
    const f = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const answerRows = () => rows().filter((r) => r.event === 'elevation_answer');
  const sessionsDir = () => path.join(home, '.config', 'jev', 'antigravity-sessions');
  const state = (conv: string): Record<string, any> => {
    const f = path.join(sessionsDir(), `${conv}.approvals.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  };
  const notice = (conv: string): string => {
    const f = path.join(sessionsDir(), `${conv}.answer-notice.json`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  };
  const stamp = (ms: number) => new Date(Date.now() + ms).toISOString();
  const launch = (conv: string) =>
    JSON.parse(
      run('pre-tool-use', { conversationId: conv, transcriptPath: transcript, lastUserInput: PROMPT, modelName: SESSION, toolCall: { id: 'call_1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } } }).stdout.toString()
    );
  const askedAndAnsweredLate = (conv: string, questionAtMs = -60_000) => {
    fs.writeFileSync(transcript, JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: stamp(questionAtMs), source: 'MODEL', status: 'DONE', content: '', tool_calls: [ASK] }) + '\n');
    expect(run('post-tool-use', { conversationId: conv, transcriptPath: transcript, stepIdx: 7, lastUserInput: PROMPT, modelName: SESSION, toolCall: { id: 'call_ask', ...ASK } }).exitCode).toBe(0);
  };
  const answerRow = (text: string) =>
    fs.appendFileSync(transcript, JSON.stringify({ step_index: 7, type: 'GENERIC', created_at: stamp(0), source: 'MODEL', status: 'DONE', content: `A1: ${text}` }) + '\n');

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pq-label-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' }));
    fs.writeFileSync(config(), JSON.stringify({ defaults: { mode: 'on' } }));
    transcript = path.join(home, 'transcript_full.jsonl');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('via the pending note: one label row, the bad row consumed, the note cleared, the exact-labels line queued, denied with the question', () => {
    askedAndAnsweredLate('l1');
    answerRow('please just run it on pro');

    const out = launch('l1');
    expect(out.decision).toBe('deny');
    expect(out.reason).toContain('[jev-elevate:pro]');
    expect(answerRows()).toMatchObject([{ recorded: false, reason: 'label', answer: null, scope: null, model: 'pro' }]);
    expect(state('l1').pendingQuestions).toBeUndefined();
    expect(state('l1').consumedAnswers).toEqual(['step:7#0']);
    expect(notice('l1')).toContain('Not recorded: the answer was not one of the four exact labels');
    // Not read again.
    expect(launch('l1').decision).toBe('deny');
    expect(answerRows()).toHaveLength(1);
  });

  it('via the denial path (answer step recorded against a denial): the same, one row', () => {
    fs.writeFileSync(transcript, '');
    expect(launch('l2').decision).toBe('deny');
    askedAndAnsweredLate('l2', 1000);
    answerRow('Other: yes please');

    expect(launch('l2').decision).toBe('deny');
    expect(answerRows()).toMatchObject([{ recorded: false, reason: 'label', answer: null }]);
    expect(state('l2').consumedAnswers).toEqual(['step:7#0']);
    expect(notice('l2')).toContain('Not recorded: the answer was not one of the four exact labels');
    expect(launch('l2').decision).toBe('deny');
    expect(answerRows()).toHaveLength(1);
  });
});
