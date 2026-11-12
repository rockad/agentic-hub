import { describe, it, expect } from 'bun:test';
import {
  parseUserIntent,
  namedModel,
  lowerTier,
  resolveModel,
  buildDirective,
  decideAgentCall,
  parseDispatch,
  dropDisplayNameAliases,
  turnId,
  hasRecentDispatch,
  preflightReminder,
  PREFLIGHT_REMINDER,
  NO_INTENT,
  CLAUDE_SUBAGENT_CRITERIA,
  type Dispatch,
  type TurnState,
  type UserIntent
} from '../claude/logic.ts';
import { onUserPromptSubmit, onPreToolUse, telemetryEvent, type HookDeps } from '../claude/hook.ts';

const flashRec: Dispatch = { subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };
const proRec: Dispatch = { subagent: 'general-purpose', tier: 'pro', model: 'opus', effort: 'high', confidence: 0.8 };

function deps(overrides: Partial<HookDeps> = {}): HookDeps {
  return {
    readMode: async () => 'on',
    readSessionModel: () => 'claude-sonnet-5',
    readQuotaStrategy: async () => 'unknown',
    dispatch: async () => flashRec,
    log: () => {},
    ...overrides
  };
}

/** In-memory stand-in for the per-session turn file. */
function turnStore(): Pick<HookDeps, 'readTurn' | 'saveTurn'> & { saved: TurnState[] } {
  const saved: TurnState[] = [];
  return {
    saved,
    readTurn: () => saved[saved.length - 1] ?? null,
    saveTurn: (_id, state) => {
      saved.push(state);
    }
  };
}

describe('parseUserIntent (5.1)', () => {
  it('reads a named model as a whole word', () => {
    const intent = parseUserIntent('run an opus subagent to wrap findings');

    expect(intent.models).toEqual(['opus']);
  });

  it('does not read a model out of a longer word', () => {
    const intent = parseUserIntent('the sonnets and the opuses are fine');

    expect(intent.models).toEqual([]);
  });

  it('reads "minimal viable model" as a cost intent', () => {
    const intent = parseUserIntent('go ahead with the workstreams in a workflow, choos minimal viable model for each');

    expect(intent.cost).toBe('minimal');
  });

  it('reads "cheapest" and "cheap model" as a cost intent', () => {
    expect([parseUserIntent('use the cheapest option').cost, parseUserIntent('a cheap model will do').cost]).toEqual(['minimal', 'minimal']);
  });

  it('returns no intent for a plain prompt', () => {
    const intent = parseUserIntent('Find where the quota file is written');

    expect(intent).toEqual({ models: [] });
  });

  it('ignores a task notification that mentions a model', () => {
    const intent = parseUserIntent('<task-notification>The opus agent finished</task-notification>');

    expect(intent.models).toEqual([]);
  });

  it('ignores a model named far down a pasted block', () => {
    const intent = parseUserIntent('Summarise this table.\n' + 'x'.repeat(2000) + '\nWS1 opus');

    expect(intent.models).toEqual([]);
  });

  it('treats two named models as a split, not an instruction', () => {
    const intent = parseUserIntent('opus for WS1, sonnet for the rest');

    expect(namedModel(intent)).toBeNull();
  });

  it('does not read a negated model as a request for it', () => {
    const models = [
      "don't use opus for this",
      'do not run an opus agent here',
      'avoid opus, it is a small edit',
      'no opus subagents please'
    ].map((p) => parseUserIntent(p).models);

    expect(models).toEqual([[], [], [], []]);
  });

  it('keeps the requested model when another one is negated', () => {
    const intent = parseUserIntent('use sonnet, not opus');

    expect(namedModel(intent)).toBe('sonnet');
  });

  it('end to end: "don\'t use opus" does not lift the opus ask', () => {
    const verdict = decideAgentCall({ model: 'opus', prompt: 'Wrap the findings' }, 'claude-sonnet-5', parseUserIntent("don't use opus, wrap the findings"));

    expect(verdict?.decision).toBe('ask');
  });
});

