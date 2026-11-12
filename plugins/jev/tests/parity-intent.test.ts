/**
 * Parity audit: ports of cognitive-engine PR #22 advisor-intent.test.ts, advisor-intent-false-positives.test.ts
 * and advisor-intent-table.test.ts (items 5.1, 5.2 and the 5.1 review fixes) onto agentic-hub Jev 2.3.2.
 *
 * Adaptations: #22's parseUserIntent returns {model, cost, phrase}; agentic-hub returns {models[], cost}, read
 * through modelOf()/costOf(). #22's applyUserIntent() has no equivalent; resolveModel() is the nearest function.
 * Session model is "claude-sonnet-5-5".
 *
 * NOT PORTABLE: 'measures the step from the router tier, not from a tier an earlier instruction set'
 * (applyUserIntent chaining; resolveModel is single-pass); the ('capped' flag) column of the cap table
 * (no `asked` field on Resolution).
 */
import { describe, it, expect } from 'bun:test';
import { buildDirective, resolveModel, parseUserIntent, type Dispatch } from '../claude/logic.ts';
import { onUserPromptSubmit } from '../claude/hook.ts';
import { SESSION, context, costOf, deps, flashRec, input, liteRec, modelOf, proRec } from './parity-helpers.ts';

const resolve = (rec: Pick<Dispatch, 'tier'>, intent: ReturnType<typeof parseUserIntent>) =>
  resolveModel({ intent, rec, sessionModel: SESSION });

describe('parseUserIntent (5.1)', () => {
  it.each([
    ['run an opus subagent to wrap findings', 'opus'],
    ['use opus for the review', 'opus'],
    ['please use the sonnet model here', 'sonnet'],
    ['spawn a haiku agent for the checklist', 'haiku'],
    ['go with haiku', 'haiku'],
    ['delegate this to opus', 'opus']
  ])('reads an explicit model from %j', (prompt, model) => {
    expect(modelOf(prompt)).toBe(model);
  });

  it.each([
    ['go ahead with the workstreams, choose minimal viable model for each'],
    ['choos minimal viable model for each'],
    ['use the cheapest option'],
    ['as cheap as possible please']
  ])('reads a minimal-cost instruction from %j', (prompt) => {
    expect(costOf(prompt)).toBe('minimal');
  });

  it.each([
    ['sonnet is cheaper than opus for this kind of work'],
    ['compare the numbers with opus and sonnet'],
    ['the opus subagent finished its run'],
    ['do not use opus here'],
    ['never use opus for this'],
    ['use opus or sonnet, whichever is faster'],
    ['not the cheapest, the best one']
  ])('reads nothing from prose that only mentions a model: %j', (prompt) => {
    expect([modelOf(prompt), costOf(prompt)]).toEqual([undefined, undefined]);
  });

  it('records the matched words', () => {
    expect((parseUserIntent('run an opus subagent') as any).phrase).toBe('run an opus');
  });

  it('only scans the start of a long prompt', () => {
    const prompt = `${'x '.repeat(1100)} use opus`;

    expect([modelOf(prompt), costOf(prompt)]).toEqual([undefined, undefined]);
  });
});

describe('applyUserIntent (5.1), via resolveModel', () => {
  it('lets an explicit model override the tier', () => {
    const out = resolve(flashRec, parseUserIntent('use opus'));

    expect([out.tier, out.model, out.source]).toEqual(['pro', 'opus', 'user-instruction']);
  });

  it('lowers the tier by one step for a minimal cost request', () => {
    const out = resolve(proRec, parseUserIntent('cheapest'));

    expect([out.tier, out.model]).toEqual(['flash', 'sonnet']);
  });

  it('never lowers below flash_lite', () => {
    const out = resolve(liteRec, parseUserIntent('cheapest'));

    expect([out.tier, out.model]).toEqual(['flash_lite', 'haiku']);
  });

  it('lets the model win over a minimal cost request in the same prompt', () => {
    const out = resolve(proRec, parseUserIntent('use sonnet and the cheapest option'));

    expect([out.tier, out.model, out.source]).toEqual(['flash', 'sonnet', 'user-instruction']);
  });
});

describe('buildDirective ceiling sentence (5.2)', () => {
  it('prints the ceiling once and no second ask on the pro tier', () => {
    const directive = buildDirective(proRec, SESSION, 'normal');

    expect(directive.split('hard ceiling')).toHaveLength(2);
    expect(directive).not.toContain('present the cheaper');
    expect(directive).toContain('ask the user before delegating on opus');
    expect(directive).toContain('let the user choose');
  });

  it('prints no ask when the session is already on opus', () => {
    const directive = buildDirective(proRec, 'claude-opus-5-5', 'normal');

    expect(directive).not.toContain('ask the user');
    expect(directive).toContain('allows it');
  });

  it('keeps the plain ceiling sentence below the pro tier', () => {
    const directive = buildDirective(flashRec, SESSION, 'normal');

    expect(directive).toContain(`"${SESSION}" is the hard ceiling`);
  });
});

