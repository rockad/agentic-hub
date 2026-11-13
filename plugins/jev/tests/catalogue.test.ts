import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseModelId,
  heuristicTier,
  compareVersions,
  compareModels,
  resolveAlias,
  loadOverrides,
  buildCatalogue,
  ladder,
  unknownIds,
  isStale,
  isVeryStale,
  loadCatalogue,
  saveCatalogue,
  cataloguePath,
  markSuspect,
  resolveTier,
  priceOf,
  cheaperThan,
  type CatalogueModel,
  type ModelPrice,
  type Catalogue,
  type ProbeResult
} from '../src/core/catalogue.js';
import * as core from '../src/core/index.js';
import { DEFAULT_JEV_CONFIG, type HarnessModelMap } from '../src/core/config.js';

const T0 = new Date('2026-11-12T10:00:00.000Z');
const daysLater = (d: number, from = T0) => new Date(from.getTime() + d * 86_400_000);
const ok = (id: string, alias?: string): ProbeResult => ({ id, ok: true, ...(alias ? { alias } : {}) });
const fail = (id: string): ProbeResult => ({ id, ok: false });

/** The account in the design record: all nine ids available. */
const ACCOUNT = [
  ok('claude-haiku-5-5', 'haiku'),
  ok('claude-haiku-4-5'),
  ok('claude-sonnet-5-5', 'sonnet'),
  ok('claude-sonnet-5'),
  ok('claude-sonnet-4-5'),
  ok('claude-opus-5-5', 'opus'),
  ok('claude-opus-5'),
  ok('claude-opus-4-5'),
  ok('claude-fable-5-2', 'fable')
];

const CLAUDE_DEFAULTS = DEFAULT_JEV_CONFIG.harnesses!['claude-code']!.models as HarnessModelMap;

describe('parseModelId', () => {
  it('parses claude ids with major and optional minor', () => {
    expect(parseModelId('claude-haiku-5-5')).toMatchObject({ family: 'haiku', version: [5, 5], latest: false, alias: false });
    expect(parseModelId('claude-sonnet-5')).toMatchObject({ family: 'sonnet', version: [5] });
    expect(parseModelId('claude-opus-4-5')).toMatchObject({ family: 'opus', version: [4, 5] });
    expect(parseModelId('claude-fable-5-2')).toMatchObject({ family: 'fable', version: [5, 2] });
  });

  it('ignores a trailing date stamp', () => {
    expect(parseModelId('claude-sonnet-4-20250514')).toMatchObject({ family: 'sonnet', version: [4] });
    expect(parseModelId('claude-haiku-4-5-20251001')).toMatchObject({ family: 'haiku', version: [4, 5] });
  });

  it('parses OpenRouter forms', () => {
    expect(parseModelId('anthropic/claude-sonnet-4.5')).toMatchObject({ family: 'sonnet', version: [4, 5], provider: 'anthropic' });
    expect(parseModelId('anthropic/claude-opus-4-5')).toMatchObject({ family: 'opus', version: [4, 5] });
    const latest = parseModelId('~anthropic/claude-sonnet-latest')!;
    expect(latest).toMatchObject({ family: 'sonnet', latest: true, provider: 'anthropic' });
    expect(latest.version).toEqual([Infinity]);
    expect(parseModelId('google/gemini-2.5-pro')).toMatchObject({ family: 'gemini', version: [2, 5], provider: 'google' });
    expect(parseModelId('google/gemma-4-31b-it:free')).toMatchObject({ family: 'gemma', version: [4] });
    expect(parseModelId('openrouter/free')).toMatchObject({ family: 'free', version: [], provider: 'openrouter' });
  });

  it('parses the legacy claude-3-5-sonnet order', () => {
    expect(parseModelId('claude-3-5-sonnet')).toMatchObject({ family: 'sonnet', version: [3, 5] });
    expect(parseModelId('anthropic/claude-3.5-haiku')).toMatchObject({ family: 'haiku', version: [3, 5] });
  });

  it('treats bare aliases as unversioned', () => {
    for (const a of ['haiku', 'sonnet', 'opus', 'fable']) {
      expect(parseModelId(a)).toMatchObject({ family: a, version: [], alias: true, latest: false });
    }
  });

  it('returns null for empty or non-string input', () => {
    expect(parseModelId('')).toBeNull();
    expect(parseModelId('   ')).toBeNull();
    expect(parseModelId(undefined as unknown as string)).toBeNull();
    expect(parseModelId('123')).toBeNull();
  });

  it('orders versions: sonnet-5 < sonnet-5-5 and haiku-4-5 < haiku-5-5', () => {
    const v = (id: string) => parseModelId(id)!.version;
    expect(compareVersions(v('claude-sonnet-5'), v('claude-sonnet-5-5'))).toBeLessThan(0);
    expect(compareVersions(v('claude-haiku-4-5'), v('claude-haiku-5-5'))).toBeLessThan(0);
    expect(compareVersions(v('claude-sonnet-4-5'), v('claude-sonnet-5'))).toBeLessThan(0);
    expect(compareVersions(v('claude-sonnet-5-5'), v('claude-sonnet-5-5'))).toBe(0);
    expect(compareVersions(v('claude-sonnet-9'), v('~anthropic/claude-sonnet-latest'))).toBeLessThan(0);
    // numeric, not lexicographic
    expect(compareVersions([5, 10], [5, 9])).toBeGreaterThan(0);
  });
});