describe('resolveModel precedence (5.9): instruction, then mode guard, then default rule', () => {
  const cases: Array<{ name: string; intent?: UserIntent; rec: Dispatch; session: string | null; tier: string; model: string; source: string; approval: boolean }> = [
    { name: 'named opus beats the guard', intent: { models: ['opus'] }, rec: flashRec, session: 'claude-sonnet-5', tier: 'pro', model: 'opus', source: 'user-instruction', approval: false },
    // 2.3.3: a named model moves the tier at most one step from the router's (pro to flash, not to flash_lite).
    { name: 'named haiku moves a pro recommendation one step, to sonnet', intent: { models: ['haiku'] }, rec: proRec, session: 'claude-opus-5', tier: 'flash', model: 'sonnet', source: 'user-instruction', approval: false },
    { name: 'minimal viable lowers pro to sonnet', intent: { models: [], cost: 'minimal' }, rec: proRec, session: 'claude-opus-5', tier: 'flash', model: 'sonnet', source: 'user-instruction', approval: false },
    { name: 'minimal viable lowers flash to haiku', intent: { models: [], cost: 'minimal' }, rec: flashRec, session: 'claude-sonnet-5', tier: 'flash_lite', model: 'haiku', source: 'user-instruction', approval: false },
    { name: 'minimal viable never goes below flash_lite', intent: { models: [], cost: 'minimal' }, rec: { ...flashRec, tier: 'flash_lite', model: 'haiku' }, session: null, tier: 'flash_lite', model: 'haiku', source: 'user-instruction', approval: false },
    // 2.3.3 (5.9): on an opus session the pro tier is within the ceiling, so it is the standing rule and needs no approval.
    { name: 'no instruction, pro, opus session: standing rule, no approval', intent: NO_INTENT, rec: proRec, session: 'claude-opus-5', tier: 'pro', model: 'opus', source: 'default-rule', approval: false },
    // 2.3.3 (5.9): below opus the guard rule advises opus and asks, as cognitive-engine #22 does; it no longer caps the advice.
    { name: 'no instruction, pro, sonnet session: guard rule, opus advised with approval', intent: NO_INTENT, rec: proRec, session: 'claude-sonnet-5', tier: 'pro', model: 'opus', source: 'mode-guard', approval: true },
    { name: 'no instruction, flash: sonnet by the default rule', intent: NO_INTENT, rec: flashRec, session: 'claude-sonnet-5', tier: 'flash', model: 'sonnet', source: 'default-rule', approval: false }
  ];

  for (const c of cases) {
    it(c.name, () => {
      const res = resolveModel({ intent: c.intent, rec: c.rec, sessionModel: c.session });

      expect([res.tier, res.model, res.source, res.needsApproval]).toEqual([c.tier, c.model, c.source, c.approval]);
    });
  }

  it('lowers tiers one step with a floor at flash_lite and keeps the free tier', () => {
    expect([lowerTier('pro'), lowerTier('flash'), lowerTier('flash_lite'), lowerTier('openrouter_free')]).toEqual(['flash', 'flash_lite', 'flash_lite', 'openrouter_free']);
  });
});

describe('buildDirective with an explicit user instruction (5.1)', () => {
  it('names opus and the explicit user request when the user asked for opus', () => {
    const directive = buildDirective(flashRec, 'claude-sonnet-5', 'normal', { models: ['opus'] });

    expect(directive).toContain('You asked for opus (explicit user request: "opus")');
    expect(directive).toContain('model="opus"');
  });

  it('does not ask the user to choose when the user already chose opus', () => {
    const directive = buildDirective(proRec, 'claude-sonnet-5', 'normal', { models: ['opus'] });

    expect(directive.includes('let the user choose') || directive.includes('hard ceiling')).toBe(false);
  });

  it('gives sonnet for a pro recommendation under "minimal viable model"', () => {
    const directive = buildDirective(proRec, 'claude-opus-5', 'normal', { models: [], cost: 'minimal' });

    expect(directive).toContain('model="sonnet"');
  });
});

