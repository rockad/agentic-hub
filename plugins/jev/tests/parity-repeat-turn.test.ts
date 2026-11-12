/**
 * Parity audit: ports of cognitive-engine PR #22 advisor-repeat-turn.test.ts and the staleness half of
 * advisor-intent-table.test.ts (review fixes to 5.1/5.7/5.9) onto agentic-hub Jev 2.3.2.
 *
 * Adaptations: #22 keeps two records (LastAdvice written by the advice step, TurnState marker {turn, mode, intent, at}).
 * 2.3.2 keeps one TurnState {turn, intent, rec?, remindedAt?} behind HookDeps.readTurn/saveTurn, backed here by an
 * in-memory store. #22's user_intent log value {model:'opus'} is {models:['opus']} in 2.3.2's intent shape.
 * #22's markTurn/forgetTurn/remember deps do not exist; a mode flip is checked through the stored state.
 *
 * NOT PORTABLE: currentTurn() (6 cases, 'drops advice and intent that are not this turn's' and 'currentTurn and a repeated
 * prompt'): pure helper of advisor-state.ts, absent here. The 'discards the stored advice and its staged flag when the turn id
 * differs' case needs a separate advice record next to the marker; 2.3.2 has one record. Their behaviour is covered by the
 * end-to-end cases below.
 */
import { describe, it, expect } from 'bun:test';
import { turnId } from '../claude/logic.ts';
import { onPreToolUse, onUserPromptSubmit, type HookDeps } from '../claude/hook.ts';
import { deps, flashRec, input, memoryTurnStore } from './parity-helpers.ts';

function preDeps(turn: ReturnType<typeof memoryTurnStore>, log: Record<string, unknown>[], recentDispatch = false): HookDeps {
  return {
    readMode: async () => 'on',
    readSessionModel: () => 'claude-sonnet-5-5',
    readQuotaStrategy: async () => 'unknown',
    dispatch: async () => null,
    readTurn: turn.readTurn,
    saveTurn: turn.saveTurn,
    recentDispatch: () => recentDispatch,
    log: (e) => log.push(e)
  };
}

describe('PreToolUse ignores a stale turn (intent-table review fixes)', () => {
  const advice = { turn: 'turnaaaaaaaa', tier: 'pro', model: 'opus', subagent: 'general-purpose' };

  it('logs the recommendation and the intent of the current turn', async () => {
    const log: Record<string, unknown>[] = [];
    const turn = memoryTurnStore();
    turn.store.state = { turn: advice.turn, intent: { models: ['opus'] }, rec: advice, mode: 'on' };

    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'opus' } }, preDeps(turn, log, true));

    expect(log[0]).toMatchObject({ turn: advice.turn, tier: 'pro', recommended_model: 'opus', user_intent: { models: ['opus'] } });
  });

  it('discards the stored intent and advice when the mode at PreToolUse differs from the stored mode', async () => {
    const log: Record<string, unknown>[] = [];
    const turn = memoryTurnStore();
    turn.store.state = { turn: advice.turn, intent: { models: ['opus'] }, rec: advice, mode: 'on-demand' };

    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: {} }, preDeps(turn, log, true));

    expect(log[0]).toMatchObject({ turn: null, tier: null, recommended_model: null, user_intent: null });
  });
});