describe('heuristicTier', () => {
  it('maps the known families and nothing else', () => {
    expect(heuristicTier('haiku')).toBe('cheap');
    expect(heuristicTier('sonnet')).toBe('standard');
    expect(heuristicTier('opus')).toBe('deep');
    expect(heuristicTier('fable')).toBe('deep');
    expect(heuristicTier('Sonnet')).toBe('standard');
    expect(heuristicTier('gemini')).toBeNull();
    expect(heuristicTier('')).toBeNull();
  });
});

describe('compareModels', () => {
  it('orders across families by tier, then version', () => {
    expect(compareModels('claude-haiku-5-5', 'claude-sonnet-4-5')).toBeLessThan(0);
    expect(compareModels('claude-sonnet-5-5', 'claude-opus-4-5')).toBeLessThan(0);
    expect(compareModels('claude-opus-5-5', 'claude-haiku-5-5')).toBeGreaterThan(0);
    expect(compareModels('claude-sonnet-5', 'claude-sonnet-5-5')).toBeLessThan(0);
    expect(compareModels('claude-sonnet-5-5', 'claude-sonnet-5-5')).toBe(0);
  });

  it('puts opus and fable in one tier and orders them by version, family on a tie', () => {
    expect(compareModels('claude-opus-4-5', 'claude-fable-5-2')).toBeLessThan(0);
    expect(compareModels('claude-opus-5-5', 'claude-fable-5-2')).toBeGreaterThan(0);
    expect(compareModels('claude-opus-5', 'claude-fable-5')).toBeLessThan(0);
  });

  it('returns null for an unknown family so the caller can treat it as unranked', () => {
    expect(compareModels('claude-newfam-1', 'claude-sonnet-5')).toBeNull();
    expect(compareModels('claude-sonnet-5', 'not a model!')).toBeNull();
  });

  it('resolves aliases through the catalogue', () => {
    const cat = buildCatalogue('claude-code', ACCOUNT, 'probe', null, T0);
    expect(compareModels('sonnet', 'claude-sonnet-5', cat)).toBeGreaterThan(0);
    expect(compareModels('haiku', 'claude-sonnet-4-5', cat)).toBeLessThan(0);
    // without a catalogue an alias is tier-only: same tier compares equal
    expect(compareModels('sonnet', 'claude-sonnet-5')).toBe(0);
    expect(compareModels('haiku', 'claude-sonnet-5')).toBeLessThan(0);
  });

  it('honours tier and rank overrides', () => {
    expect(compareModels('claude-haiku-5-5', 'claude-sonnet-4-5', null, { 'claude-haiku-5-5': { tier: 'deep' } })).toBeGreaterThan(0);
    const o = { 'claude-sonnet-4-5': { rank: 10 } };
    expect(compareModels('claude-sonnet-4-5', 'claude-sonnet-5-5', null, o)).toBeGreaterThan(0);
    expect(compareModels('claude-sonnet-4-5', 'claude-sonnet-5-5', null, { ...o, 'claude-sonnet-5-5': { rank: 20 } })).toBeLessThan(0);
  });
});

