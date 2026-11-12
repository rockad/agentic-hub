/**
 * Parity audit: port of cognitive-engine PR #22 advisor-telemetry-fields.test.ts (5.7) onto agentic-hub Jev 2.3.2.
 *
 * Adaptations: adviceTelemetry is telemetryEvent. #22 remembers two records (LastAdvice, TurnState) through
 * remember/markTurn deps; 2.3.2 saves one TurnState through saveTurn, so the 'remembered advice and turn marker' case
 * checks the keys of the saved state's `rec` (advice) and of the state itself (marker), expecting #22's field names
 * ('by', 'at', 'mode') to be present.
 */
import { describe, it, expect } from 'bun:test';
import { turnId } from '../claude/logic.ts';
import { onPreToolUse, onUserPromptSubmit, telemetryEvent, type HookDeps } from '../claude/hook.ts';
import { deps as userDeps, flashRec, input, memoryTurnStore } from './parity-helpers.ts';

const keys = (o: object) => Object.keys(JSON.parse(JSON.stringify(o))).sort();

async function runPrompt(prompt: string) {
  const logged: Record<string, unknown>[] = [];
  const turn = memoryTurnStore();
  await onUserPromptSubmit(input(prompt), userDeps({ log: (e) => logged.push(e), saveTurn: turn.saveTurn, readTurn: turn.readTurn }));
  return { log: logged[0], state: turn.store.state as any, turn };
}

describe('UserPromptSubmit record', () => {
  it('the decisions-log entry carries turn, tier and recommended_model', async () => {
    const prompt = 'Find where the quota file is written';

    const { log } = await runPrompt(prompt);

    expect(log).toMatchObject({ hook: 'UserPromptSubmit', session_id: 's1', turn: turnId(prompt), tier: 'flash', recommended_model: 'sonnet' });
  });

  it('the telemetry event has modelRecommended, and modelUsed as a deprecated alias with the same value', async () => {
    const { log } = await runPrompt('Find where the quota file is written');

    const event = telemetryEvent(log);

    expect(keys(event)).toEqual(['harness', 'modelRecommended', 'modelUsed', 'quotaStrategy', 'sessionId', 'taskSummary', 'tierRecommended', 'toolOrHook', 'turn']);
    expect(event.modelRecommended).toBe('sonnet');
    expect(event.modelUsed).toBe(event.modelRecommended);
  });

  it('the remembered advice and the turn marker use the names PreToolUse reads', async () => {
    const { state } = await runPrompt('use opus to write the changelog');

    // #22 advice: ['at','by','model','subagent','tier','turn']; marker: ['at','intent','mode','turn'].
    expect(keys(state.rec ?? {})).toEqual(['at', 'by', 'model', 'subagent', 'tier', 'turn'].filter((k) => !['at', 'turn'].includes(k)));
    expect(['at', 'mode', 'turn', 'intent'].every((k) => k in state)).toBe(true);
  });
});

describe('PreToolUse record', () => {
  const advice = { turn: 'abc123abc123', tier: 'flash', model: 'sonnet', subagent: 'Explore' };
  const deps = (log: Record<string, unknown>[]): HookDeps =>
    userDeps({
      dispatch: async () => null,
      readTurn: () => ({ turn: advice.turn, intent: { models: [] }, rec: advice }) as any,
      saveTurn: () => {},
      recentDispatch: () => false,
      log: (e) => log.push(e)
    });

  it('the decisions-log entry has turn, tier, recommended_model, requested_model and preflight_reminder', async () => {
    const log: Record<string, unknown>[] = [];

    await onPreToolUse({ session_id: 's1', tool_name: 'Workflow', tool_input: { model: 'opus' } }, deps(log));

    expect(log[0]).toMatchObject({ hook: 'PreToolUse', turn: advice.turn, tier: 'flash', recommended_model: 'sonnet', requested_model: 'opus', preflight_reminder: true });
    expect('reminded' in log[0]).toBe(false);
    expect('modelUsed' in log[0]).toBe(false);
  });

  it('the telemetry event keeps modelUsed for the requested model and adds modelRecommended and turn', async () => {
    const log: Record<string, unknown>[] = [];
    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'opus', subagent_type: 'Explore' } }, deps(log));

    const event = telemetryEvent(log[0]);

    expect(keys(event)).toEqual(['harness', 'modelRecommended', 'modelUsed', 'sessionId', 'taskSummary', 'tierRecommended', 'toolOrHook', 'turn']);
    expect([event.modelUsed, event.modelRecommended, event.turn, event.tierRecommended]).toEqual(['opus', 'sonnet', advice.turn, 'flash']);
  });

  it('the two records of one turn join on the same turn id', async () => {
    const prompt = 'Find where the quota file is written';
    const { log: promptLog, turn } = await runPrompt(prompt);
    const preLog: Record<string, unknown>[] = [];

    await onPreToolUse(
      { session_id: 's1', tool_name: 'Agent', tool_input: { model: 'haiku' } },
      userDeps({ dispatch: async () => flashRec, readTurn: turn.readTurn, saveTurn: turn.saveTurn, recentDispatch: () => true, log: (e) => preLog.push(e) })
    );

    expect([telemetryEvent(promptLog).turn, telemetryEvent(preLog[0]).turn]).toEqual([turnId(prompt), turnId(prompt)]);
  });
});
