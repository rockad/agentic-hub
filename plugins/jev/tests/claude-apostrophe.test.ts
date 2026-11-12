/**
 * A typographic apostrophe must not turn a negation into an approval ("Don’t use opus" is the same
 * negation as "Don't use opus"), in the intent parser and in the edit-verb rule.
 */
import { describe, it, expect } from 'bun:test';
import { onUserPromptSubmit, onPreToolUse, type HookDeps } from '../claude/hook.ts';
import { parseUserIntent, type Dispatch } from '../claude/logic.ts';
import { taskNeedsEdit } from '../src/core/heuristics.ts';

const U2019 = '’';
const U2018 = '‘';
const flashRec: Dispatch = { subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };

describe('parseUserIntent', () => {
  it.each([
    ['ASCII apostrophe', "Don't use opus for this, refactor the parser."],
    ['U+2019 apostrophe', `Don${U2019}t use opus for this, refactor the parser.`],
    ['U+2018 used as an apostrophe', `Don${U2018}t use opus for this, refactor the parser.`],
    ['"do not"', 'Do not use opus for this, refactor the parser.']
  ])('%s: no model is found', (_name, prompt) => {
    expect(parseUserIntent(prompt).models).toEqual([]);
  });

  it('a positive instruction next to a curly apostrophe is still an instruction', () => {
    expect(parseUserIntent(`It${U2019}s a big change, use opus for the review.`).models).toEqual(['opus']);
  });
});

describe('the guard after a curly-apostrophe negation', () => {
  it('stores an empty intent and asks on every call (never an approval)', async () => {
    const saved: any[] = [];
    const turns = new Map<string, any>();
    const d: HookDeps = {
      readMode: async () => 'on',
      readSessionModel: () => 'claude-sonnet-5',
      readQuotaStrategy: async () => 'unknown',
      dispatch: async () => flashRec,
      log: () => {},
      env: {},
      readTurn: (s) => turns.get(s ?? '') ?? null,
      saveTurn: (s, st) => void (saved.push(st), turns.set(s ?? '', st))
    };
    await onUserPromptSubmit({ session_id: 's1', prompt_id: 'p1', prompt: `Don${U2019}t use opus for this, refactor the parser.` }, d);
    const call = { session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', tool_input: { model: 'opus', prompt: 'Refactor the parser', description: 'parser' } };

    const first = (await onPreToolUse(call, d))?.hookSpecificOutput as Record<string, any>;
    const second = (await onPreToolUse(call, d))?.hookSpecificOutput as Record<string, any>;

    expect(saved.at(-1).intent.models).toEqual([]);
    expect([first.permissionDecision, second.permissionDecision]).toEqual(['ask', 'ask']);
    expect(first).not.toHaveProperty('updatedInput');
  });
});

describe('taskNeedsEdit', () => {
  it.each([
    ['ASCII', "Don't update the files, just read them"],
    ['U+2019', `Don${U2019}t update the files, just read them`],
    ['U+2018', `Don${U2018}t update the files, just read them`]
  ])('%s: "don’t update" is a negated edit verb', (_name, task) => {
    expect(taskNeedsEdit(task)).toBe(false);
  });

  it('an un-negated edit verb still counts next to a curly apostrophe', () => {
    expect(taskNeedsEdit(`It${U2019}s broken, update the files`)).toBe(true);
  });
});