describe('buildCatalogue and ladder', () => {
  it('builds the account from the design record, tiers from the heuristic', () => {
    const cat = buildCatalogue('claude-code', ACCOUNT, 'probe', null, T0);
    expect(cat).toMatchObject({ version: 1, harness: 'claude-code', source: 'probe', updated_at: T0.toISOString() });
    expect(cat.models).toHaveLength(9);
    const byId = Object.fromEntries(cat.models.map((m) => [m.id, m]));
    expect(byId['claude-haiku-5-5']).toMatchObject({ family: 'haiku', version: [5, 5], tier: 'cheap', alias: 'haiku', status: 'ok', strikes: 0, last_ok: T0.toISOString() });
    expect(byId['claude-fable-5-2'].tier).toBe('deep');
    expect(byId['claude-sonnet-5'].alias).toBeUndefined();
    expect(unknownIds(cat)).toEqual([]);
  });

  it('orders each ladder newest first and keeps tiers apart', () => {
    const cat = buildCatalogue('claude-code', ACCOUNT, 'probe', null, T0);
    expect(ladder(cat, 'cheap')).toEqual(['claude-haiku-5-5', 'claude-haiku-4-5']);
    expect(ladder(cat, 'standard')).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-5']);
    expect(ladder(cat, 'deep')).toEqual(['claude-opus-5-5', 'claude-fable-5-2', 'claude-opus-5', 'claude-opus-4-5']);
    expect(ladder(cat, 'free')).toEqual([]);
    expect(ladder(null, 'cheap')).toEqual([]);
  });

  it('is independent of probe order', () => {
    const a = buildCatalogue('claude-code', ACCOUNT, 'probe', null, T0);
    const b = buildCatalogue('claude-code', [...ACCOUNT].reverse(), 'probe', null, T0);
    expect(b).toEqual(a);
  });

  it('a new fictional id slots in without code changes', () => {
    const cat = buildCatalogue('claude-code', [...ACCOUNT, ok('claude-sonnet-6'), ok('claude-haiku-6'), ok('claude-sonnet-5-10')], 'probe', null, T0);
    expect(ladder(cat, 'standard')[0]).toBe('claude-sonnet-6');
    expect(ladder(cat, 'standard')).toContain('claude-sonnet-5-10');
    expect(ladder(cat, 'standard').indexOf('claude-sonnet-5-10')).toBeLessThan(ladder(cat, 'standard').indexOf('claude-sonnet-5-5') + 1);
    expect(ladder(cat, 'cheap')[0]).toBe('claude-haiku-6');
    expect(resolveAlias(cat, 'sonnet')).toBe('claude-sonnet-6');
    expect(resolveAlias(cat, 'haiku')).toBe('claude-haiku-6');
    expect(compareModels('claude-sonnet-6', 'claude-sonnet-5-5')).toBeGreaterThan(0);
  });

  it('marks an unknown family needs-review, lists it, and keeps it out of the ladder', () => {
    const cat = buildCatalogue('claude-code', [ok('claude-sonnet-5-5'), ok('claude-zephyr-1'), ok('weird')], 'probe', null, T0);
    expect(cat.models.find((m) => m.id === 'claude-zephyr-1')).toMatchObject({ status: 'needs-review', family: 'zephyr', version: [1] });
    expect(unknownIds(cat).sort()).toEqual(['claude-zephyr-1', 'weird']);
    for (const t of ['free', 'cheap', 'standard', 'deep'] as const) {
      expect(ladder(cat, t)).not.toContain('claude-zephyr-1');
      expect(ladder(cat, t)).not.toContain('weird');
    }
  });

  it('a tier override makes a needs-review id usable', () => {
    const cat = buildCatalogue('claude-code', [ok('claude-zephyr-1')], 'probe', null, T0);
    expect(ladder(cat, 'standard', { 'claude-zephyr-1': { tier: 'standard' } })).toEqual(['claude-zephyr-1']);
  });

  it('stores the native alias only when reported and keeps it across rounds', () => {
    const r1 = buildCatalogue('claude-code', [ok('claude-sonnet-5-5', 'sonnet')], 'probe', null, T0);
    const r2 = buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', r1, daysLater(1));
    expect(r2.models[0].alias).toBe('sonnet');
  });

  it('merges duplicate results for one id: an alias from any of them is kept, whatever the order', () => {
    const withAlias = buildCatalogue('claude-code', [ok('claude-opus-5-5', 'opus'), ok('claude-opus-5-5')], 'probe', null, T0);
    const aliasLast = buildCatalogue('claude-code', [ok('claude-opus-5-5'), ok('claude-opus-5-5', 'opus')], 'probe', null, T0);

    expect(withAlias.models[0].alias).toBe('opus');
    expect(aliasLast.models[0].alias).toBe('opus');
  });

  it('merging duplicates keeps the last verdict: a later failure still wins over an earlier success', () => {
    const cat = buildCatalogue('claude-code', [ok('claude-opus-5-5', 'opus'), fail('claude-opus-5-5')], 'probe', null, T0);

    expect(cat.models[0]).toMatchObject({ id: 'claude-opus-5-5', status: 'missing', alias: 'opus' });
  });

  it('carries over ids that were not probed this round and ignores a catalogue for another harness', () => {
    const r1 = buildCatalogue('claude-code', [ok('claude-sonnet-5-5'), ok('claude-haiku-5-5')], 'probe', null, T0);
    const r2 = buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', r1, daysLater(1));
    expect(r2.models.map((m) => m.id).sort()).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    const other = buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', { ...r1, harness: 'opencode' }, daysLater(1));
    expect(other.models.map((m) => m.id)).toEqual(['claude-sonnet-5-5']);
  });

  it('does not mutate the previous catalogue', () => {
    const r1 = buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', null, T0);
    const snapshot = JSON.parse(JSON.stringify(r1));
    buildCatalogue('claude-code', [fail('claude-sonnet-5-5')], 'probe', r1, daysLater(1));
    expect(JSON.parse(JSON.stringify(r1))).toEqual(snapshot);
  });

  describe('strikes rule over refresh cycles', () => {
    const id = 'claude-sonnet-5-5';
    const base = () => buildCatalogue('claude-code', [ok(id), ok('claude-sonnet-5')], 'probe', null, T0);

    it('fail, fail, fail removes the id; it is skipped from the first failure', () => {
      let cat = base();
      cat = buildCatalogue('claude-code', [fail(id)], 'probe', cat, daysLater(1));
      expect(cat.models.find((m) => m.id === id)).toMatchObject({ status: 'missing', strikes: 1, last_ok: T0.toISOString() });
      expect(ladder(cat, 'standard')).toEqual(['claude-sonnet-5']);

      cat = buildCatalogue('claude-code', [fail(id)], 'probe', cat, daysLater(2));
      expect(cat.models.find((m) => m.id === id)).toMatchObject({ status: 'missing', strikes: 2 });
      expect(ladder(cat, 'standard')).toEqual(['claude-sonnet-5']);

      cat = buildCatalogue('claude-code', [fail(id)], 'probe', cat, daysLater(3));
      expect(cat.models.find((m) => m.id === id)).toBeUndefined();
      expect(ladder(cat, 'standard')).toEqual(['claude-sonnet-5']);
    });

    it('fail then ok resets strikes, status and last_ok', () => {
      let cat = base();
      cat = buildCatalogue('claude-code', [fail(id)], 'probe', cat, daysLater(1));
      cat = buildCatalogue('claude-code', [fail(id)], 'probe', cat, daysLater(2));
      expect(cat.models.find((m) => m.id === id)!.strikes).toBe(2);
      cat = buildCatalogue('claude-code', [ok(id)], 'probe', cat, daysLater(3));
      expect(cat.models.find((m) => m.id === id)).toMatchObject({ status: 'ok', strikes: 0, last_ok: daysLater(3).toISOString() });
      expect(ladder(cat, 'standard')[0]).toBe(id);
      // the counter really restarted: two more failures do not delete it
      cat = buildCatalogue('claude-code', [fail(id)], 'probe', cat, daysLater(4));
      cat = buildCatalogue('claude-code', [fail(id)], 'probe', cat, daysLater(5));
      expect(cat.models.find((m) => m.id === id)).toMatchObject({ status: 'missing', strikes: 2 });
    });

    it('ok in between failures breaks the consecutive run', () => {
      let cat = base();
      cat = buildCatalogue('claude-code', [fail(id)], 'probe', cat, daysLater(1));
      cat = buildCatalogue('claude-code', [ok(id)], 'probe', cat, daysLater(2));
      cat = buildCatalogue('claude-code', [fail(id)], 'probe', cat, daysLater(3));
      cat = buildCatalogue('claude-code', [fail(id)], 'probe', cat, daysLater(4));
      expect(cat.models.find((m) => m.id === id)).toMatchObject({ strikes: 2, status: 'missing' });
    });

    it('a failing id that was never ok is recorded as missing with one strike', () => {
      const cat = buildCatalogue('claude-code', [fail('claude-haiku-5')], 'probe', null, T0);
      expect(cat.models[0]).toMatchObject({ id: 'claude-haiku-5', status: 'missing', strikes: 1 });
      expect(cat.models[0].last_ok).toBeUndefined();
    });

    it('a failing unknown-family id stays needs-review and is deleted after three strikes', () => {
      let cat = buildCatalogue('claude-code', [fail('claude-zephyr-1')], 'probe', null, T0);
      expect(cat.models[0]).toMatchObject({ status: 'needs-review', strikes: 1 });
      cat = buildCatalogue('claude-code', [fail('claude-zephyr-1')], 'probe', cat, daysLater(1));
      cat = buildCatalogue('claude-code', [fail('claude-zephyr-1')], 'probe', cat, daysLater(2));
      expect(cat.models).toEqual([]);
    });
  });
});