describe('Claude adapter ceiling (5.2): one sentence, consistent with the tier', () => {
  it('under a sonnet session a pro recommendation names the ceiling once', () => {
    const directive = buildDirective(proRec, 'claude-sonnet-5', 'normal');

    expect(directive.split('is the hard ceiling').length - 1).toBe(1);
  });

  it('does not say "present the cheaper" when it has capped the tier', () => {
    const directive = buildDirective(proRec, 'claude-sonnet-5', 'normal');

    expect(directive).not.toContain('present the cheaper');
  });

  it('reports the pro tier and opus, with the ask, under a sonnet session (2.3.3: no longer capped)', () => {
    const directive = buildDirective(proRec, 'claude-sonnet-5', 'normal');

    expect(directive).toContain('tier="pro", model="opus"');
    expect(directive).toContain('ask the user before delegating on opus');
  });

  it('keeps "let the user choose" when the session is unknown', () => {
    const directive = buildDirective(proRec, null, 'normal');

    expect(directive).toContain('let the user choose');
  });

  it('says the session "allows it" and does not ask when the session is already opus (2.3.3)', () => {
    const directive = buildDirective(proRec, 'claude-opus-5', 'normal');

    expect(directive).toContain('allows it');
    expect(directive).not.toContain('let the user choose');
  });
});

describe('PreToolUse guard honours the current turn\'s instruction (5.1, 5.9)', () => {
  it('does not ask for opus when the user named opus in the prompt', () => {
    const call = { model: 'opus', prompt: 'Wrap the findings in the docs' };

    const verdict = decideAgentCall(call, 'claude-sonnet-5', { models: ['opus'] });

    expect(verdict).toBeNull();
  });

  it('still asks for opus when the user named only sonnet', () => {
    const call = { model: 'opus', prompt: 'Wrap the findings in the docs' };

    const verdict = decideAgentCall(call, 'claude-sonnet-5', { models: ['sonnet'] });

    expect(verdict?.decision).toBe('ask');
  });

  it('end to end: a pro recommendation with no instruction does not ask for a call at the session model', async () => {
    const store = turnStore();
    const d = deps({ ...store, dispatch: async () => proRec });
    await onUserPromptSubmit({ session_id: 's1', prompt: 'Redesign the auth flow and wire the new store' }, d);

    const out = await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'sonnet', prompt: 'Redesign the auth flow' } }, d);

    expect(out).toBeNull();
  });

  it('end to end: a prompt naming opus stores the intent and the Agent call is not asked', async () => {
    const store = turnStore();
    const d = deps({ ...store });
    await onUserPromptSubmit({ session_id: 's1', prompt: 'run an opus subagent to wrap findings, then commit' }, d);

    const out = await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'opus', prompt: 'Wrap the findings' } }, d);

    expect(out).toBeNull();
  });

  it('end to end: without the instruction the same Agent call is asked', async () => {
    const store = turnStore();
    const d = deps({ ...store });
    await onUserPromptSubmit({ session_id: 's1', prompt: 'wrap the findings in the docs and commit' }, d);

    const out = await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'opus', prompt: 'Wrap the findings' } }, d);

    expect(out?.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('end to end: the next prompt replaces the stored instruction', async () => {
    const store = turnStore();
    const d = deps({ ...store });
    await onUserPromptSubmit({ session_id: 's1', prompt: 'run an opus subagent to wrap findings' }, d);
    await onUserPromptSubmit({ session_id: 's1', prompt: 'now tidy the notes folder please' }, d);

    const out = await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'opus', prompt: 'Tidy the notes' } }, d);

    expect(out?.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('UserPromptSubmit injects the explicit-request wording into the directive', async () => {
    const out = await onUserPromptSubmit({ session_id: 's1', prompt: 'run an opus subagent to wrap findings' }, deps());

    expect(String(out?.hookSpecificOutput.additionalContext)).toContain('explicit user request');
  });
});

