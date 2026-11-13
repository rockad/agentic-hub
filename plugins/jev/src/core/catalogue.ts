/**
 * Model catalogue (core): a per-harness list of concrete model ids with a capability tier and a version,
 * cached in `~/.config/jev/models/<harness>.json`. Pure functions plus atomic file IO; no network, no process
 * spawning. Not yet wired into the hooks.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_JEV_CONFIG, getHarnessModels, type CognitiveTier, type HarnessModelMap, type JevHarness } from './config.js';
import { privateDir, privateFile, PRIVATE_FILE_MODE } from './private-fs.js';

export type CatalogueTier = CognitiveTier;
export type CatalogueSource = 'probe' | 'openrouter' | 'static' | 'manual';
export type ModelStatus = 'ok' | 'missing' | 'needs-review';

export const CATALOGUE_VERSION = 1;
/** An id is deleted from the catalogue after this many consecutive failed probes. */
export const MAX_STRIKES = 3;
export const DEFAULT_MAX_AGE_DAYS = 7;
export const VERY_STALE_FACTOR = 3;

const TIERS: readonly CatalogueTier[] = ['free', 'cheap', 'standard', 'deep'];
const SOURCES: readonly CatalogueSource[] = ['probe', 'openrouter', 'static', 'manual'];
const STATUSES: readonly ModelStatus[] = ['ok', 'missing', 'needs-review'];
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ParsedModelId {
  /** The id as given. */
  id: string;
  /** Lowercased family: `haiku`, `sonnet`, `opus`, `fable`, `gemini`, `free`, ... */
  family: string;
  /** Numeric version, most significant first. `[Infinity]` for `-latest`, `[]` for aliases and unversioned ids. */
  version: number[];
  /** True for a `-latest` id. */
  latest: boolean;
  /** True for a bare family alias such as `sonnet`. */
  alias: boolean;
  /** Provider prefix of an OpenRouter-style id (`anthropic`, `google`), without `~`. */
  provider?: string;
}

export interface CatalogueModel {
  id: string;
  family: string;
  version: number[];
  /**
   * Heuristic tier of the family. For a `needs-review` entry this is only a placeholder (`standard`); the
   * ladder never uses such an entry unless a config override assigns it a tier.
   */
  tier: CatalogueTier;
  /** Native alias the harness resolves to this id (`haiku`, `sonnet`, ...), when the probe reported one. */
  alias?: string;
  status: ModelStatus;
  /** Consecutive failed probes. */
  strikes: number;
  last_ok?: string;
}

export interface Catalogue {
  version: 1;
  harness: string;
  updated_at: string;
  source: CatalogueSource;
  models: CatalogueModel[];
}

export interface ProbeResult {
  id: string;
  ok: boolean;
  alias?: string;
}

export interface ModelOverride {
  tier?: CatalogueTier;
  /** Position inside the tier; a higher number is stronger. Ranked ids sort ahead of unranked ones. */
  rank?: number;
  /** Prefer this id first inside its tier. */
  pin?: boolean;
  /** Remove this id from the ladder. */
  ignore?: boolean;
}
export type ModelOverrides = Record<string, ModelOverride>;

// ---------------------------------------------------------------------------------------------------------------
// Parsing and ordering
// ---------------------------------------------------------------------------------------------------------------

const NATIVE_ALIASES = new Set(['haiku', 'sonnet', 'opus', 'fable']);

/** A version component is one or two digits (`5`, `45`); longer digit runs are dates (`20250929`) and are ignored. */
function versionNumber(token: string): number | null {
  return /^\d{1,2}$/.test(token) ? Number(token) : null;
}