describe('overrides', () => {
  const cat = buildCatalogue('claude-code', ACCOUNT, 'probe', null, T0);

  it('ignore removes an id from the ladder', () => {
    expect(ladder(cat, 'standard', { 'claude-sonnet-5-5': { ignore: true } })).toEqual(['claude-sonnet-5', 'claude-sonnet-4-5']);
    expect(resolveAlias(cat, 'sonnet', { 'claude-sonnet-5-5': { ignore: true } })).toBe('claude-sonnet-5');
  });

  it('tier moves an id to another tier', () => {
    const o = { 'claude-haiku-5-5': { tier: 'standard' as const } };
    expect(ladder(cat, 'cheap', o)).toEqual(['claude-haiku-4-5']);
    expect(ladder(cat, 'standard', o)[0]).toBe('claude-sonnet-5-5');
    expect(ladder(cat, 'standard', o)).toContain('claude-haiku-5-5');
  });

  it('rank overrides version order inside a tier: ranked first, higher rank first', () => {
    expect(ladder(cat, 'standard', { 'claude-sonnet-4-5': { rank: 1 } })).toEqual(['claude-sonnet-4-5', 'claude-sonnet-5-5', 'claude-sonnet-5']);
    expect(
      ladder(cat, 'standard', { 'claude-sonnet-4-5': { rank: 1 }, 'claude-sonnet-5': { rank: 2 } })
    ).toEqual(['claude-sonnet-5', 'claude-sonnet-4-5', 'claude-sonnet-5-5']);
  });

  it('pin puts an id first in its tier, ahead of ranked ids', () => {
    expect(
      ladder(cat, 'standard', { 'claude-sonnet-5': { pin: true }, 'claude-sonnet-4-5': { rank: 99 } })
    ).toEqual(['claude-sonnet-5', 'claude-sonnet-4-5', 'claude-sonnet-5-5']);
  });

  it('a pin does not resurrect a missing id', () => {
    const failed = buildCatalogue('claude-code', [fail('claude-sonnet-5-5'), ok('claude-sonnet-5')], 'probe', null, T0);
    expect(ladder(failed, 'standard', { 'claude-sonnet-5-5': { pin: true } })).toEqual(['claude-sonnet-5']);
  });

  describe('loadOverrides (tolerant reader)', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ovr-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('reads models.overrides and keeps the loader-owned model strings alone', () => {
      const file = path.join(dir, 'config.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          models: {
            decision: '~typesafe/jev-latest',
            overrides: {
              'claude-sonnet-5': { tier: 'standard', rank: 3, pin: true },
              'claude-opus-4-5': { ignore: true },
              bad1: 'nope',
              bad2: { tier: 'huge', rank: 'x', pin: 'yes' },
              bad3: [],
              empty: {}
            }
          }
        })
      );
      expect(loadOverrides(file)).toEqual({
        'claude-sonnet-5': { tier: 'standard', rank: 3, pin: true },
        'claude-opus-4-5': { ignore: true }
      });
    });

    it('returns {} for a missing file, corrupt JSON, or a missing or malformed models.overrides', () => {
      expect(loadOverrides(path.join(dir, 'nope.json'))).toEqual({});
      const corrupt = path.join(dir, 'corrupt.json');
      fs.writeFileSync(corrupt, '{ not json');
      expect(loadOverrides(corrupt)).toEqual({});
      for (const body of [{}, { models: 'x' }, { models: { overrides: [] } }, { models: { overrides: 5 } }, []]) {
        const f = path.join(dir, 'x.json');
        fs.writeFileSync(f, JSON.stringify(body));
        expect(loadOverrides(f)).toEqual({});
      }
    });

    it('defaults to JEV_CONFIG_FILE', () => {
      const file = path.join(dir, 'env.json');
      fs.writeFileSync(file, JSON.stringify({ models: { overrides: { x: { ignore: true } } } }));
      const saved = process.env.JEV_CONFIG_FILE;
      process.env.JEV_CONFIG_FILE = file;
      try {
        expect(loadOverrides()).toEqual({ x: { ignore: true } });
      } finally {
        if (saved === undefined) delete process.env.JEV_CONFIG_FILE;
        else process.env.JEV_CONFIG_FILE = saved;
      }
    });
  });
});