describe('personas (5.6): real subagent types, no read-only agent for an edit', () => {
  const planChoice = { answers: { recommendedSubagent: { choice: 'Plan' }, recommendedTier: { choice: 'flash' } } };

  it('maps Plan to general-purpose when the task edits files', () => {
    const rec = parseDispatch(planChoice, 'Edit the tasklist and update the plan', 'normal');

    expect(rec?.subagent).toBe('general-purpose');
  });

  it('keeps Plan for a task that only designs', () => {
    const rec = parseDispatch(planChoice, 'Design the storage approach', 'normal');

    expect(rec?.subagent).toBe('Plan');
  });

  it('maps Explore to general-purpose when the task changes code', () => {
    const data = { answers: { recommendedSubagent: { choice: 'Explore' }, recommendedTier: { choice: 'flash' } } };

    const rec = parseDispatch(data, 'Find the parser and rename the entry function', 'normal');

    expect(rec?.subagent).toBe('general-purpose');
  });

  it('drops a display-name alias when its kebab alias exists', () => {
    const criteria = dropDisplayNameAliases({
      ...CLAUDE_SUBAGENT_CRITERIA,
      'Code Engineer': 'Software engineering',
      'code-engineer': 'Software engineering',
      code_engineer: 'Software engineering'
    });

    expect(Object.keys(criteria).filter((k) => k.toLowerCase().includes('engineer')).sort()).toEqual(['code-engineer', 'code_engineer']);
  });

  it('keeps the built-in names untouched', () => {
    const criteria = dropDisplayNameAliases({ ...CLAUDE_SUBAGENT_CRITERIA });

    expect(Object.keys(criteria).sort()).toEqual(['Explore', 'Plan', 'general-purpose', 'self']);
  });

  it('keeps a display name that has no kebab alias', () => {
    const criteria = dropDisplayNameAliases({ 'Solo Agent': 'x' });

    expect(Object.keys(criteria)).toEqual(['Solo Agent']);
  });
});

describe('recommended versus used logging (5.7)', () => {
  it('gives the prompt and the Agent call the same turn id', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const store = turnStore();
    const d = deps({ ...store, log: (e) => logs.push(e) });
    await onUserPromptSubmit({ session_id: 's1', prompt: 'wrap the findings in the docs and commit' }, d);

    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'sonnet', prompt: 'Wrap the findings' } }, d);

    const turns = logs.map((l) => l.turn);
    expect(turns[0]).toBe(turns[1]);
  });

  it('computes the turn id from the trimmed prompt', () => {
    expect(turnId('  hello world ')).toBe(turnId('hello world'));
  });

  it('puts tier and recommended_model on the PreToolUse record', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const store = turnStore();
    const d = deps({ ...store, log: (e) => logs.push(e) });
    await onUserPromptSubmit({ session_id: 's1', prompt: 'wrap the findings in the docs and commit' }, d);

    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { model: 'sonnet', prompt: 'Wrap the findings' } }, d);

    const pre = logs.find((l) => l.hook === 'PreToolUse')!;
    expect([pre.tier, pre.recommended_model, pre.requested_model]).toEqual(['flash', 'sonnet', 'sonnet']);
  });

  it('logs an Agent call even when no verdict is returned', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const d = deps({ log: (e) => logs.push(e) });

    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { prompt: 'Wrap the findings' } }, d);

    expect(logs.some((l) => l.hook === 'PreToolUse')).toBe(true);
  });

  it('adds modelRecommended on UserPromptSubmit and keeps modelUsed as a deprecated alias for one release', () => {
    const event = telemetryEvent({ hook: 'UserPromptSubmit', session: 's1', turn: 't1', tier: 'flash', model: 'sonnet', recommended_model: 'sonnet' });

    expect([event.modelRecommended, event.modelUsed]).toEqual(['sonnet', 'sonnet']);
  });

  it('keeps modelUsed for the PreToolUse requested model and adds the recommended one', () => {
    const event = telemetryEvent({ hook: 'PreToolUse', session: 's1', turn: 't1', tier: 'flash', requested_model: 'opus', recommended_model: 'sonnet' });

    expect([event.modelUsed, event.modelRecommended, event.turn]).toEqual(['opus', 'sonnet', 't1']);
  });
});