describe('UserPromptSubmit stores the turn marker before anything can return early', () => {
  it('stores the turn id, the mode and the intent (no prompt text) when Jev is unreachable', async () => {
    const prompt = 'use opus to write the changelog entry';
    const turn = memoryTurnStore();

    await onUserPromptSubmit(input(prompt), deps({ dispatch: async () => null, saveTurn: turn.saveTurn }));

    expect(turn.store.state).toMatchObject({ turn: turnId(prompt), mode: 'on', intent: { models: ['opus'] } });
    expect(JSON.stringify(turn.store.state)).not.toContain('changelog');
  });

  it("end to end: a turn that got no advice does not inherit the previous turn's advice or intent", async () => {
    const turn = memoryTurnStore();
    await onUserPromptSubmit(input('use opus for the workflow with three workstreams'), deps({ readTurn: turn.readTurn, saveTurn: turn.saveTurn }));
    // The next real user turn: Jev is unreachable, so no advice is written for it.
    await onUserPromptSubmit(input('carry on with the next one'), deps({ dispatch: async () => null, readTurn: turn.readTurn, saveTurn: turn.saveTurn }));
    const log: Record<string, unknown>[] = [];

    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'haiku' } }, preDeps(turn, log, true));

    expect(log[0]).toMatchObject({ turn: turnId('carry on with the next one'), tier: null, recommended_model: null, user_intent: { models: [] } });
  });

  it('a host-injected task notification keeps the marker of the prompt it belongs to', async () => {
    const prompt = 'use sonnet to run the workflow';
    const turn = memoryTurnStore();
    await onUserPromptSubmit(input(prompt), deps({ readTurn: turn.readTurn, saveTurn: turn.saveTurn }));

    await onUserPromptSubmit(input('<task-notification><id>a3</id></task-notification>'), deps({ readTurn: turn.readTurn, saveTurn: turn.saveTurn }));

    expect(turn.store.state?.turn).toBe(turnId(prompt));
  });

  it('a turn with Jev off drops the marker, so a later flip back to on finds no stale intent', async () => {
    const turn = memoryTurnStore();
    const cleared: string[] = [];
    await onUserPromptSubmit(input('use opus to write the changelog'), deps({ saveTurn: turn.saveTurn }));
    expect(turn.store.state).not.toBeNull();

    await onUserPromptSubmit(
      input('something else entirely'),
      deps({ readMode: async () => 'off', saveTurn: turn.saveTurn, forgetTurn: (s: string | null) => (cleared.push(String(s)), (turn.store.state = null)) } as Partial<HookDeps>)
    );

    expect(turn.store.state).toBeNull();
  });
});

describe('a repeated prompt without advice does not inherit the previous advice (end to end, advisor-repeat-turn)', () => {
  const prompt = 'continue with the workflow and the workstreams';

  it('turn 1 gets staged advice; the same words in turn 2 get none, so PreToolUse sees neither advice nor staged flag', async () => {
    const turn = memoryTurnStore();
    await onUserPromptSubmit(input(prompt), deps({ dispatch: async () => ({ ...flashRec, subagent: 'general-purpose' }), readTurn: turn.readTurn, saveTurn: turn.saveTurn }));
    expect((turn.store.state as any)?.staged ?? (turn.store.state as any)?.rec?.staged).toBe(true);
    // Turn 2: the same prompt, but Jev is unreachable, so no advice is written for it.
    await onUserPromptSubmit(input(prompt), deps({ dispatch: async () => null, readTurn: turn.readTurn, saveTurn: turn.saveTurn }));
    const log: Record<string, unknown>[] = [];

    const out = await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'haiku' } }, preDeps(turn, log));

    expect(log[0]).toMatchObject({ tier: null, recommended_model: null, preflight_reminder: false });
    expect(out).toBeNull();
  });

  it('isolated staleness check (extra): same as above with a recent dispatch, so only the stale advice could show', async () => {
    const turn = memoryTurnStore();
    await onUserPromptSubmit(input(prompt), deps({ dispatch: async () => ({ ...flashRec, subagent: 'general-purpose' }), readTurn: turn.readTurn, saveTurn: turn.saveTurn }));
    await onUserPromptSubmit(input(prompt), deps({ dispatch: async () => null, readTurn: turn.readTurn, saveTurn: turn.saveTurn }));
    const log: Record<string, unknown>[] = [];

    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'haiku' } }, preDeps(turn, log, true));

    expect(log[0]).toMatchObject({ tier: null, recommended_model: null });
  });

  it('the same turn still sees its own advice', async () => {
    const turn = memoryTurnStore();
    await onUserPromptSubmit(input(prompt), deps({ dispatch: async () => ({ ...flashRec, subagent: 'general-purpose' }), readTurn: turn.readTurn, saveTurn: turn.saveTurn }));
    const log: Record<string, unknown>[] = [];

    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'haiku' } }, preDeps(turn, log));

    expect(log[0]).toMatchObject({ tier: 'flash', recommended_model: 'sonnet', preflight_reminder: true });
  });
});