describe('onUserPromptSubmit with an explicit instruction (5.1)', () => {
  it('names opus and the explicit request when the user asked for it, with no ask text', async () => {
    const out = await onUserPromptSubmit(input('run an opus subagent to wrap findings'), deps({ dispatch: async () => flashRec }));

    const text = context(out);
    expect(text).toContain('model="opus"');
    expect(text).toContain('explicit user request');
    expect(text).not.toContain('let the user choose');
    expect(text).toContain('do not ask separately');
  });

  it('gives sonnet for "minimal viable" against a pro recommendation', async () => {
    const out = await onUserPromptSubmit(
      input('go ahead with the workstreams, choose minimal viable model for each'),
      deps({ dispatch: async () => proRec })
    );

    const text = context(out);
    expect(text).toContain('model="sonnet"');
    expect(text).toContain('lowered the tier from pro to flash');
  });

  it('leaves the router recommendation alone when the prompt has no instruction', async () => {
    const out = await onUserPromptSubmit(input('Find where the quota file is written'), deps());

    expect(context(out)).not.toContain('explicit user request');
  });

  it('logs the instruction without the prompt text', async () => {
    const logged: Record<string, unknown>[] = [];

    await onUserPromptSubmit(input('run an opus subagent to wrap findings'), deps({ log: (e) => logged.push(e) }));

    expect(logged[0]).toMatchObject({ by: 'instruction-model', routerTier: 'flash', tier: 'pro' });
    expect(JSON.stringify(logged)).not.toContain('wrap findings');
  });
});

// ── advisor-intent-false-positives.test.ts ──────────────────────────────────────────────────────

describe('the parser ignores a model that is not an instruction (table)', () => {
  it.each([
    ['inside a quotation, then a question', 'The docs say: "use opus for hard problems". What does that mean'],
    ['inside a single-quoted string', "The config has 'use opus' somewhere in it"],
    ['inside a curly-quoted string', 'The docs say “use opus for hard problems” and nothing else'],
    ['a question that ends in ?', 'Should I use opus for this?'],
    ['a polite request phrased as a question (a ? sentence never counts)', 'Can you use opus for this?'],
    ['a supposition starting with if', 'if we need opus, tell me first'],
    ['a how-question', 'How do I use opus for the review'],
    ['inside an inline code span, in a question', 'Why does `use haiku` appear in the config?'],
    ['inside an inline code span', 'The config line `use opus` is old'],
    ['inside a fenced code block', 'Fix this config:\n```\nuse opus\n```\nand tell me what changed'],
    ['inside an unterminated fence', 'Here is the log:\n```\nuse opus'],
    ['a pasted log line from the agent', 'agent: I will use opus to analyse'],
    ['a first-person statement of intent', "I'll use opus to analyse the diff"],
    ['a quoted reply line', '> use opus for the review\nwhat do you think'],
    ['a flag in prose about the flag', 'What does the --model opus flag do'],
    ['a flag without an imperative verb', 'The default is --model opus in that script'],
    ['a poem request', 'we need a haiku about spring'],
    ['a poem format', 'use haiku format for the release notes'],
    ['a poet', 'pick a sonnet by Shakespeare'],
    ['a numbered sonnet', 'use sonnet 130 as the example'],
    ['two different models for two jobs (ambiguous)', 'use sonnet for the tests and opus for the review'],
    ['a non-English verb stays a safe no-match', 'Используй opus']
  ])('%s: %j gives no model', (_name, prompt) => {
    expect(modelOf(prompt)).toBeUndefined();
  });

  it.each([
    ['a minimal viable product', 'Write a minimal viable product spec'],
    ['the MVP abbreviation', 'Build an MVP of the dashboard'],
    ['a question about the cheapest model', 'What is the cheapest model for this?'],
    ['quoted', 'The ticket says "choose minimal viable model" and I disagree'],
    ['in a code span', 'Is `cheapest` a valid value in the config']
  ])('%s: %j gives no cost instruction', (_name, prompt) => {
    expect(costOf(prompt)).toBeUndefined();
  });
});

describe('the parser still reads a real instruction (table)', () => {
  it.each([
    ['a full model id', 'use claude-opus-5-5', 'opus'],
    ['a full model id with a date suffix', 'run it with claude-sonnet-5-5-20261028', 'sonnet'],
    ['the flag in an imperative clause', 'run with --model opus', 'opus'],
    ['the flag with an equals sign', 'start it with --model=haiku', 'haiku'],
    ['upper case', 'USE OPUS', 'opus'],
    ['a version after the name', 'use sonnet 5.5 for the edits', 'sonnet'],
    ['a second line', 'Fix the parser.\nuse haiku for the rename', 'haiku'],
    ['a quote earlier in the prompt', 'The ticket says "fix it". Use sonnet for it', 'sonnet'],
    ['an apostrophe is not a quote', "Don't overthink it, use sonnet; it's fine", 'sonnet'],
    ['a replaced model', 'use sonnet instead of opus', 'sonnet'],
    ['a preference over another', 'use opus over sonnet', 'opus'],
    ['a rejected alternative', 'use sonnet, not opus', 'sonnet']
  ])('%s: %j names %s', (_name, prompt, model) => {
    expect(modelOf(prompt)).toBe(model);
  });

  it('a real cost instruction after a quotation is kept', () => {
    expect(costOf('The ticket says "fast". Choose minimal viable model for each')).toBe('minimal');
  });
});