/** Numbers in a token such as `4.5` or `5`; null when the token is not purely numeric components. */
function versionParts(token: string): number[] | null {
  const parts = token.split('.');
  const out: number[] = [];
  for (const p of parts) {
    const n = versionNumber(p);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

/**
 * Parse a model id into family and version.
 *
 * - `claude-haiku-5-5`, `claude-sonnet-5`, `claude-opus-4-5`, `claude-fable-5-2`, `claude-sonnet-4-20250514`
 * - OpenRouter: `anthropic/claude-sonnet-4.5`, `~anthropic/claude-sonnet-latest`, `google/gemini-2.5-pro`, `openrouter/free`
 * - Legacy order `claude-3-5-sonnet`
 * - Bare aliases: `haiku`, `sonnet`, `opus`, `fable` (no version)
 *
 * Returns null for empty or non-string input.
 */
export function parseModelId(id: string): ParsedModelId | null {
  if (typeof id !== 'string') return null;
  const raw = id.trim();
  if (!raw) return null;

  let rest = raw.toLowerCase();
  if (rest.startsWith('~')) rest = rest.slice(1);
  let provider: string | undefined;
  const slash = rest.indexOf('/');
  if (slash > 0) {
    provider = rest.slice(0, slash);
    rest = rest.slice(slash + 1);
  }
  // `:free` / `:thinking` style variant suffixes
  const colon = rest.indexOf(':');
  if (colon >= 0) rest = rest.slice(0, colon);
  if (!rest) return null;

  const tokens = rest.split('-').filter(Boolean);
  if (tokens.length === 0) return null;

  const make = (family: string, version: number[], latest: boolean, alias: boolean): ParsedModelId => {
    const out: ParsedModelId = { id: raw, family, version, latest, alias };
    if (provider) out.provider = provider;
    return out;
  };

  // Legacy Claude order: claude-3-5-sonnet, claude-3.5-haiku
  if (tokens[0] === 'claude') {
    const last = tokens[tokens.length - 1];
    if (tokens.length >= 3 && /^[a-z]+$/.test(last) && last !== 'latest') {
      const numeric: number[] = [];
      let allNumeric = true;
      for (const t of tokens.slice(1, -1)) {
        const parts = versionParts(t);
        if (!parts) {
          allNumeric = false;
          break;
        }
        numeric.push(...parts);
      }
      if (allNumeric && numeric.length > 0) return make(last, numeric, false, false);
    }
    tokens.shift();
  }

  // The family is the first alphabetic token.
  const familyIdx = tokens.findIndex((t) => /^[a-z][a-z0-9]*$/.test(t) && !/^\d/.test(t));
  if (familyIdx < 0) return null;
  const family = tokens[familyIdx];

  const version: number[] = [];
  let latest = false;
  for (const t of tokens.slice(familyIdx + 1)) {
    if (t === 'latest') {
      latest = true;
      break;
    }
    const parts = versionParts(t);
    if (!parts) break;
    version.push(...parts);
  }
  if (latest) return make(family, [Infinity], true, false);

  const bare = tokens.length === 1 && !provider && raw.toLowerCase() === family;
  return make(family, version, false, bare && NATIVE_ALIASES.has(family));
}

/** Tier implied by the family name; null for a family Jev does not know (the id then needs review). */
export function heuristicTier(family: string): CatalogueTier | null {
  switch ((family || '').toLowerCase()) {
    case 'haiku':
      return 'cheap';
    case 'sonnet':
      return 'standard';
    case 'opus':
    case 'fable':
      return 'deep';
    default:
      return null;
  }
}

/** Compare version arrays numerically, padding the shorter one with zeros: `[5] < [5, 5]`, `[4, 5] < [5]`. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x === y) continue;
    return x < y ? -1 : 1;
  }
  return 0;
}

const TIER_ORDER: Record<CatalogueTier, number> = { free: 0, cheap: 1, standard: 2, deep: 3 };
/** Tie-break inside a tier for equal versions: fable is stronger than opus. */
const FAMILY_TIEBREAK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

function tierOf(
  id: string,
  parsed: ParsedModelId | null,
  cat: Catalogue | null | undefined,
  overrides: ModelOverrides | undefined
): CatalogueTier | null {
  const o = overrides?.[id];
  if (o?.tier) return o.tier;
  const entry = cat?.models.find((m) => m.id === id);
  if (entry && entry.status !== 'needs-review') return entry.tier;
  return parsed ? heuristicTier(parsed.family) : null;
}

/**
 * Newest usable (status `ok`, not ignored) id of a family in the catalogue, for resolving an alias such as
 * `sonnet`. Null when the catalogue has none.
 */
export function resolveAlias(cat: Catalogue | null | undefined, alias: string, overrides?: ModelOverrides): string | null {
  if (!cat) return null;
  const family = (alias || '').toLowerCase();
  const candidates = cat.models.filter(
    (m) => m.family === family && m.status === 'ok' && !overrides?.[m.id]?.ignore
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0].id;
}

/**
 * Version-aware ordering across families. Negative when `a` is weaker than `b`, positive when stronger, 0 when
 * equal or not comparable (an alias with no catalogue to resolve it against has no version). Null when either id
 * has an unknown family and no tier override, so the caller can treat it as unranked.
 *
 * Order: tier first (haiku < sonnet < opus and fable), then version, then family (opus < fable).
 * With a catalogue, an alias resolves to the newest id of its family. With overrides, a tier override moves an id
 * and a rank override orders ranked ids among themselves.
 */
export function compareModels(a: string, b: string, cat?: Catalogue | null, overrides?: ModelOverrides): number | null {
  const resolve = (id: string): string => {
    const p = parseModelId(id);
    if (p?.alias) return resolveAlias(cat, p.family, overrides) ?? id;
    return id;
  };
  const ida = resolve(a);
  const idb = resolve(b);
  const pa = parseModelId(ida);
  const pb = parseModelId(idb);
  const ta = tierOf(ida, pa, cat, overrides);
  const tb = tierOf(idb, pb, cat, overrides);
  if (!pa || !pb || !ta || !tb) return null;
  if (ta !== tb) return TIER_ORDER[ta] < TIER_ORDER[tb] ? -1 : 1;

  const ra = overrides?.[ida]?.rank;
  const rb = overrides?.[idb]?.rank;
  if (typeof ra === 'number' && typeof rb === 'number' && ra !== rb) return ra < rb ? -1 : 1;
  if (typeof ra === 'number' && typeof rb !== 'number') return 1;
  if (typeof rb === 'number' && typeof ra !== 'number') return -1;

  if (pa.version.length === 0 || pb.version.length === 0) return 0;
  const v = compareVersions(pa.version, pb.version);
  if (v !== 0) return v;
  const fa = FAMILY_TIEBREAK[pa.family] ?? 0;
  const fb = FAMILY_TIEBREAK[pb.family] ?? 0;
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Overrides (the optional `models.overrides` object in ~/.config/jev/config.json)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Tolerant reader for `models.overrides` in the user config. The shared config loader is deliberately left
 * untouched (its `models` map holds plain strings for the decision, router and fallback models), so this reads
 * the one key it needs and ignores everything else. Invalid entries and invalid fields are dropped; never throws.
 */
export function loadOverrides(configFile?: string): ModelOverrides {
  const file =
    configFile ?? process.env.JEV_CONFIG_FILE ?? path.join(os.homedir(), '.config', 'jev', 'config.json');
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const raw = parsed?.models?.overrides;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ModelOverrides = {};
  for (const [id, val] of Object.entries(raw)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    const v = val as Record<string, unknown>;
    const o: ModelOverride = {};
    if (typeof v.tier === 'string' && (TIERS as readonly string[]).includes(v.tier)) o.tier = v.tier as CatalogueTier;
    if (typeof v.rank === 'number' && Number.isFinite(v.rank)) o.rank = v.rank;
    if (v.pin === true) o.pin = true;
    if (v.ignore === true) o.ignore = true;
    if (Object.keys(o).length > 0) out[id] = o;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Building and ladders
// ---------------------------------------------------------------------------------------------------------------

function sortEntries(models: CatalogueModel[]): CatalogueModel[] {
  return [...models].sort((a, b) => {
    if (a.family !== b.family) return a.family < b.family ? -1 : 1;
    const v = compareVersions(b.version, a.version);
    return v !== 0 ? v : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Build the next catalogue from a round of probe results.
 *
 * Strikes rule, per probed id:
 * - success: status `ok`, strikes 0, `last_ok` = now
 * - failure: status `missing` at once (the ladder skips it), strikes + 1; at {@link MAX_STRIKES} consecutive
 *   failures the id is deleted
 * - an id with an unknown family is `needs-review` (success or failure); it is never used by the ladder
 * Ids from `previous` that were not probed this round are carried over unchanged. A `previous` for another
 * harness is ignored. Duplicate probe results for one id: the last verdict wins, and an alias reported by any of
 * them is kept.
 */
export function buildCatalogue(
  harness: string,
  probeResults: readonly ProbeResult[],
  source: CatalogueSource,
  previous?: Catalogue | null,
  now: Date = new Date()
): Catalogue {
  const nowIso = now.toISOString();
  const prev = previous && previous.harness === harness ? previous : null;
  const byId = new Map<string, CatalogueModel>();
  for (const m of prev?.models ?? []) byId.set(m.id, { ...m, version: [...m.version] });

  const latestResult = new Map<string, ProbeResult>();
  for (const r of probeResults) {
    if (!r || typeof r.id !== 'string' || !r.id.trim()) continue;
    // The last verdict wins, but an alias is never lost: the alias probe of another family that landed on this
    // id (`fable` served by opus) reports it with no alias, after the probe that did carry one.
    const alias = r.alias ?? latestResult.get(r.id)?.alias;
    latestResult.set(r.id, alias && !r.alias ? { ...r, alias } : r);
  }

  for (const r of latestResult.values()) {
    const before = byId.get(r.id);
    const parsed = parseModelId(r.id);
    const family = parsed?.family ?? 'unknown';
    const tier = parsed ? heuristicTier(parsed.family) : null;
    const known = tier !== null;

    const strikes = r.ok ? 0 : (before?.strikes ?? 0) + 1;
    if (strikes >= MAX_STRIKES) {
      byId.delete(r.id);
      continue;
    }
    const entry: CatalogueModel = {
      id: r.id,
      family,
      version: parsed ? [...parsed.version] : [],
      tier: tier ?? 'standard',
      status: !known ? 'needs-review' : r.ok ? 'ok' : 'missing',
      strikes
    };
    const alias = r.alias ?? before?.alias;
    if (alias) entry.alias = alias;
    if (r.ok) entry.last_ok = nowIso;
    else if (before?.last_ok) entry.last_ok = before.last_ok;
    byId.set(r.id, entry);
  }

  return {
    version: CATALOGUE_VERSION,
    harness,
    updated_at: nowIso,
    source,
    models: sortEntries([...byId.values()])
  };
}

/**
 * Concrete ids for a tier, strongest and newest first. Excludes `missing` and `needs-review` entries and ids
 * ignored by an override. An override `tier` moves an id to that tier and also makes a `needs-review` id usable.
 * Order inside the tier: pinned ids, then ranked ids (rank descending), then the rest by version descending.
 */
export function ladder(cat: Catalogue | null | undefined, tier: CatalogueTier, overrides?: ModelOverrides): string[] {
  if (!cat) return [];
  const members = cat.models.filter((m) => {
    const o = overrides?.[m.id];
    if (o?.ignore) return false;
    if (m.status === 'missing') return false;
    if (m.status === 'needs-review' && !o?.tier) return false;
    return (o?.tier ?? m.tier) === tier;
  });
  const group = (m: CatalogueModel): number => {
    const o = overrides?.[m.id];
    if (o?.pin) return 0;
    if (typeof o?.rank === 'number') return 1;
    return 2;
  };
  members.sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga === 1) {
      const d = (overrides![b.id].rank as number) - (overrides![a.id].rank as number);
      if (d !== 0) return d;
    }
    const v = compareVersions(b.version, a.version);
    if (v !== 0) return v;
    const fa = FAMILY_TIEBREAK[a.family] ?? 0;
    const fb = FAMILY_TIEBREAK[b.family] ?? 0;
    return fb - fa;
  });
  return members.map((m) => m.id);
}

/** Ids that need review: unknown family, listed for the "unknown model" warning and not used by the ladder. */
export function unknownIds(cat: Catalogue | null | undefined): string[] {
  return (cat?.models ?? []).filter((m) => m.status === 'needs-review').map((m) => m.id);
}

// ---------------------------------------------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------------------------------------------

function ageMs(cat: Catalogue, now: Date): number {
  const at = Date.parse(cat.updated_at);
  return Number.isFinite(at) ? now.getTime() - at : Infinity;
}

/** True when the catalogue is older than `maxAgeDays` (default 7), or its timestamp is unreadable. */
export function isStale(cat: Catalogue, now: Date = new Date(), maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): boolean {
  return ageMs(cat, now) > maxAgeDays * DAY_MS;
}

/** True when the catalogue is older than three times `maxAgeDays`. */
export function isVeryStale(cat: Catalogue, now: Date = new Date(), maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): boolean {
  return ageMs(cat, now) > maxAgeDays * VERY_STALE_FACTOR * DAY_MS;
}

// ---------------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------------

/** `~/.config/jev/models`, from `os.homedir()` at call time, unless `dir` overrides it. */
export function catalogueDir(dir?: string): string {
  return dir ?? path.join(os.homedir(), '.config', 'jev', 'models');
}

/** Path of the catalogue file for a harness, or null when the harness name is not a plain identifier. */
export function cataloguePath(harness: string, dir?: string): string | null {
  if (typeof harness !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(harness)) return null;
  return path.join(catalogueDir(dir), `${harness}.json`);
}

/** JSON cannot hold Infinity; `-latest` versions are written as null and revived on read. */
function encodeVersion(v: number[]): Array<number | null> {
  return v.map((n) => (Number.isFinite(n) ? n : null));
}
function decodeVersion(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const n of v) {
    if (n === null) out.push(Infinity);
    else if (typeof n === 'number' && Number.isFinite(n)) out.push(n);
    else return null;
  }
  return out;
}

function reviveModel(raw: any): CatalogueModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const version = decodeVersion(raw.version);
  if (
    typeof raw.id !== 'string' ||
    !raw.id ||
    typeof raw.family !== 'string' ||
    !version ||
    !(TIERS as readonly string[]).includes(raw.tier) ||
    !(STATUSES as readonly string[]).includes(raw.status) ||
    typeof raw.strikes !== 'number' ||
    !Number.isFinite(raw.strikes)
  ) {
    return null;
  }
  const m: CatalogueModel = {
    id: raw.id,
    family: raw.family,
    version,
    tier: raw.tier,
    status: raw.status,
    strikes: raw.strikes
  };
  if (typeof raw.alias === 'string' && raw.alias) m.alias = raw.alias;
  if (typeof raw.last_ok === 'string') m.last_ok = raw.last_ok;
  return m;
}

/**
 * Read the catalogue for a harness. Never throws: a missing, unreadable, corrupt or wrong-version file, a file
 * for another harness, or a file without a usable `models` array returns null. Individual malformed entries are
 * dropped.
 */
export function loadCatalogue(harness: string, dir?: string): Catalogue | null {
  try {
    const file = cataloguePath(harness, dir);
    if (!file) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || raw.version !== CATALOGUE_VERSION) return null;
    if (raw.harness !== harness) return null;
    if (typeof raw.updated_at !== 'string' || !Number.isFinite(Date.parse(raw.updated_at))) return null;
    if (!(SOURCES as readonly string[]).includes(raw.source)) return null;
    if (!Array.isArray(raw.models)) return null;
    const models = raw.models.map(reviveModel).filter((m: CatalogueModel | null): m is CatalogueModel => m !== null);
    return { version: CATALOGUE_VERSION, harness, updated_at: raw.updated_at, source: raw.source, models };
  } catch {
    return null;
  }
}

/**
 * Write the catalogue atomically (temp file in the same directory, then rename) with a 0700 directory and a 0600
 * file. Returns true on success and false on any failure; never throws, and a failed write leaves the previous
 * file in place.
 */
export function saveCatalogue(cat: Catalogue, dir?: string): boolean {
  let tmp: string | null = null;
  try {
    const file = cataloguePath(cat.harness, dir);
    if (!file) return false;
    privateDir(path.dirname(file));
    const body = {
      version: CATALOGUE_VERSION,
      harness: cat.harness,
      updated_at: cat.updated_at,
      source: cat.source,
      models: cat.models.map((m) => ({ ...m, version: encodeVersion(m.version) }))
    };
    tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    privateFile(tmp);
    fs.renameSync(tmp, file);
    tmp = null;
    return true;
  } catch {
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
    return false;
  }
}

/**
 * Mark an id suspect (the harness reported it as unknown): status `missing` at once, strikes raised to 1 but not
 * beyond what it already had, then save. `updated_at` is not touched, so a suspect mark never makes the catalogue
 * look fresher. A `needs-review` entry keeps its status. Returns true when the catalogue was changed and saved;
 * false when there is no catalogue, the id is not in it, or saving failed. Never throws.
 */
export function markSuspect(harness: string, id: string, dir?: string): boolean {
  try {
    const cat = loadCatalogue(harness, dir);
    if (!cat) return false;
    const entry = cat.models.find((m) => m.id === id);
    if (!entry) return false;
    if (entry.status !== 'needs-review') entry.status = 'missing';
    entry.strikes = Math.max(entry.strikes, 1);
    return saveCatalogue(cat, dir);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Resolving a tier for the hooks
// ---------------------------------------------------------------------------------------------------------------

export interface ResolveTierOptions {
  /** Catalogue directory (tests). */
  dir?: string;
  now?: Date;
  maxAgeDays?: number;
  /** Overrides; default read from the user config. */
  overrides?: ModelOverrides;
  /** Config file for the default overrides read. */
  configFile?: string;
  /** Shipped alias defaults; default is the existing per-harness tier map from the config. */
  defaults?: HarnessModelMap;
}

export interface ResolvedTier {
  /** Concrete ids, preferred first. From the defaults, the single default model. */
  ids: string[];
  /** Native alias for the preferred id, when there is one (`sonnet`). */
  alias?: string;
  source: 'catalogue' | 'defaults';
  /** The catalogue is older than the staleness threshold (always false for `defaults`). */
  stale: boolean;
  /** The catalogue is older than three times the threshold (always false for `defaults`). */
  veryStale: boolean;
}

/**
 * Resolve a tier to model ids for a harness. Uses the catalogue when it exists and has at least one usable id in
 * the tier; otherwise (missing, corrupt, or empty tier) falls back to the shipped alias defaults from the config
 * map, so callers can say "run /jev-refresh". Never throws, never touches the network.
 */
export function resolveTier(harness: JevHarness | string, tier: CatalogueTier, opts: ResolveTierOptions = {}): ResolvedTier {
  const now = opts.now ?? new Date();
  const maxAge = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const cat = loadCatalogue(harness, opts.dir);
  if (cat) {
    const overrides = opts.overrides ?? loadOverrides(opts.configFile);
    const ids = ladder(cat, tier, overrides);
    if (ids.length > 0) {
      const top = cat.models.find((m) => m.id === ids[0]);
      const out: ResolvedTier = {
        ids,
        source: 'catalogue',
        stale: isStale(cat, now, maxAge),
        veryStale: isVeryStale(cat, now, maxAge)
      };
      if (top?.alias) out.alias = top.alias;
      return out;
    }
  }
  return defaultsFor(harness, tier, opts.defaults);
}

function defaultsFor(harness: string, tier: CatalogueTier, given?: HarnessModelMap): ResolvedTier {
  let map: HarnessModelMap | undefined = given;
  if (!map) {
    try {
      map = getHarnessModels(harness as JevHarness);
    } catch {
      map = undefined;
    }
  }
  map ??= (DEFAULT_JEV_CONFIG.harnesses?.['claude-code']?.models as HarnessModelMap);
  const model = map[tier];
  const out: ResolvedTier = { ids: model ? [model] : [], source: 'defaults', stale: false, veryStale: false };
  if (model && NATIVE_ALIASES.has(model.toLowerCase())) out.alias = model;
  return out;
}