describe('pre-flight reminder at PreToolUse (5.10)', () => {
  const agentCall = { session_id: 's1', tool_name: 'Agent', tool_input: { model: 'sonnet', prompt: 'Wrap the findings' } };
  // 2.3.3: a reminder is for staged work: a Workflow, the third Agent call in the window, or a turn that named a workflow.
  const workflowCall = { session_id: 's1', tool_name: 'Workflow', tool_input: {} };

  it('reminds a Workflow when no dispatch call was logged recently', async () => {
    const d = deps({ recentDispatch: () => false });

    const out = await onPreToolUse(workflowCall, d);

    expect(out?.hookSpecificOutput.additionalContext).toBe(preflightReminder('Workflow'));
  });

  it('does not remind on a lone Agent call', async () => {
    const out = await onPreToolUse(agentCall, deps({ recentDispatch: () => false }));

    expect(out).toBeNull();
  });

  it('reminds on the third Agent call of the window, once', async () => {
    const calls = { count: 2, reminded: false };
    const d = deps({ recentDispatch: () => false, recentAgentCalls: () => calls });

    const third = await onPreToolUse(agentCall, d);
    const afterReminder = await onPreToolUse(agentCall, deps({ recentDispatch: () => false, recentAgentCalls: () => ({ count: 3, reminded: true }) }));

    expect([third?.hookSpecificOutput.additionalContext, afterReminder]).toEqual([PREFLIGHT_REMINDER, null]);
  });

  it('does not block: the reminder carries no permission decision', async () => {
    const d = deps({ recentDispatch: () => false });

    const out = await onPreToolUse(workflowCall, d);

    expect(out?.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it('stays silent when a dispatch call was logged recently', async () => {
    const d = deps({ recentDispatch: () => true });

    const out = await onPreToolUse(workflowCall, d);

    expect(out).toBeNull();
  });

  it('is skipped when the dispatch check is unavailable', async () => {
    const out = await onPreToolUse(workflowCall, deps());

    expect(out).toBeNull();
  });

  it('reminds at most once per window', async () => {
    const store = turnStore();
    let now = 1_000_000;
    const d = deps({ ...store, recentDispatch: () => false, now: () => now });
    await onUserPromptSubmit({ session_id: 's1', prompt: 'wrap the findings in the docs and commit' }, d);
    const first = await onPreToolUse(workflowCall, d);
    now += 60_000;

    const second = await onPreToolUse(workflowCall, d);

    expect([first !== null, second]).toEqual([true, null]);
  });

  it('puts the reminder next to an ask decision without replacing it', async () => {
    const store = turnStore();
    const d = deps({ ...store, recentDispatch: () => false });
    await onUserPromptSubmit({ session_id: 's1', prompt: 'wrap the findings of the workflow and its workstreams' }, d);

    const out = await onPreToolUse({ ...agentCall, tool_input: { model: 'opus', prompt: 'Wrap the findings' } }, d);

    expect([out?.hookSpecificOutput.permissionDecision, out?.hookSpecificOutput.additionalContext]).toEqual(['ask', PREFLIGHT_REMINDER]);
  });

  it('records that the reminder was sent in the log entry', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const d = deps({ recentDispatch: () => false, log: (e) => logs.push(e) });

    await onPreToolUse(workflowCall, d);

    expect(logs[0].preflight_reminder).toBe(true);
  });

  it('finds a dispatch line inside the window and ignores an old one', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    const lines = [
      JSON.stringify({ tool: 'jev_batch_dispatch', harness: 'claude-code', timestamp: '2026-11-09T11:55:00Z' }),
      JSON.stringify({ tool: 'jev_dispatch', harness: 'claude-code', timestamp: '2026-11-09T09:00:00Z' }),
      'not json',
      JSON.stringify({ tool: 'jev_judge', harness: 'claude-code', timestamp: '2026-11-09T11:59:00Z' })
    ];

    expect([hasRecentDispatch(lines, now, 10 * 60 * 1000), hasRecentDispatch(lines.slice(1), now, 10 * 60 * 1000)]).toEqual([true, false]);
  });
});
