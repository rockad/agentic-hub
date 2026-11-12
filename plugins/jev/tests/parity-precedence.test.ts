/**
 * Parity audit: port of cognitive-engine PR #22 advisor-precedence.test.ts (5.9) onto agentic-hub Jev 2.3.2.
 *
 * Adaptations: #22's Resolution.rule ('instruction'|'guard'|'standing') is Resolution.source
 * ('user-instruction'|'mode-guard'|'default-rule') here; #22's res.advised.model is res.model.
 * #22's appliedRule() is read through resolveModel().source.
 */
import { describe, it, expect } from 'bun:test';
import { buildDirective, parseUserIntent, resolveModel, type Dispatch } from '../claude/logic.ts';
import { onUserPromptSubmit } from '../claude/hook.ts';
import { context, deps, flashRec, input, proRec } from './parity-helpers.ts';

const RULE = { instruction: 'user-instruction', guard: 'mode-guard', standing: 'default-rule' } as const;

describe('precedence: instruction, then guard, then standing rule (5.9)', () => {
  // [prompt, router recommendation, session model, rule, model advised, needs approval]
  const table: Array<[string, Dispatch, string, keyof typeof RULE, string, boolean]> = [
    ['run an opus subagent to wrap findings', flashRec, 'claude-sonnet-5-5', 'instruction', 'opus', false],
    ['choose minimal viable model for each stream', proRec, 'claude-sonnet-5-5', 'instruction', 'sonnet', false],
    // #22 advises opus here. 2.3.2/2.3.3 capped the advice at sonnet; 2.3.4 uncaps it, because the elevation clamp
    // runs an opus call on the session model the first time and asks on a repeat.
    ['write the storage layer design', proRec, 'claude-sonnet-5-5', 'guard', 'opus', true],
    ['write the storage layer design', proRec, 'claude-opus-5-5', 'standing', 'opus', false],
    ['find where the quota file is written', flashRec, 'claude-sonnet-5-5', 'standing', 'sonnet', false]
  ];

  it.each(table)('%j with rec %#: rule %s', (prompt, rec, session, rule, model, needsApproval) => {
    const res = resolveModel({ intent: parseUserIntent(prompt), rec, sessionModel: session });

    expect([res.source, res.model, res.needsApproval]).toEqual([RULE[rule], model, needsApproval]);
  });

  it('keeps the guard rule for an unknown session model', () => {
    expect(resolveModel({ intent: parseUserIntent('x'), rec: proRec, sessionModel: null }).source).toBe('mode-guard');
  });

  it('says in the line which rule applied', () => {
    expect(buildDirective(flashRec, 'claude-sonnet-5-5', 'normal')).toContain('rule: per standing rule');
    expect(buildDirective(proRec, 'claude-sonnet-5-5', 'normal')).toContain('rule: per the Jev guard');
    expect(buildDirective(flashRec, 'claude-sonnet-5-5', 'normal', parseUserIntent('use opus'))).toContain('rule: per your instruction');
  });

  it('an explicit opus request gets no ask text from Jev, only the guard prompt that Claude Code shows', async () => {
    const out = await onUserPromptSubmit(input('use opus for the review of this plan'), deps({ dispatch: async () => flashRec }));

    const text = context(out);
    expect(text).not.toContain('ask the user before delegating');
    expect(text).not.toContain('let the user choose');
    expect(text).toContain('do not ask separately');
  });

  it('no instruction and a pro recommendation gives the ask text', async () => {
    const out = await onUserPromptSubmit(input('design the storage layer for the new service'), deps({ dispatch: async () => proRec }));

    expect(context(out)).toContain('ask the user before delegating on opus');
  });

  it('no instruction and a flash recommendation gives sonnet', async () => {
    const out = await onUserPromptSubmit(input('find where the quota file is written'), deps({ dispatch: async () => flashRec }));

    expect(context(out)).toContain('model="sonnet"');
  });
});
