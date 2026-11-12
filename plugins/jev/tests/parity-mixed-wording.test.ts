/**
 * Parity audit: ports of cognitive-engine PR #22 advisor-mixed-wording.test.ts (5.2) and the one portable case of
 * advisor-ceiling.test.ts onto agentic-hub Jev 2.3.2.
 *
 * Adaptations: #22's resolveModel+buildDirective pair is one buildDirective(rec, session, quota, intent) call here;
 * compareModels/parseModel (models.ts) is replaced by modelRank (rank only, no version).
 *
 * NOT PORTABLE (advisor-ceiling.test.ts): the whole project-ceiling surface, which needs guard.ts and
 * project-config.ts (.jev.json guard.ceiling): effectiveSessionModel (5 cases), 'session opus, ceiling sonnet, use opus',
 * 'session opus, ceiling sonnet, a pro recommendation', 'a ceiling reader that throws', 'resolveModel applies the
 * ceiling to the rule', 'buildDirective takes the ceiling as the limit', projectCeiling (4 cases).
 */
import { describe, it, expect } from 'bun:test';
import { buildDirective, modelRank, parseUserIntent, type Dispatch } from '../claude/logic.ts';
import { onUserPromptSubmit } from '../claude/hook.ts';
import { context, deps, input, proRec } from './parity-helpers.ts';

const NEVER = 'never delegate to a stronger model';

const rec = (tier: Dispatch['tier'], model: Dispatch['model'], subagent = 'Explore'): Dispatch => ({
  subagent,
  tier,
  model,
  effort: 'medium',
  confidence: 0.9
});

function advise(session: string | null, router: Dispatch, prompt = 'Review the storage layer'): string {
  return buildDirective(router, session, 'unknown', parseUserIntent(prompt));
}

describe('one ceiling sentence for any model above the session model', () => {
  it('session haiku and "use sonnet": the guard-prompt sentence, not the hard-ceiling line', () => {
    const text = advise('claude-haiku-5-5', rec('flash_lite', 'haiku'), 'Review the storage layer and use sonnet');

    expect(text).toContain('one approval prompt');
    expect(text).not.toContain(NEVER);
  });

  it('session haiku and a flash (sonnet) recommendation: ask first, no "delegate to sonnet" action', () => {
    const text = advise('claude-haiku-5-5', rec('flash', 'sonnet'));

    expect(text).toContain('hard ceiling, so ask the user before delegating on sonnet');
    expect(text).not.toContain(NEVER);
    expect(text).not.toContain('Delegate to the Explore subagent');
  });

  it('a custom persona above the session model gets the same single sentence', () => {
    const text = advise('claude-haiku-5-5', rec('flash', 'sonnet', 'code-engineer'));

    expect(text).toContain('ask the user before delegating on sonnet');
    expect(text).not.toContain('Agent(subagent_type');
  });

  it('a delegation within the ceiling keeps the ceiling line and the action', () => {
    const text = advise('claude-sonnet-5-5', rec('flash', 'sonnet'));

    expect(text).toContain(NEVER);
    expect(text).toContain('Delegate to the Explore subagent with model "sonnet"');
  });

  it('a direct answer or a free offload is not an escalation', () => {
    expect(advise('claude-haiku-5-5', rec('flash', 'sonnet', 'self'))).toContain('Handle it directly.');
    expect(advise('claude-haiku-5-5', rec('openrouter_free', 'haiku'))).toContain('jev_execute_free');
  });

  const sessions = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
  const recs: Dispatch[] = [rec('flash_lite', 'haiku'), rec('flash', 'sonnet'), rec('pro', 'opus', 'general-purpose')];
  const prompts = ['Review the storage layer', 'Review the storage layer and use sonnet', 'Review the storage layer and use opus'];
  const cases = sessions.flatMap((s) => recs.flatMap((r) => prompts.map((p) => [s, r.tier, p, r] as const)));

  it.each(cases)('session %s, router %s, "%s": never the ceiling line next to a delegation above it', (session, _tier, prompt, router) => {
    const text = advise(session, router, prompt);

    if (!text.includes(NEVER)) return;
    const delegated = [...text.matchAll(/with model "(haiku|sonnet|opus)"/g)].map((m) => modelRank(m[1]));
    const sessionRank = modelRank(session);
    for (const d of delegated) {
      expect(d).not.toBeNull();
      expect(d!).toBeLessThanOrEqual(sessionRank!);
    }
  });
});

describe('advisor-ceiling.test.ts, the portable case', () => {
  it('without a ceiling the same session still allows opus', async () => {
    const out = await onUserPromptSubmit(
      input('Design the storage layer for the new service'),
      deps({ readSessionModel: () => 'claude-opus-5-5', dispatch: async () => proRec })
    );

    expect(context(out)).toContain('allows it');
  });
});
