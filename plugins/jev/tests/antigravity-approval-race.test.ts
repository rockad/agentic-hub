import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateAntigravitySubagentCall } from '../antigravity/logic.ts';
import { createAntigravityApprovalStore, type ApprovalStore } from '../antigravity/approvals.ts';

/**
 * Review finding F1 on #72: the pull fallback stored the approval (record) and claimed it (claim) in two separate
 * locked calls and ignored claim's result. A parallel PreToolUse for another pro call could claim the "once" approval
 * between them, and both calls were allowed on one answer. The fix is one locked operation (recordAndClaim); a store
 * without it must still allow only when its claim returns an approval.
 */
const SID = '00000000-0000-4000-8000-0000000000f1';
const T = Date.parse('2026-11-18T10:00:10.000Z');
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
const ASK = {
  name: 'ask_question',
  args: { questions: [{ question: "[jev-elevate:pro] Allow subagent 'expert' to run on pro (session ceiling: flash)?" }] }
};

describe('elevation pull: one answer approves exactly one run, even with a parallel pro call (F1)', () => {
  let dir = '';
  let store: ApprovalStore;
  let transcript = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-approval-race-'));
    store = createAntigravityApprovalStore(path.join(dir, 'sessions'));
    transcript = path.join(dir, 'transcript_full.jsonl');
    fs.writeFileSync(
      transcript,
      [planner(5, [ASK]), generic(6, `${HEADER}A1: Yes, once`)].join('\n') + '\n'
    );
    store.deny(SID, 'pro', T - 5000);
    store.noteAnswerStep?.(SID, 'pro', 6, T - 1000);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const callWith = (approvals: ApprovalStore, typeName: string) =>
    evaluateAntigravitySubagentCall(
      {
        conversationId: SID,
        transcriptPath: transcript,
        modelName: 'gemini-3.8-flash-low',
        lastUserInput: 'p',
        toolCall: { id: `sub-${typeName}`, name: 'invoke_subagent', args: { TypeName: typeName, Model: 'pro' } }
      },
      { approvals, sessionModelOverride: 'gemini-3.8-flash-low', now: () => T }
    );

  it('sequential control: call A is allowed once, call B is denied', () => {
    const a = callWith(store, 'expert');
    expect(a.decision).toBe('allow');
    expect(a.approvalScope).toBe('once');
    expect(a.pullFallback).toBe(true);
    const b = callWith(store, 'other');
    expect(b.decision).toBe('deny');
  });

  it('a second pro call that runs right after the record cannot make both calls allowed', () => {
    let b: ReturnType<typeof callWith> | undefined;
    const runB = () => {
      if (!b) b = callWith(store, 'other');
    };
    // The second call runs at the earliest gap there is: right after the store write that records the approval.
    const racing: ApprovalStore = {
      ...store,
      record: (...args) => {
        const r = store.record(...args);
        runB();
        return r;
      },
      ...(store.recordAndClaim
        ? {
            recordAndClaim: (...args: Parameters<NonNullable<ApprovalStore['recordAndClaim']>>) => {
              const r = store.recordAndClaim!(...args);
              runB();
              return r;
            }
          }
        : {})
    };
    const a = callWith(racing, 'expert');
    expect(b).toBeDefined();
    const allows = [a, b!].filter((d) => d.decision === 'allow');
    expect(allows).toHaveLength(1);
  });

  it('a store without recordAndClaim: a lost claim is a deny with pullFallback claim_lost, not an allow', () => {
    let b: ReturnType<typeof callWith> | undefined;
    const split: ApprovalStore = {
      ...store,
      recordAndClaim: undefined,
      record: (...args) => {
        const r = store.record(...args);
        if (!b) b = callWith(split, 'other');
        return r;
      }
    };
    const a = callWith(split, 'expert');
    expect(b).toBeDefined();
    expect(b!.decision).toBe('allow');
    expect(a.decision).toBe('deny');
    expect(a.pullFallback).toBe('claim_lost');
  });

  it('recordAndClaim stores and claims under one lock: the approval is gone afterwards', () => {
    expect(store.recordAndClaim).toBeDefined();
    const res = store.recordAndClaim!(SID, { model: 'pro', scope: 'once', created_at: T }, ['step:6#0']);
    expect(res.stored).toBe(true);
    expect(res.approval?.scope).toBe('once');
    expect(store.claim(SID, 'pro', T + 1)).toBeNull();
    expect(store.getConsumedAnswers?.(SID)).toEqual(['step:6#0']);
  });

  it('recordAndClaim refuses an answer row that was already consumed, and stores nothing', () => {
    store.recordAndClaim!(SID, { model: 'pro', scope: 'once', created_at: T }, ['step:6#0']);
    store.deny(SID, 'pro', T + 10);
    const again = store.recordAndClaim!(SID, { model: 'pro', scope: 'once', created_at: T + 20 }, ['step:6#0']);
    expect(again).toEqual({ stored: false, approval: null });
    expect(store.claim(SID, 'pro', T + 30)).toBeNull();
  });

  it('recordAndClaim without a pending denial stores nothing', () => {
    const fresh = createAntigravityApprovalStore(path.join(dir, 'sessions2'));
    expect(fresh.recordAndClaim!('s2', { model: 'pro', scope: 'once', created_at: T })).toEqual({ stored: false, approval: null });
  });

  it('a 5min answer pulled through recordAndClaim stays claimable for later pro calls', () => {
    const res = store.recordAndClaim!(SID, { model: 'pro', scope: '5min', created_at: T });
    expect(res.approval?.scope).toBe('5min');
    expect(store.claim(SID, 'pro', T + 1000)?.scope).toBe('5min');
  });
});