// ── advisor-intent-table.test.ts (parser part) ──────────────────────────────────────────────────

describe('the explicit-instruction parser reads imperatives only (table)', () => {
  it.each([
    ['use opus', 'opus'],
    ['Use sonnet for this', 'sonnet'],
    ['run an opus subagent', 'opus'],
    ['launch a haiku agent', 'haiku'],
    ['with sonnet', 'sonnet'],
    ['With sonnet, please fix the tests', 'sonnet'],
    ['Fix the parser. With haiku.', 'haiku'],
    ['run it with sonnet', 'sonnet'],
    ['go with haiku', 'haiku'],
    ['delegate this to opus', 'opus']
  ])('%j names %s', (prompt, model) => {
    expect(modelOf(prompt)).toBe(model);
  });

  it.each([['minimal viable'], ['choose minimal viable model for each'], ['cheapest'], ['use the cheapest option'], ['as cheap as possible']])(
    '%j is a minimal-cost instruction',
    (prompt) => {
      expect(costOf(prompt)).toBe('minimal');
    }
  );

  it.each([
    ['do not use opus'],
    ["don't use opus here"],
    ['never use opus'],
    ['not opus'],
    ['instead of opus'],
    ['without opus'],
    ['rather than use opus'],
    ['I have no idea about cost, so do not use opus'],
    ['compare with opus'],
    ['we compared results with sonnet yesterday'],
    ['the opus subagent finished'],
    ['opus is the strongest model'],
    ['sonnet or opus, whichever is available'],
    ['use opus or sonnet'],
    ['not the cheapest, the best one'],
    ['do not choose the cheapest']
  ])('%j gives no model instruction', (prompt) => {
    expect(modelOf(prompt)).toBeUndefined();
  });

  it('reads the model that is asked for, not the one it replaces', () => {
    expect(modelOf('use sonnet instead of opus')).toBe('sonnet');
  });

  it.each([['not the cheapest, the best one'], ['do not choose the cheapest'], ['without the cheapest option']])('%j gives no cost instruction', (prompt) => {
    expect(costOf(prompt)).toBeUndefined();
  });

  it('keeps a negator in an earlier clause from cancelling a later instruction', () => {
    expect(modelOf('There is no time left, so use opus')).toBe('opus');
  });

  it('scans only the first 1500 characters', () => {
    const filler = 'x '.repeat(740);
    const inside = modelOf(`use opus ${filler}`);
    const outside = modelOf(`${filler}${'y '.repeat(10)} use opus`);

    expect([inside, outside]).toEqual(['opus', undefined]);
  });
});

describe('the effect is capped at one tier step from the recommendation (table)', () => {
  const modelOfTier = { openrouter_free: 'haiku', flash_lite: 'haiku', flash: 'sonnet', pro: 'opus' } as const;
  it.each([
    ['flash', 'opus', 'pro', 'opus'],
    ['flash', 'haiku', 'flash_lite', 'haiku'],
    ['flash', 'sonnet', 'flash', 'sonnet'],
    ['flash_lite', 'opus', 'flash', 'sonnet'],
    ['openrouter_free', 'sonnet', 'flash_lite', 'haiku'],
    ['openrouter_free', 'opus', 'flash_lite', 'haiku'],
    ['pro', 'haiku', 'flash', 'sonnet'],
    ['pro', 'opus', 'pro', 'opus']
  ] as const)('router %s, user asks for %s: tier %s, model %s', (routerTier, asked, tier, model) => {
    const out = resolve({ tier: routerTier }, parseUserIntent(`use ${asked}`));

    expect([out.tier, out.model]).toEqual([tier, model]);
    expect(modelOfTier[routerTier]).toBeDefined();
  });

  it('a minimal-cost request lowers one step and never below flash_lite', () => {
    const tiers = (['pro', 'flash', 'flash_lite'] as const).map((t) => resolve({ tier: t }, parseUserIntent('cheapest')).tier);

    expect(tiers).toEqual(['flash', 'flash_lite', 'flash_lite']);
  });

  it('says in the directive that the cap held the tier short of the named model', () => {
    const text = buildDirective(liteRec, SESSION, 'unknown', parseUserIntent('use opus'));

    expect(text).toContain('You asked for opus');
    expect(text).toContain('at most one tier step');
    expect(text).toContain('model "sonnet"');
    expect(text).not.toContain('do not ask separately');
  });
});
