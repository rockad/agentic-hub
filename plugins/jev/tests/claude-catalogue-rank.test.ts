/**
 * Catalogue-backed ranking in the Claude hook logic: `compareClaudeModels`, `classifyElevation` and `claimApproval`
 * use the model catalogue (tier, version, overrides) when a usable one is given, and fall back to the family-only regex
 * rank when there is none, it is corrupt, or it does not know the id. An id nothing knows is unranked.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCatalogue, loadCatalogue, saveCatalogue, type ModelOverrides } from '../src/core/catalogue.ts';
import {
  catalogueKnows,
  claimApproval,
  classifyElevation,
  compareClaudeModels,
  compareFamilyFirst,
  modelRank,
  type RankContext
} from '../claude/logic.ts';
import { onPreToolUse, type HookDeps, type HookInput } from '../claude/hook.ts';
import { memoryApprovals } from './elevation-helpers.ts';

const NOW = new Date('2026-11-12T10:00:00.000Z');
const IDS = ['claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-opus-4-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-fable-5-2'];
const ALIAS: Record<string, string> = { 'claude-haiku-5-5': 'haiku', 'claude-sonnet-5-5': 'sonnet', 'claude-opus-5-5': 'opus', 'claude-fable-5-2': 'fable' };

function catalogue(extra: Array<{ id: string; ok?: boolean }> = []) {
  return buildCatalogue(
    'claude-code',
    [...IDS.map((id) => ({ id, ok: true, ...(ALIAS[id] ? { alias: ALIAS[id] } : {}) })), ...extra.map((e) => ({ id: e.id, ok: e.ok ?? true }))],
    'probe',
    null,
    NOW
  );
}
const ctx = (overrides?: ModelOverrides): RankContext => ({ cat: catalogue(), ...(overrides ? { overrides } : {}) });

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-rank-'));
  tmp.push(d);
  return d;
}

describe('compareClaudeModels', () => {
  it('without a catalogue it is the family rank: versions are not seen', () => {
    expect(compareClaudeModels('opus', 'sonnet')).toBe(1);
    expect(compareClaudeModels('haiku', 'claude-sonnet-5-5')).toBe(-1);
    expect(compareClaudeModels('claude-sonnet-5', 'sonnet')).toBe(0);
    expect(compareClaudeModels('claude-sonnet-5', 'claude-sonnet-5-5')).toBe(0);
    expect(compareClaudeModels('fable', 'opus')).toBe(1);
  });

  it('with a catalogue it sees versions: sonnet 5 is below sonnet (5.5) and above haiku 5.5', () => {
    const c = ctx();
    expect(compareClaudeModels('claude-sonnet-5', 'sonnet', c)).toBe(-1);
    expect(compareClaudeModels('claude-sonnet-5', 'claude-haiku-5-5', c)).toBe(1);
    expect(compareClaudeModels('claude-opus-4-5', 'claude-sonnet-5-5', c)).toBe(1);
    expect(compareClaudeModels('sonnet', 'sonnet', c)).toBe(0);
  });

  it('an alias is the newest id of its family in the catalogue', () => {
    expect(compareClaudeModels('opus', 'claude-opus-5', ctx())).toBe(1);
    expect(compareClaudeModels('claude-opus-5', 'opus', ctx())).toBe(-1);
  });

  it('is null for an id nothing ranks (unknown family, "inherit", empty)', () => {
    expect(compareClaudeModels('gpt-5', 'sonnet')).toBeNull();
    expect(compareClaudeModels('inherit', 'sonnet')).toBeNull();
    expect(compareClaudeModels('claude-zephyr-1', 'sonnet', ctx())).toBeNull();
    expect(compareClaudeModels('', 'sonnet', ctx())).toBeNull();
    expect(compareClaudeModels(undefined, 'sonnet')).toBeNull();
  });

  it('an id the catalogue does not list falls back to the family regex', () => {
    // claude-opus-9 is not in the catalogue: the family rank still places it above sonnet.
    expect(catalogueKnows(ctx(), 'claude-opus-9')).toBe(false);
    expect(compareClaudeModels('claude-opus-9', 'sonnet', ctx())).toBe(1);
  });

  it('a needs-review id is unknown to the catalogue until an override gives it a tier', () => {
    const withUnknown = { cat: catalogue([{ id: 'claude-zephyr-1' }]) } as RankContext;
    expect(catalogueKnows(withUnknown, 'claude-zephyr-1')).toBe(false);
    expect(compareClaudeModels('claude-zephyr-1', 'sonnet', withUnknown)).toBeNull();
    const tiered = { ...withUnknown, overrides: { 'claude-zephyr-1': { tier: 'deep' as const } } };
    expect(catalogueKnows(tiered, 'claude-zephyr-1')).toBe(true);
    expect(compareClaudeModels('claude-zephyr-1', 'sonnet', tiered)).toBe(1);
  });

  it('an override rank orders ids the family regex cannot tell apart', () => {
    const o = { 'claude-sonnet-5': { tier: 'deep' as const, rank: 99 } };
    expect(compareClaudeModels('claude-sonnet-5', 'claude-opus-5-5', ctx(o))).toBe(1);
    expect(compareClaudeModels('claude-sonnet-5', 'claude-opus-5-5')).toBe(-1);
  });

  it('never throws on a broken context', () => {
    expect(compareClaudeModels('opus', 'sonnet', { cat: null } as unknown as RankContext)).toBe(1);
    expect(compareClaudeModels('opus', 'sonnet', {} as unknown as RankContext)).toBe(1);
  });
});

describe('a missing or corrupt catalogue behaves as no catalogue', () => {
  it('loadCatalogue gives null, and the comparison is the regex one', () => {
    const dir = tempDir();
    expect(loadCatalogue('claude-code', dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'claude-code.json'), '{ not json');
    expect(loadCatalogue('claude-code', dir)).toBeNull();
    expect(compareClaudeModels('claude-sonnet-5', 'sonnet', null)).toBe(0);
  });

  it('a saved catalogue round trips into a usable context', () => {
    const dir = tempDir();
    expect(saveCatalogue(catalogue(), dir)).toBe(true);
    const cat = loadCatalogue('claude-code', dir);
    expect(cat).not.toBeNull();
    expect(compareClaudeModels('claude-sonnet-5', 'sonnet', { cat: cat! })).toBe(-1);
  });
});

describe('classifyElevation with a catalogue', () => {
  it('without a context it is the 2.3.5 behaviour', () => {
    expect(classifyElevation({ model: 'opus' }, 'claude-sonnet-5')?.kind).toBe('elevating');
    expect(classifyElevation({ model: 'sonnet' }, 'claude-sonnet-5')).toBeNull();
    expect(classifyElevation({ model: 'claude-zephyr-1' }, 'claude-sonnet-5')).toBeNull();
    expect(classifyElevation({ model: 'inherit' }, 'claude-sonnet-5')).toBeNull();
  });

  it('a cross-family step is an elevation either way', () => {
    expect(classifyElevation({ model: 'opus' }, 'claude-sonnet-5-5', undefined, ctx())?.kind).toBe('elevating');
    expect(classifyElevation({ model: 'haiku' }, 'claude-sonnet-5-5', undefined, ctx())).toBeNull();
  });

  it('a version step inside one alias is not an elevation (the Agent tool cannot name a version)', () => {
    expect(classifyElevation({ model: 'sonnet' }, 'claude-sonnet-5', undefined, ctx())).toBeNull();
  });

  it('an override can make a model above the session model that the family rank puts below it', () => {
    const o = { 'claude-sonnet-5': { tier: 'deep' as const, rank: 99 } };
    expect(classifyElevation({ model: 'claude-sonnet-5' }, 'claude-opus-5-5')).toBeNull();
    expect(classifyElevation({ model: 'claude-sonnet-5' }, 'claude-opus-5-5', undefined, ctx(o))?.kind).toBe('elevating');
  });

  it('an unknown id is unranked: with a catalogue the guard asks, without one it passes', () => {
    const e = classifyElevation({ model: 'claude-zephyr-1' }, 'claude-sonnet-5-5', undefined, ctx());
    expect(e?.kind).toBe('elevating');
    expect(e?.unranked).toBe(true);
    expect(classifyElevation({ model: 'claude-zephyr-1' }, 'claude-sonnet-5-5')).toBeNull();
  });

  it('"inherit", no model and an unknown session model still pass', () => {
    expect(classifyElevation({ model: 'inherit' }, 'claude-sonnet-5-5', undefined, ctx())).toBeNull();
    expect(classifyElevation({}, 'claude-sonnet-5-5', undefined, ctx())).toBeNull();
    expect(classifyElevation({ model: 'opus' }, 'mystery-model', undefined, ctx())).toBeNull();
    expect(classifyElevation({ model: 'opus' }, null, undefined, ctx())).toBeNull();
  });

  it('a model the user named still covers a weaker request', () => {
    expect(classifyElevation({ model: 'opus' }, 'claude-sonnet-5-5', { models: ['opus'] }, ctx())?.kind).toBe('instructed');
    expect(classifyElevation({ model: 'opus' }, 'claude-sonnet-5-5', { models: ['sonnet'] }, ctx())?.kind).toBe('elevating');
  });
});

describe('claimApproval with a catalogue', () => {
  const state = { approvals: [{ model: 'opus' as const, scope: 'session' as const, created_at: 1 }] };

  it('an approval covers its model and anything below it, with or without a catalogue', () => {
    expect(claimApproval(state, 'sonnet', 5).approval).not.toBeNull();
    expect(claimApproval(state, 'sonnet', 5, ctx()).approval).not.toBeNull();
    expect(claimApproval(state, 'fable', 5).approval).toBeNull();
    // The family ladder wins across families (an opus approval does not cover fable, whatever the versions say).
    expect(claimApproval({ approvals: [{ model: 'haiku', scope: 'session', created_at: 1 }] }, 'sonnet', 5, ctx()).approval).toBeNull();
  });

  it('a version-aware comparison: an opus approval covers claude-opus-5 but a sonnet-5 approval does not cover opus', () => {
    expect(claimApproval(state, 'claude-opus-5', 5, ctx()).approval).not.toBeNull();
    const s5 = { approvals: [{ model: 'claude-sonnet-5' as any, scope: 'session' as const, created_at: 1 }] };
    expect(claimApproval(s5, 'sonnet', 5, ctx()).approval).toBeNull();
  });
});

describe('PreToolUse with a catalogue', () => {
  const flashRec = { subagent: 'general-purpose', tier: 'flash' as const, model: 'sonnet' as const };
  const base = (extra: Partial<HookDeps> = {}) => {
    const logs: Record<string, unknown>[] = [];
    const deps: HookDeps = {
      readMode: async () => 'on',
      readSessionModel: () => 'claude-sonnet-5-5',
      readQuotaStrategy: async () => 'unknown',
      dispatch: async () => null,
      log: (e) => logs.push(e),
      readTurn: () => ({ turn: 't1', intent: { models: [] }, rec: flashRec }),
      approvals: memoryApprovals(),
      env: {},
      ...extra
    };
    return { deps, logs };
  };
  const call = (model: string): HookInput => ({ session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', tool_input: { description: 'd', prompt: 'p', subagent_type: 'code-engineer', model } });
  const out = (o: Awaited<ReturnType<typeof onPreToolUse>>) => (o?.hookSpecificOutput ?? {}) as Record<string, any>;

  it('an unknown model id opens the permission dialog when a catalogue is in use', async () => {
    const { deps, logs } = base({ rankContext: () => ctx() });
    const o = out(await onPreToolUse(call('claude-zephyr-1'), deps));
    expect(o.permissionDecision).toBe('ask');
    expect(o.permissionDecisionReason).toContain('does not know');
    expect(logs[0].elevation).toBe('asked');
  });

  it('the same call passes without a catalogue', async () => {
    const { deps } = base();
    expect(await onPreToolUse(call('claude-zephyr-1'), deps)).toBeNull();
  });

  it('a failing rankContext reads as no catalogue: the call is judged by the family rank', async () => {
    const { deps } = base({
      rankContext: () => {
        throw new Error('boom');
      }
    });
    expect(out(await onPreToolUse(call('opus'), deps)).permissionDecision).toBe('deny');
    expect(await onPreToolUse(call('claude-zephyr-1'), deps)).toBeNull();
  });

  it('modelRank itself is unchanged (family only, null for unknown)', () => {
    expect(modelRank('claude-sonnet-5')).toBe(modelRank('claude-sonnet-5-5'));
    expect(modelRank('claude-zephyr-1')).toBeNull();
  });
});

describe('the family ladder (fable > opus > sonnet > haiku) holds whatever the catalogue versions say', () => {
  // The catalogue puts opus 5.5 and fable 5.2 in one tier and orders them by version: opus 5.5 above fable 5.2.
  it('the catalogue alone really does put opus above fable (the premise of the fix)', () => {
    expect(compareClaudeModels('claude-opus-5-5', 'claude-fable-5-2', ctx())).toBe(1);
  });

  it('compareFamilyFirst puts fable above opus and leaves same-family steps to the catalogue', () => {
    expect(compareFamilyFirst('claude-fable-5-2', 'claude-opus-5-5', ctx())).toBe(1);
    expect(compareFamilyFirst('claude-opus-5-5', 'claude-fable-5-2', ctx())).toBe(-1);
    expect(compareFamilyFirst('opus', 'fable', ctx())).toBe(-1);
    expect(compareFamilyFirst('claude-sonnet-5', 'sonnet', ctx())).toBe(-1);
    expect(compareFamilyFirst('claude-zephyr-1', 'sonnet', ctx())).toBeNull();
    expect(compareFamilyFirst('claude-opus-5-5', 'claude-fable-5-2')).toBe(-1);
  });

  it('a tier override still moves an id across families', () => {
    const o = { 'claude-sonnet-5': { tier: 'deep' as const, rank: 99 } };

    expect(compareFamilyFirst('claude-sonnet-5', 'claude-opus-5-5', ctx(o))).toBe(1);
  });

  it('an Opus 5.5 session calling fable is elevating', () => {
    const e = classifyElevation({ model: 'fable' }, 'claude-opus-5-5', undefined, ctx());

    expect(e?.kind).toBe('elevating');
    expect(e?.sessionAlias).toBe('opus');
  });

  it('a Fable session calling opus is not elevating', () => {
    expect(classifyElevation({ model: 'opus' }, 'claude-fable-5-2', undefined, ctx())).toBeNull();
    expect(classifyElevation({ model: 'claude-opus-5-5' }, 'claude-fable-5-2', undefined, ctx())).toBeNull();
  });

  it('naming opus does not instruct a fable call, naming fable instructs an opus one', () => {
    expect(classifyElevation({ model: 'fable' }, 'claude-sonnet-5-5', { models: ['opus'] }, ctx())?.kind).toBe('elevating');
    expect(classifyElevation({ model: 'opus' }, 'claude-sonnet-5-5', { models: ['fable'] }, ctx())?.kind).toBe('instructed');
  });

  it('an opus approval does not cover fable, a fable approval covers opus', () => {
    const opus = { approvals: [{ model: 'opus' as const, scope: 'session' as const, created_at: 1 }] };
    const fable = { approvals: [{ model: 'fable' as const, scope: 'session' as const, created_at: 1 }] };

    expect(claimApproval(opus, 'fable', 5, ctx()).approval).toBeNull();
    expect(claimApproval(opus, 'claude-fable-5-2', 5, ctx()).approval).toBeNull();
    expect(claimApproval(fable, 'opus', 5, ctx()).approval).not.toBeNull();
  });
});

describe('PreToolUse with a catalogue: the family ladder and the approvals store', () => {
  const flashRec = { subagent: 'general-purpose', tier: 'flash' as const, model: 'sonnet' as const };
  const setup = (session: string) => {
    const approvals = memoryApprovals();
    const deps: HookDeps = {
      readMode: async () => 'on',
      readSessionModel: () => session,
      readQuotaStrategy: async () => 'unknown',
      dispatch: async () => null,
      log: () => {},
      readTurn: () => ({ turn: 't1', intent: { models: [] }, rec: flashRec }),
      rankContext: () => ctx(),
      approvals,
      env: {}
    };
    return { deps, approvals };
  };
  const call = (model: string): HookInput => ({ session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', tool_input: { description: 'd', prompt: 'p', subagent_type: 'code-engineer', model } });
  const decision = async (deps: HookDeps, model: string) => ((await onPreToolUse(call(model), deps))?.hookSpecificOutput as any)?.permissionDecision ?? null;

  it('an Opus 5.5 session calling fable is denied with the question, not run silently', async () => {
    expect(await decision(setup('claude-opus-5-5').deps, 'fable')).toBe('deny');
  });

  it('a Fable session calling opus is not asked about', async () => {
    expect(await decision(setup('claude-fable-5-2').deps, 'opus')).toBeNull();
  });

  it('an opus approval does not let a fable call through', async () => {
    const { deps, approvals } = setup('claude-sonnet-5-5');
    approvals.deny('s1', 'opus', 1);
    approvals.record('s1', { model: 'opus', scope: 'session', created_at: 1 });

    expect(await decision(deps, 'opus')).toBeNull();
    expect(await decision(deps, 'fable')).toBe('deny');
  });

  it('the store gets the catalogue: an approval for sonnet 5 does not cover the sonnet alias (5.5)', async () => {
    const { deps, approvals } = setup('claude-haiku-5-5');
    approvals.record('s1', { model: 'claude-sonnet-5' as any, scope: 'session', created_at: 1 });

    expect(await decision(deps, 'sonnet')).toBe('deny');
  });
});

describe('a ladder-pinned subagent carries its model in its name (jev-ladder-<id>), and the elevation guard reads it', () => {
  const flashRec = { subagent: 'general-purpose', tier: 'flash' as const, model: 'sonnet' as const };
  const setup = (session = 'claude-sonnet-5-5', withCatalogue = true) => {
    const deps: HookDeps = {
      readMode: async () => 'on',
      readSessionModel: () => session,
      readQuotaStrategy: async () => 'unknown',
      dispatch: async () => null,
      log: () => {},
      readTurn: () => ({ turn: 't1', intent: { models: [] }, rec: flashRec }),
      ...(withCatalogue ? { rankContext: () => ctx() } : {}),
      approvals: memoryApprovals(),
      env: {}
    };
    return deps;
  };
  const agent = (subagent_type: string, extra: Record<string, unknown> = {}): HookInput => ({
    session_id: 's1',
    prompt_id: 'p1',
    tool_name: 'Agent',
    tool_input: { description: 'd', prompt: 'p', subagent_type, ...extra }
  });
  const decision = async (deps: HookDeps, input: HookInput) => ((await onPreToolUse(input, deps))?.hookSpecificOutput as any)?.permissionDecision ?? null;

  it('an opus ladder agent in a sonnet session is elevating, with and without a catalogue', async () => {
    for (const withCatalogue of [true, false]) {
      const d = setup('claude-sonnet-5-5', withCatalogue);

      expect(await decision(d, agent('jev-ladder-claude-opus-5-5'))).toBe('deny');
      expect(await decision(d, agent('jev-ladder-claude-fable-5-2'))).toBe('deny');
    }
  });

  it('a plugin-qualified name is read the same way', async () => {
    expect(await decision(setup(), agent('jev:jev-ladder-claude-opus-5-5'))).toBe('deny');
  });

  it('the deny names the pinned model: marker, and the elevation is for opus', async () => {
    const o = (await onPreToolUse(agent('jev-ladder-claude-opus-5-5'), setup()))?.hookSpecificOutput as any;

    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
  });

  it('a sonnet ladder agent in a sonnet session is not elevating, nor is an older sonnet', async () => {
    expect(await decision(setup(), agent('jev-ladder-claude-sonnet-5-5'))).toBeNull();
    expect(await decision(setup(), agent('jev-ladder-claude-sonnet-5'))).toBeNull();
    expect(await decision(setup(), agent('jev-ladder-claude-haiku-5-5'))).toBeNull();
  });

  it('an opus session running an opus ladder agent is not elevating', async () => {
    expect(await decision(setup('claude-opus-5-5'), agent('jev-ladder-claude-opus-5-5'))).toBeNull();
  });

  it('an approval for opus lets the opus ladder agent through', async () => {
    const d = setup();
    d.approvals!.deny('s1', 'opus', 1);
    d.approvals!.record('s1', { model: 'opus', scope: 'session', created_at: 1 });

    expect(await decision(d, agent('jev-ladder-claude-opus-5-5'))).toBeNull();
    expect(await decision(d, agent('jev-ladder-claude-fable-5-2'))).toBe('deny');
  });

  it('an explicit model on the call still decides: it overrides the definition', async () => {
    expect(await decision(setup(), agent('jev-ladder-claude-opus-5-5', { model: 'sonnet' }))).toBeNull();
  });

  it('a custom agent with no model, a made-up ladder suffix and an unrelated name are unchanged', async () => {
    const d = setup();

    expect(await decision(d, agent('code-engineer'))).toBeNull();
    expect(await decision(d, agent('general-purpose'))).toBeNull();
    expect(await decision(d, agent('jev-ladder-notes'))).toBeNull();
    expect(await decision(d, agent('my-jev-ladder-claude-opus-5-5'))).toBeNull();
  });

  it('classifyElevation reads the pinned id: requested is the id from the name', () => {
    const e = classifyElevation({ subagent_type: 'jev-ladder-claude-opus-5-5' }, 'claude-sonnet-5-5', undefined, ctx());

    expect(e).toMatchObject({ kind: 'elevating', requested: 'claude-opus-5-5', sessionAlias: 'sonnet' });
    expect(classifyElevation({ subagent_type: 'jev-ladder-claude-sonnet-5-5' }, 'claude-sonnet-5-5', undefined, ctx())).toBeNull();
    expect(classifyElevation({ subagent_type: 'jev-ladder-claude-opus-5-5' }, 'claude-sonnet-5-5', { models: ['opus'] }, ctx())?.kind).toBe('instructed');
  });
});