describe('staleness', () => {
  const cat = buildCatalogue('claude-code', ACCOUNT, 'probe', null, T0);

  it('is stale after more than 7 days and very stale after more than 21', () => {
    expect(isStale(cat, daysLater(0))).toBe(false);
    expect(isStale(cat, daysLater(7))).toBe(false);
    expect(isStale(cat, new Date(daysLater(7).getTime() + 1))).toBe(true);
    expect(isVeryStale(cat, daysLater(7.5))).toBe(false);
    expect(isVeryStale(cat, daysLater(21))).toBe(false);
    expect(isVeryStale(cat, new Date(daysLater(21).getTime() + 1))).toBe(true);
  });

  it('honours maxAgeDays', () => {
    expect(isStale(cat, daysLater(2), 1)).toBe(true);
    expect(isStale(cat, daysLater(2), 3)).toBe(false);
    expect(isVeryStale(cat, daysLater(4), 1)).toBe(true);
    expect(isVeryStale(cat, daysLater(2), 1)).toBe(false);
  });

  it('treats an unreadable timestamp as very stale', () => {
    const bad = { ...cat, updated_at: 'garbage' };
    expect(isStale(bad, T0)).toBe(true);
    expect(isVeryStale(bad, T0)).toBe(true);
  });
});

describe('files', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cat-')), 'models');
  });
  afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

  it('round-trips a catalogue and writes owner-only modes', () => {
    const cat = buildCatalogue('claude-code', ACCOUNT, 'probe', null, T0);
    expect(saveCatalogue(cat, dir)).toBe(true);
    const file = path.join(dir, 'claude-code.json');
    expect(cataloguePath('claude-code', dir)).toBe(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(loadCatalogue('claude-code', dir)).toEqual(cat);
    // no temp files left behind
    expect(fs.readdirSync(dir)).toEqual(['claude-code.json']);
  });

  it('writes the documented shape', () => {
    saveCatalogue(buildCatalogue('claude-code', [ok('claude-haiku-5-5', 'haiku'), fail('claude-haiku-5')], 'probe', null, T0), dir);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'claude-code.json'), 'utf8'));
    expect(raw).toMatchObject({ version: 1, harness: 'claude-code', source: 'probe', updated_at: T0.toISOString() });
    expect(raw.models[0]).toMatchObject({ id: 'claude-haiku-5-5', family: 'haiku', version: [5, 5], tier: 'cheap', alias: 'haiku', status: 'ok', strikes: 0 });
  });

  it('survives -latest ids (Infinity is not JSON)', () => {
    const cat = buildCatalogue('opencode', [ok('~anthropic/claude-sonnet-latest'), ok('anthropic/claude-sonnet-4.5')], 'openrouter', null, T0);
    expect(cat.models.find((m) => m.id.endsWith('latest'))!.version).toEqual([Infinity]);
    expect(saveCatalogue(cat, dir)).toBe(true);
    const back = loadCatalogue('opencode', dir)!;
    expect(back).toEqual(cat);
    expect(ladder(back, 'standard')[0]).toBe('~anthropic/claude-sonnet-latest');
  });

  it('tightens the modes of an existing loose directory and file', () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'claude-code.json'), '{}', { mode: 0o644 });
    fs.chmodSync(path.join(dir, 'claude-code.json'), 0o644);
    saveCatalogue(buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', null, T0), dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'claude-code.json')).mode & 0o777).toBe(0o600);
  });

  it('a failed save returns false, throws nothing and leaves no temp file', () => {
    const cat = buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', null, T0);
    // the target is a non-empty directory, so the final rename fails after the temp file was written
    fs.mkdirSync(path.join(dir, 'claude-code.json'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude-code.json', 'keep'), 'x');
    expect(saveCatalogue(cat, dir)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['claude-code.json']);
    // and an unusable directory path
    const blocker = path.join(path.dirname(dir), 'file');
    fs.writeFileSync(blocker, 'x');
    expect(saveCatalogue(cat, path.join(blocker, 'models'))).toBe(false);
  });

  it('refuses harness names that are not plain identifiers', () => {
    const cat = buildCatalogue('../evil', [ok('claude-sonnet-5-5')], 'probe', null, T0);
    expect(cataloguePath('../evil', dir)).toBeNull();
    expect(saveCatalogue(cat, dir)).toBe(false);
    expect(loadCatalogue('../evil', dir)).toBeNull();
  });

  it('defaults the directory to ~/.config/jev/models from os.homedir()', () => {
    expect(cataloguePath('claude-code')).toBe(path.join(os.homedir(), '.config', 'jev', 'models', 'claude-code.json'));
  });

  describe('reading never throws', () => {
    const write = (body: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'claude-code.json'), body);
    };
    const good = () => JSON.parse(JSON.stringify(buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', null, T0)));

    it('returns null for a missing file or directory', () => {
      expect(loadCatalogue('claude-code', dir)).toBeNull();
      fs.mkdirSync(dir, { recursive: true });
      expect(loadCatalogue('claude-code', dir)).toBeNull();
    });

    it('returns null for corrupt, empty, or non-object content', () => {
      for (const body of ['', '{ nope', 'null', '[]', '42', '"x"']) {
        write(body);
        expect(loadCatalogue('claude-code', dir)).toBeNull();
      }
    });

    it('returns null for a wrong version, wrong harness, or wrong shape', () => {
      const cases: Array<(c: any) => void> = [
        (c) => (c.version = 2),
        (c) => delete c.version,
        (c) => (c.harness = 'opencode'),
        (c) => (c.models = 'x'),
        (c) => delete c.models,
        (c) => (c.updated_at = 'garbage'),
        (c) => (c.source = 'telepathy')
      ];
      for (const mutate of cases) {
        const c = good();
        mutate(c);
        write(JSON.stringify(c));
        expect(loadCatalogue('claude-code', dir)).toBeNull();
      }
    });

    it('returns null when the path is a directory', () => {
      fs.mkdirSync(path.join(dir, 'claude-code.json'), { recursive: true });
      expect(loadCatalogue('claude-code', dir)).toBeNull();
    });

    it('drops malformed entries but keeps the good ones', () => {
      const c = good();
      c.models.push({ id: 'x' }, null, 5, { ...c.models[0], id: 'bad-tier', tier: 'huge' });
      write(JSON.stringify(c));
      expect(loadCatalogue('claude-code', dir)!.models.map((m) => m.id)).toEqual(['claude-sonnet-5-5']);
    });
  });

  describe('markSuspect', () => {
    it('sets status missing, keeps strikes at 1, and saves without refreshing updated_at', () => {
      saveCatalogue(buildCatalogue('claude-code', [ok('claude-sonnet-5-5'), ok('claude-sonnet-5')], 'probe', null, T0), dir);
      expect(markSuspect('claude-code', 'claude-sonnet-5-5', dir)).toBe(true);
      const cat = loadCatalogue('claude-code', dir)!;
      expect(cat.models.find((m) => m.id === 'claude-sonnet-5-5')).toMatchObject({ status: 'missing', strikes: 1 });
      expect(cat.updated_at).toBe(T0.toISOString());
      expect(ladder(cat, 'standard')).toEqual(['claude-sonnet-5']);
    });

    it('never raises strikes above what the id already had, and never lowers them', () => {
      let cat = buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', null, T0);
      cat = buildCatalogue('claude-code', [fail('claude-sonnet-5-5')], 'probe', cat, daysLater(1));
      cat = buildCatalogue('claude-code', [fail('claude-sonnet-5-5')], 'probe', cat, daysLater(2));
      saveCatalogue(cat, dir);
      markSuspect('claude-code', 'claude-sonnet-5-5', dir);
      markSuspect('claude-code', 'claude-sonnet-5-5', dir);
      expect(loadCatalogue('claude-code', dir)!.models[0].strikes).toBe(2);
    });

    it('repeated marks leave strikes at 1 for a previously healthy id', () => {
      saveCatalogue(buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', null, T0), dir);
      markSuspect('claude-code', 'claude-sonnet-5-5', dir);
      markSuspect('claude-code', 'claude-sonnet-5-5', dir);
      expect(loadCatalogue('claude-code', dir)!.models[0].strikes).toBe(1);
    });

    it('a later successful probe revives the id', () => {
      saveCatalogue(buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', null, T0), dir);
      markSuspect('claude-code', 'claude-sonnet-5-5', dir);
      const next = buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', loadCatalogue('claude-code', dir), daysLater(1));
      expect(next.models[0]).toMatchObject({ status: 'ok', strikes: 0 });
    });

    it('returns false without a catalogue, for an id that is not in it, and never throws', () => {
      expect(markSuspect('claude-code', 'claude-sonnet-5-5', dir)).toBe(false);
      saveCatalogue(buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', null, T0), dir);
      expect(markSuspect('claude-code', 'claude-sonnet-9', dir)).toBe(false);
      expect(markSuspect('../evil', 'x', dir)).toBe(false);
    });

    it('keeps needs-review entries listed', () => {
      saveCatalogue(buildCatalogue('claude-code', [ok('claude-zephyr-1')], 'probe', null, T0), dir);
      markSuspect('claude-code', 'claude-zephyr-1', dir);
      const cat = loadCatalogue('claude-code', dir)!;
      expect(unknownIds(cat)).toEqual(['claude-zephyr-1']);
    });
  });
});

describe('resolveTier', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-res-')), 'models');
  });
  afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

  const opts = (extra = {}) => ({ dir, now: T0, overrides: {}, defaults: CLAUDE_DEFAULTS, ...extra });

  it('uses the catalogue: ordered ids, native alias of the preferred id, fresh', () => {
    saveCatalogue(buildCatalogue('claude-code', ACCOUNT, 'probe', null, T0), dir);
    expect(resolveTier('claude-code', 'standard', opts())).toEqual({
      ids: ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-5'],
      alias: 'sonnet',
      source: 'catalogue',
      stale: false,
      veryStale: false
    });
    expect(resolveTier('claude-code', 'cheap', opts()).ids[0]).toBe('claude-haiku-5-5');
  });

  it('omits the alias when the preferred id has none', () => {
    saveCatalogue(buildCatalogue('claude-code', [ok('claude-sonnet-5')], 'probe', null, T0), dir);
    expect(resolveTier('claude-code', 'standard', opts())).toEqual({ ids: ['claude-sonnet-5'], source: 'catalogue', stale: false, veryStale: false });
  });

  it('reports stale and very stale catalogues but still uses them', () => {
    saveCatalogue(buildCatalogue('claude-code', ACCOUNT, 'probe', null, T0), dir);
    const eight = resolveTier('claude-code', 'deep', opts({ now: daysLater(8) }));
    expect(eight).toMatchObject({ source: 'catalogue', stale: true, veryStale: false });
    const thirty = resolveTier('claude-code', 'deep', opts({ now: daysLater(30) }));
    expect(thirty).toMatchObject({ source: 'catalogue', stale: true, veryStale: true });
    expect(thirty.ids[0]).toBe('claude-opus-5-5');
  });

  it('applies overrides', () => {
    saveCatalogue(buildCatalogue('claude-code', ACCOUNT, 'probe', null, T0), dir);
    const r = resolveTier('claude-code', 'standard', opts({ overrides: { 'claude-sonnet-5-5': { ignore: true } } }));
    expect(r.ids).toEqual(['claude-sonnet-5', 'claude-sonnet-4-5']);
    expect(r.alias).toBeUndefined();
  });

  it('falls back to the shipped alias defaults when the catalogue is missing', () => {
    expect(resolveTier('claude-code', 'standard', opts())).toEqual({ ids: ['sonnet'], alias: 'sonnet', source: 'defaults', stale: false, veryStale: false });
    expect(resolveTier('claude-code', 'cheap', opts()).ids).toEqual(['haiku']);
    expect(resolveTier('claude-code', 'deep', opts()).ids).toEqual(['opus']);
  });

  it('falls back when the catalogue is corrupt or the wrong version', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude-code.json'), '{ corrupt');
    expect(resolveTier('claude-code', 'standard', opts())).toMatchObject({ source: 'defaults', ids: ['sonnet'], alias: 'sonnet' });
    fs.writeFileSync(path.join(dir, 'claude-code.json'), JSON.stringify({ version: 99, harness: 'claude-code', models: [] }));
    expect(resolveTier('claude-code', 'standard', opts())).toMatchObject({ source: 'defaults' });
  });

  it('falls back for a tier the catalogue cannot serve (free, or every id missing)', () => {
    saveCatalogue(buildCatalogue('claude-code', [ok('claude-sonnet-5-5'), fail('claude-haiku-5-5')], 'probe', null, T0), dir);
    expect(resolveTier('claude-code', 'free', opts())).toMatchObject({ source: 'defaults', ids: ['openrouter/free'] });
    expect(resolveTier('claude-code', 'free', opts()).alias).toBeUndefined();
    expect(resolveTier('claude-code', 'cheap', opts())).toMatchObject({ source: 'defaults', ids: ['haiku'] });
  });

  it('opencode defaults come from the existing map and carry no alias', () => {
    const oc = DEFAULT_JEV_CONFIG.harnesses!.opencode!.models as HarnessModelMap;
    const r = resolveTier('opencode', 'standard', opts({ defaults: oc }));
    expect(r).toMatchObject({ source: 'defaults', ids: ['~anthropic/claude-sonnet-latest'] });
    expect(r.alias).toBeUndefined();
  });

  it('reads the user config for defaults and overrides when none are passed', () => {
    const saved = process.env.JEV_CONFIG_FILE;
    const cfg = path.join(path.dirname(dir), 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ harnesses: { 'claude-code': { models: { standard: 'sonnet' } } }, models: { overrides: { 'claude-sonnet-5-5': { ignore: true } } } }));
    process.env.JEV_CONFIG_FILE = cfg;
    try {
      saveCatalogue(buildCatalogue('claude-code', ACCOUNT, 'probe', null, T0), dir);
      expect(resolveTier('claude-code', 'standard', { dir, now: T0 }).ids[0]).toBe('claude-sonnet-5');
      expect(resolveTier('claude-code', 'free', { dir, now: T0 }).source).toBe('defaults');
    } finally {
      if (saved === undefined) delete process.env.JEV_CONFIG_FILE;
      else process.env.JEV_CONFIG_FILE = saved;
    }
  });

  it('an unknown alias resolves to nothing instead of guessing', () => {
    const cat = buildCatalogue('claude-code', ACCOUNT, 'probe', null, T0);
    expect(resolveAlias(cat, 'mystery')).toBeNull();
    expect(resolveAlias(null, 'sonnet')).toBeNull();
    expect(compareModels('mystery', 'sonnet', cat)).toBeNull();
  });
});

