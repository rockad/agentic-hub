/**
 * Fixes from the final review of 2.3.3: intent-parser false positives, the directive's promise about
 * the guard, the model advised under the guard rule, and the edit-verb list.
 */
import { describe, it, expect } from 'bun:test';
import { buildDirective, decideAgentCall, namedModel, parseUserIntent, resolveModel, type Dispatch } from '../claude/logic.ts';
import { taskNeedsEdit } from '../src/core/heuristics.ts';

const flashRec: Dispatch = { subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };
const proRec: Dispatch = { subagent: 'general-purpose', tier: 'pro', model: 'opus', effort: 'high', confidence: 0.8 };
const model = (p: string) => namedModel(parseUserIntent(p));

describe('intent parser: descriptions that are not instructions', () => {
  it.each([
    ['We use haiku for the classifier; refactor the router to match'],
    ['When I switch to sonnet the statusline breaks, fix it'],
    ['Users who use opus see errors. Debug the dialog.'],
    ['The agent should use opus only for judges; implement that rule'],
    ['I need sonnet 4 compatibility in the parser'],
    ['Whenever they run opus the log fills up. Check it.']
  ])('%j names no model', (prompt) => {
    expect(parseUserIntent(prompt).models).toEqual([]);
  });

  it.each([['This is the cheapest fix; implement it'], ['It was the cheapest option, so we kept it. Review the diff.']])('%j gives no cost instruction', (prompt) => {
    expect(parseUserIntent(prompt).cost).toBeUndefined();
  });
});

describe('intent parser: real instructions still match', () => {
  it.each([
    ['use opus', 'opus'],
    ['Use opus.', 'opus'],
    ['run it with sonnet', 'sonnet'],
    ['Delegate to haiku', 'haiku'],
    ['With opus, please review the plan', 'opus'],
    ['run it --model opus', 'opus'],
    ['use claude-opus-5-5', 'opus'],
    ['I want opus for the review', 'opus'],
    ['Fix the parser, then use sonnet for the tests', 'sonnet']
  ])('%j names %s', (prompt, expected) => {
    expect(model(prompt)).toBe(expected);
  });

  it.each([['minimal viable'], ['as cheap as possible'], ['use the cheapest option'], ['Go with the cheapest model for each stream']])('%j is a cost instruction', (prompt) => {
    expect(parseUserIntent(prompt).cost).toBe('minimal');
  });
});

describe('the directive keeps its promise about the Jev guard', () => {
  it('a named model above the session model: the instruction is the approval and the guard really does not ask', () => {
    const intent = parseUserIntent('use opus for the review');
    const text = buildDirective(flashRec, 'claude-sonnet-5-5', 'unknown', intent);

    expect(text).toContain('do not ask separately');
    expect(text).toContain("The user's own instruction is the approval");
    expect(text).not.toContain('shows the user one approval prompt');
    expect(decideAgentCall({ model: 'opus' }, 'claude-sonnet-5-5', intent)).toBeNull();
  });

  // 2.3.4: was "the guard still asks about that one". The one-step cap advised sonnet while the user named
  // opus; a named model covers a weaker one, so the guard passes the advised call (no clamp, no dialog).
  it('when the cap advised another model than the one named, the guard passes the advised one too', () => {
    const intent = parseUserIntent('use opus');
    const lite: Dispatch = { ...flashRec, tier: 'flash_lite', model: 'haiku' };
    const text = buildDirective(lite, 'claude-haiku-5-5', 'unknown', intent);

    expect(text).toContain("The user's own instruction is the approval");
    expect(text).not.toContain('shows the user one approval prompt');
    expect(decideAgentCall({ model: 'sonnet' }, 'claude-haiku-5-5', intent)).toBeNull();
  });
});

// 2.3.4 ships the elevation clamp and keeps the 2.3.3 cap of the advice at the session model (an opus header
// made the assistant call for opus again after a clamp).
describe('a pro rating on a session below opus (5.9, with the 2.3.4 clamp)', () => {
  it('keeps the advised model capped at the session model and still asks', () => {
    const res = resolveModel({ rec: proRec, sessionModel: 'claude-sonnet-5-5' });

    expect([res.tier, res.model, res.source, res.needsApproval]).toEqual(['flash', 'sonnet', 'mode-guard', true]);
  });

  it('caps a haiku session at haiku', () => {
    const res = resolveModel({ rec: proRec, sessionModel: 'claude-haiku-5-5' });

    expect([res.tier, res.model]).toEqual(['flash_lite', 'haiku']);
  });

  it('the head shows the capped model while the text keeps the opus-level rating and the ask', () => {
    const text = buildDirective(proRec, 'claude-sonnet-5-5', 'unknown');

    expect(text).toContain('rule: per the Jev guard');
    expect(text).toContain('tier="flash", model="sonnet"');
    expect(text).toContain('Jev rates this opus-level');
    expect(text).toContain('ask the user before delegating on opus');
  });

  it('an unknown session model is not capped', () => {
    expect(resolveModel({ rec: proRec, sessionModel: null }).model).toBe('opus');
  });
});

describe('taskNeedsEdit keeps the older verbs until needsEdit exists (2.3.5)', () => {
  it.each([['Remove the dead code'], ['Modify the config'], ['Patch the bug'], ['Create a new file'], ['Amend the commit message in the changelog']])('%j is an editing task', (task) => {
    expect(taskNeedsEdit(task)).toBe(true);
  });

  it.each([
    ['Review the design'],
    ['Commit to a direction'],
    ['Outline the approach, no edits'],
    ['Plan it without writing anything'],
    ['Do not update the files, just read them'],
    ['Do not remove anything, just list the candidates'],
    ['Explain how the patch works']
  ])('%j is not', (task) => {
    expect(taskNeedsEdit(task)).toBe(false);
  });
});
