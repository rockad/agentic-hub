/**
 * Parity audit: port of cognitive-engine PR #22 advisor-preflight.test.ts (5.10, 5.4) onto agentic-hub Jev 2.3.2.
 *
 * Adaptations: #22's PreToolDeps {lastAdvice, turnState, recentDispatch, recentAgentCalls} map onto agentic-hub's HookDeps
 * {readTurn (one TurnState holding intent and rec), recentDispatch(windowMs), saveTurn}. #22's hasRecentDispatch({file,now})
 * is hasRecentDispatch(lines, nowMs, windowMs). #22's preflightReminder() is the PREFLIGHT_REMINDER constant.
 *
 * NOT PORTABLE:
 *  - 'reminds on the third agent call of a session, once' and 'counts the session agent calls in the window ...':
 *    need the recentAgentCalls dep / decisions-log reader; 2.3.2 has no agent-call counter (it reminds on the first Agent call).
 *  - 'answers no for a missing file': file reading is private to hook.ts in 2.3.2 (hasRecentDispatch takes lines).
 */
import { describe, it, expect } from 'bun:test';
import { PREFLIGHT_REMINDER, PREFLIGHT_WINDOW_MS, hasRecentDispatch, turnId } from '../claude/logic.ts';
import { onPreToolUse, onUserPromptSubmit, type HookDeps } from '../claude/hook.ts';
import { STAGE_RUBRIC_TEXT, deps as userDeps, flashRec, input, memoryTurnStore } from './parity-helpers.ts';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const advice = { turn: 'abc123abc123', tier: 'flash', model: 'sonnet', subagent: 'Explore' } as const;

function pre(overrides: Partial<HookDeps> = {}, log: Record<string, unknown>[] = []): HookDeps {
  return {
    readMode: async () => 'on',
    readSessionModel: () => 'claude-sonnet-5-5',
    readQuotaStrategy: async () => 'unknown',
    dispatch: async () => null,
    readTurn: () => ({ turn: advice.turn, intent: { models: [] }, rec: { ...advice } }) as any,
    saveTurn: () => {},
    recentDispatch: () => false,
    log: (e) => log.push(e),
    ...overrides
  };
}

describe('pre-flight reminder (5.10)', () => {
  it('reminds on a Workflow when no dispatch call is recent, and names the tool', async () => {
    const out = await onPreToolUse({ session_id: 's1', tool_name: 'Workflow', tool_input: {} }, pre());

    expect(out?.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(String(out?.hookSpecificOutput.additionalContext)).toContain('jev_batch_dispatch');
  });

  it('names the stage rubric exactly as #22 words it', async () => {
    const out = await onPreToolUse({ session_id: 's1', tool_name: 'Workflow', tool_input: {} }, pre());

    expect(String(out?.hookSpecificOutput.additionalContext)).toContain(STAGE_RUBRIC_TEXT);
  });

  it('gives no reminder when a recent jev_batch_dispatch exists', async () => {
    const out = await onPreToolUse({ session_id: 's1', tool_name: 'Workflow', tool_input: {} }, pre({ recentDispatch: () => true }));

    expect(out).toBeNull();
  });

  it('does not remind on a lone Agent call', async () => {
    const out = await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'haiku' } }, pre());

    expect(out).toBeNull();
  });

  it('never asks, denies or blocks', async () => {
    const out = await onPreToolUse({ session_id: 's1', tool_name: 'Workflow', tool_input: {} }, pre());

    expect(Object.keys(out!.hookSpecificOutput).sort()).toEqual(['additionalContext', 'hookEventName']);
    expect(PREFLIGHT_REMINDER).toContain('not a block');
  });

  it('is silent outside mode on, and for other tools', async () => {
    const off = await onPreToolUse({ session_id: 's1', tool_name: 'Workflow' }, pre({ readMode: async () => 'on-demand' }));
    const bash = await onPreToolUse({ session_id: 's1', tool_name: 'Bash' }, pre());

    expect([off, bash]).toEqual([null, null]);
  });

  it('logs the requested model next to the last recommendation, with the tier and the turn', async () => {
    const log: Record<string, unknown>[] = [];

    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'opus', subagent_type: 'Explore' } }, pre({}, log));

    expect(log[0]).toMatchObject({
      hook: 'PreToolUse',
      event: 'agent_call',
      session_id: 's1',
      turn: 'abc123abc123',
      tier: 'flash',
      recommended_model: 'sonnet',
      requested_model: 'opus',
      subagent_type: 'Explore',
      preflight_reminder: false
    });
  });

  it('logs a null recommendation when no advice was given in the session', async () => {
    const log: Record<string, unknown>[] = [];

    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: {} }, pre({ readTurn: () => null }, log));

    expect(log[0]).toMatchObject({ turn: null, tier: null, recommended_model: null, requested_model: null });
  });

  it('writes the same turn id from both hooks for the same prompt', async () => {
    const prompt = 'Find where the quota file is written';
    const logged: Record<string, unknown>[] = [];
    const turn = memoryTurnStore();
    const shared = { readTurn: turn.readTurn, saveTurn: turn.saveTurn, log: (e: Record<string, unknown>) => logged.push(e) };

    await onUserPromptSubmit(input(prompt), userDeps({ ...shared, dispatch: async () => flashRec }));
    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: {} }, pre(shared));

    expect(logged.map((e) => e.turn)).toEqual([turnId(prompt), turnId(prompt)]);
    expect(logged[1].tier).toBe('flash');
  });
});