describe('list prices', () => {
  const price = (inputPerM: number, outputPerM: number, at = T0.toISOString()): ModelPrice => ({ inputPerM, outputPerM, source: 'openrouter', at });
  const model = (id: string, p?: ModelPrice): CatalogueModel => {
    const m = buildCatalogue('claude-code', [ok(id)], 'probe', null, T0).models[0];
    if (p) m.price = p;
    return m;
  };

  describe('priceOf and cheaperThan', () => {
    it('priceOf is input plus output per million, or null without a usable price', () => {
      expect(priceOf(model('claude-sonnet-5-5', price(2, 10)))).toBe(12);
      expect(priceOf(model('claude-haiku-5-5', price(0.1, 0.5)))).toBeCloseTo(0.6, 10);
      expect(priceOf(model('claude-sonnet-5-5'))).toBeNull();
      expect(priceOf(null)).toBeNull();
      expect(priceOf(undefined)).toBeNull();
      expect(priceOf({ price: { inputPerM: NaN, outputPerM: 1, source: 'openrouter', at: T0.toISOString() } } as any)).toBeNull();
      expect(priceOf({ price: { inputPerM: -1, outputPerM: 1, source: 'openrouter', at: T0.toISOString() } } as any)).toBeNull();
    });

    it('a free model has a price of 0, not null', () => {
      expect(priceOf(model('claude-sonnet-5-5', price(0, 0)))).toBe(0);
    });

    it('cheaperThan is true only when both have prices and a is strictly lower', () => {
      const haiku = model('claude-haiku-5-5', price(0.1, 0.5));
      const sonnet = model('claude-sonnet-5-5', price(2, 10));
      const sonnet5 = model('claude-sonnet-5', price(2, 10));
      const unpriced = model('claude-opus-5');
      expect(cheaperThan(haiku, sonnet)).toBe(true);
      expect(cheaperThan(sonnet, haiku)).toBe(false);
      expect(cheaperThan(sonnet, sonnet5)).toBe(false); // equal is not cheaper
      expect(cheaperThan(unpriced, sonnet)).toBe(false);
      expect(cheaperThan(haiku, unpriced)).toBe(false);
      expect(cheaperThan(unpriced, unpriced)).toBe(false);
      expect(cheaperThan(null, sonnet)).toBe(false);
      expect(cheaperThan(haiku, undefined)).toBe(false);
      expect(cheaperThan(model('claude-haiku-5-5', price(0, 0)), sonnet)).toBe(true);
    });

    it('orders the observed ladder strictly by price', () => {
      const ladderPrices: Array<[string, number, number]> = [
        ['claude-haiku-5-5', 0.1, 0.5], ['claude-haiku-4-5', 1, 5], ['claude-sonnet-5-5', 2, 10],
        ['claude-sonnet-4-5', 3, 15], ['claude-opus-5-5', 4, 20], ['claude-opus-5', 5, 25], ['claude-fable-5-2', 8, 40]
      ];
      const ms = ladderPrices.map(([id, i, o]) => model(id, price(i, o)));
      for (let i = 0; i < ms.length - 1; i++) expect(cheaperThan(ms[i], ms[i + 1])).toBe(true);
    });
  });

  describe('storage', () => {
    let dir: string;
    beforeEach(() => {
      dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-price-')), 'models');
    });
    afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
    const write = (body: unknown) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'claude-code.json'), JSON.stringify(body));
    };
    const fileWith = (extra: Record<string, unknown>) => {
      const body = JSON.parse(JSON.stringify(buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', null, T0)));
      Object.assign(body.models[0], extra);
      return body;
    };

    it('round-trips a price and keeps the file version', () => {
      const cat = buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', null, T0);
      cat.models[0].price = price(2, 10);
      expect(saveCatalogue(cat, dir)).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'claude-code.json'), 'utf8')).version).toBe(1);
      expect(loadCatalogue('claude-code', dir)!.models[0].price).toEqual(price(2, 10));
    });

    it('loads an old file with no price unchanged (no price key appears)', () => {
      write(fileWith({}));
      const m = loadCatalogue('claude-code', dir)!.models[0];
      expect(m.id).toBe('claude-sonnet-5-5');
      expect('price' in m).toBe(false);
    });

    it('drops a malformed price but keeps the model, never throwing', () => {
      const bad: unknown[] = [
        'cheap', 5, [], {}, null,
        { inputPerM: '2', outputPerM: 10, source: 'openrouter', at: T0.toISOString() },
        { inputPerM: 2, outputPerM: 10, source: 'guess', at: T0.toISOString() },
        { inputPerM: 2, outputPerM: 10, source: 'openrouter', at: 'yesterday' },
        { inputPerM: 2, outputPerM: 10, source: 'openrouter' },
        { inputPerM: -2, outputPerM: 10, source: 'openrouter', at: T0.toISOString() },
        { inputPerM: 2, outputPerM: Infinity, source: 'openrouter', at: T0.toISOString() }
      ];
      for (const price of bad) {
        write(fileWith({ price }));
        const cat = loadCatalogue('claude-code', dir)!;
        expect(cat.models.length).toBe(1);
        expect('price' in cat.models[0]).toBe(false);
      }
    });

    it('ignores extra fields inside a price', () => {
      write(fileWith({ price: { ...price(2, 10), note: 'x' } }));
      expect(loadCatalogue('claude-code', dir)!.models[0].price).toEqual(price(2, 10));
    });
  });

  describe('buildCatalogue', () => {
    it('carries a previous price over when the id is probed again, ok or failed', () => {
      const first = buildCatalogue('claude-code', [ok('claude-sonnet-5-5'), ok('claude-opus-5')], 'probe', null, T0);
      for (const m of first.models) m.price = price(2, 10);
      const next = buildCatalogue('claude-code', [ok('claude-sonnet-5-5'), fail('claude-opus-5')], 'probe', first, daysLater(1));
      expect(next.models.find((m) => m.id === 'claude-sonnet-5-5')!.price).toEqual(price(2, 10));
      expect(next.models.find((m) => m.id === 'claude-opus-5')!.price).toEqual(price(2, 10));
    });

    it('does not add a price to an id that never had one', () => {
      const cat = buildCatalogue('claude-code', [ok('claude-sonnet-5-5')], 'probe', null, T0);
      expect('price' in cat.models[0]).toBe(false);
    });
  });
});

describe('exports', () => {
  it('is reachable through src/core/index', () => {
    for (const name of [
      'priceOf', 'cheaperThan',
      'parseModelId', 'heuristicTier', 'loadCatalogue', 'saveCatalogue', 'buildCatalogue', 'ladder', 'compareModels',
      'isStale', 'isVeryStale', 'resolveTier', 'markSuspect', 'unknownIds', 'tryLock', 'unlock'
    ]) {
      expect(typeof (core as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