describe('reading the logs', () => {
  const NOW = Date.parse('2026-11-09T12:00:00Z');
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const lines = (rows: object[]) => rows.map((r) => JSON.stringify(r));
  // #22 uses a 30 minute window for dispatch lookups; 2.3.2 exports a 10 minute PREFLIGHT_WINDOW_MS. Asserted at 30 minutes (the spec).
  const WINDOW = 30 * 60_000;

  it('finds a recent dispatch from Claude Code in the telemetry file', () => {
    expect(hasRecentDispatch(lines([{ timestamp: ago(5), tool: 'jev_batch_dispatch', harness: 'claude-code' }]), NOW, WINDOW)).toBe(true);
  });

  it('ignores an old dispatch, another harness and another tool', () => {
    const rows = lines([
      { timestamp: ago(45), tool: 'jev_dispatch', harness: 'claude-code' },
      { timestamp: ago(5), tool: 'jev_dispatch', harness: 'antigravity' },
      { timestamp: ago(5), tool: 'jev_judge', harness: 'claude-code' }
    ]);

    expect(hasRecentDispatch(rows, NOW, WINDOW)).toBe(false);
  });

  it('ignores a failed dispatch call: it gave no tiers, so the reminder still applies', () => {
    const rows = lines([
      { timestamp: ago(5), tool: 'jev_dispatch', harness: 'claude-code', status: 'error', error: 'all dispatch tiers failed' },
      { timestamp: ago(4), tool: 'jev_batch_dispatch', harness: 'claude-code', error: 'boom' }
    ]);

    expect(hasRecentDispatch(rows, NOW, WINDOW)).toBe(false);
  });

  it('a failed call does not hide an earlier or later successful one', () => {
    const rows = lines([
      { timestamp: ago(10), tool: 'jev_dispatch', harness: 'claude-code' },
      { timestamp: ago(5), tool: 'jev_dispatch', harness: 'claude-code', status: 'error', error: 'x' }
    ]);

    expect(hasRecentDispatch(rows, NOW, WINDOW)).toBe(true);
  });

  it('2.3.2 window constant is 30 minutes like #22 (DISPATCH_WINDOW_MS)', () => {
    expect(PREFLIGHT_WINDOW_MS).toBe(30 * 60 * 1000);
  });
});

describe('pre-tool-use process', () => {
  it('exits 0 and prints nothing on malformed stdin', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-pre-proc-'));
    try {
      const proc = Bun.spawnSync(['bun', path.join(import.meta.dir, '..', 'claude', 'hook.ts'), 'pre-tool-use'], {
        stdin: new TextEncoder().encode('not json'),
        env: { ...process.env, HOME: tmp, JEV_CONFIG_FILE: path.join(tmp, 'config.json') }
      });

      expect([proc.exitCode, proc.stdout.toString()]).toEqual([0, '']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('stage plan reminder (5.4)', () => {
  const stagedDeps = (turn: ReturnType<typeof memoryTurnStore>): HookDeps =>
    userDeps({
      dispatch: async () => ({ subagent: 'Plan', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 }),
      readTurn: turn.readTurn,
      saveTurn: turn.saveTurn
    });

  // 2.3.5: the stage-plan reminder in the directive describes `kind` and `needsEdit`, which jev_batch_dispatch takes only from 2.3.5 (5.4)
  it.skip('adds the batch-dispatch reminder when the prompt names a workflow or workstreams', async () => {
    const turn = memoryTurnStore();

    const out = await onUserPromptSubmit(input('go ahead with the workstreams in a workflow'), stagedDeps(turn));

    const text = String(out?.hookSpecificOutput.additionalContext);
    expect(text).toContain('call jev_batch_dispatch with one task per stream');
    expect(text).toContain('kind: mechanical | settled-edit | judgement');
    expect(turn.store.state?.staged ?? turn.store.state?.rec?.staged).toBe(true);
  });

  it('does not add it to an ordinary prompt', async () => {
    const turn = memoryTurnStore();

    const out = await onUserPromptSubmit(input('Find where the quota file is written'), stagedDeps(turn));

    expect(String(out?.hookSpecificOutput.additionalContext)).not.toContain('jev_batch_dispatch');
    expect(turn.store.state?.staged).toBeUndefined();
  });

  it('treats a lone Agent call as staged when the last prompt named a workflow', async () => {
    const out = await onPreToolUse(
      { session_id: 's1', tool_name: 'Agent', tool_input: {} },
      pre({ readTurn: () => ({ turn: advice.turn, intent: { models: [] }, rec: { ...advice }, staged: true }) as any })
    );

    expect(String(out?.hookSpecificOutput.additionalContext)).toContain('one task per stream');
  });
});
