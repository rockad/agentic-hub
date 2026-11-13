import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs, runCli, summarise, REFRESH_LOCK_STALE_MS, type CliDeps } from '../src/refresh/cli.js';
import { loadRefreshConfig, readAttempt, ABSOLUTE_MAX_CALLS, DEFAULT_MAX_CALLS } from '../src/refresh/config.js';
import { KNOWN_CLAUDE_IDS } from '../src/refresh/claude-code.js';
import { buildCatalogue, cataloguePath, loadCatalogue, saveCatalogue, type Catalogue } from '../src/core/catalogue.js';
import { clearConfigCacheForTesting } from '../src/core/config.js';
import { refreshLockPath } from '../src/refresh/config.js';
import { tryLock } from '../src/core/lock.js';
import type { SpawnResult, Spawner } from '../src/refresh/spawn.js';

const SCRIPT = path.join(import.meta.dir, '..', 'scripts', 'jev-models.ts');
const NOW = new Date('2026-11-13T10:00:00.000Z');

let root = '';
let dir = '';
let configFile = '';
let savedConfigEnv: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cli-'));
  dir = path.join(root, 'models');
  configFile = path.join(root, 'config.json');
  savedConfigEnv = process.env.JEV_CONFIG_FILE;
  process.env.JEV_CONFIG_FILE = configFile;
  clearConfigCacheForTesting();
});
afterEach(() => {
  if (savedConfigEnv === undefined) delete process.env.JEV_CONFIG_FILE;
  else process.env.JEV_CONFIG_FILE = savedConfigEnv;
  clearConfigCacheForTesting();
  fs.rmSync(root, { recursive: true, force: true });
});

const done = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const okJson = (id: string): string =>
  JSON.stringify({ type: 'result', is_error: false, result: 'OK', total_cost_usd: 0.01, modelUsage: { [id]: { costUSD: 0.01 } } });
const REJECTED = JSON.stringify({ type: 'result', is_error: true, result: "There's an issue with the selected model (x). It may not exist or you may not have access to it.", total_cost_usd: 0, modelUsage: {} });
const ALIASES: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' };

function fakeClaude(account: readonly string[]) {
  const calls: string[] = [];
  const spawn: Spawner = async (_c, args) => {
    const want = args[args.indexOf('--model') + 1];
    calls.push(want);
    if (ALIASES[want]) return done(okJson(ALIASES[want]));
    return account.includes(want) ? done(okJson(want)) : done(REJECTED);
  };
  return { spawn, calls };
}

function harness(extra: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = { dir, configFile, now: () => NOW, out: (l) => out.push(l), err: (l) => err.push(l), tmpRoot: root, ...extra };
  return { deps, out, err, text: () => out.join('\n') };
}

describe('argument parsing', () => {
  it('parses the three subcommands and their options', () => {
    expect(parseArgs(['refresh'])).toEqual({ command: 'refresh', harness: 'claude-code', quiet: false, json: false });
    expect(parseArgs(['refresh', '--harness', 'opencode', '--max-calls', '4', '--quiet'])).toEqual({
      command: 'refresh',
      harness: 'opencode',
      maxCalls: 4,
      quiet: true,
      json: false
    });
    expect(parseArgs(['refresh', '--harness=antigravity', '--max-calls=7'])).toMatchObject({ harness: 'antigravity', maxCalls: 7 });
    expect(parseArgs(['status'])).toMatchObject({ command: 'status' });
    expect(parseArgs(['list', '--json'])).toMatchObject({ command: 'list', json: true });
  });

  it('shows help for no command, help and --help', () => {
    for (const argv of [[], ['help'], ['--help']]) expect(parseArgs(argv)).toMatchObject({ command: 'help' });
  });

  it('rejects an unknown command, option, harness or call count', () => {
    expect(parseArgs(['frobnicate']).error).toContain('unknown command');
    expect(parseArgs(['refresh', '--bogus']).error).toContain('unknown option');
    expect(parseArgs(['refresh', '--harness', 'cli']).error).toContain('--harness');
    expect(parseArgs(['refresh', '--harness']).error).toContain('--harness');
    for (const bad of ['0', '-1', '3.5', 'abc', '101', '']) expect(parseArgs(['refresh', '--max-calls', bad]).error).toContain('--max-calls');
    expect(parseArgs(['refresh', '--max-calls']).error).toContain('--max-calls');
  });
});

describe('refresh config reader', () => {
  it('defaults: enabled, 7 days, 20 calls, no extra candidates', () => {
    expect(loadRefreshConfig(configFile)).toEqual({ enabled: true, maxAgeDays: 7, maxCalls: DEFAULT_MAX_CALLS, minRetryHours: 6, candidates: [] });
    expect(DEFAULT_MAX_CALLS).toBe(20);
  });

  it('reads minRetryHours and drops an invalid one', () => {
    fs.writeFileSync(configFile, JSON.stringify({ models: { refresh: { minRetryHours: 2.5 } } }));
    expect(loadRefreshConfig(configFile).minRetryHours).toBe(2.5);
    fs.writeFileSync(configFile, JSON.stringify({ models: { refresh: { minRetryHours: 0 } } }));
    expect(loadRefreshConfig(configFile).minRetryHours).toBe(6);
    fs.writeFileSync(configFile, JSON.stringify({ models: { refresh: { minRetryHours: 'soon' } } }));
    expect(loadRefreshConfig(configFile).minRetryHours).toBe(6);
  });

  it('reads the four keys and drops invalid values', () => {
    fs.writeFileSync(configFile, JSON.stringify({ models: { refresh: { enabled: false, maxAgeDays: 3, maxCalls: 8, candidates: ['claude-sonnet-6', 'claude-sonnet-6', 7, '', 'bad id; rm', '--model'] } } }));
    expect(loadRefreshConfig(configFile)).toEqual({ enabled: false, maxAgeDays: 3, maxCalls: 8, minRetryHours: 6, candidates: ['claude-sonnet-6'] });
    fs.writeFileSync(configFile, JSON.stringify({ models: { refresh: { enabled: 'no', maxAgeDays: -2, maxCalls: 'many', candidates: 'x' } } }));
    expect(loadRefreshConfig(configFile)).toEqual({ enabled: true, maxAgeDays: 7, maxCalls: 20, minRetryHours: 6, candidates: [] });
    fs.writeFileSync(configFile, '{ not json');
    expect(loadRefreshConfig(configFile).enabled).toBe(true);
    fs.writeFileSync(configFile, JSON.stringify({ models: { refresh: [] } }));
    expect(loadRefreshConfig(configFile).maxCalls).toBe(20);
  });

  it('caps maxCalls at 25 (25 probes at the 60 s timeout stay under the 30 minute lock stale time)', () => {
    fs.writeFileSync(configFile, JSON.stringify({ models: { refresh: { maxCalls: 5000 } } }));
    expect(loadRefreshConfig(configFile).maxCalls).toBe(25);
    expect(ABSOLUTE_MAX_CALLS * 60_000).toBeLessThan(REFRESH_LOCK_STALE_MS);
  });
});

describe('refresh command (Claude Code)', () => {
  it('probes, writes the catalogue, and summarises new ids and the cost', async () => {
    const { spawn, calls } = fakeClaude([...KNOWN_CLAUDE_IDS]);
    const h = harness({ spawn });
    expect(await runCli(['refresh', '--max-calls', '25'], h.deps)).toBe(0);

    const cat = loadCatalogue('claude-code', dir)!;
    expect(cat.source).toBe('probe');
    expect(cat.updated_at).toBe(NOW.toISOString());
    expect(cat.models.map((m) => m.id).sort()).toEqual([...KNOWN_CLAUDE_IDS].sort());
    expect(cat.models.find((m) => m.id === 'claude-sonnet-5-5')).toMatchObject({ alias: 'sonnet', tier: 'standard', status: 'ok' });
    expect(calls.length).toBeLessThanOrEqual(25);
    expect(h.text()).toContain('new: ');
    expect(h.text()).toContain('claude-fable-5-2');
    expect(h.text()).toMatch(/probe calls: \d+ of at most 25, cost \$0\.\d+/);
    expect(fs.existsSync(refreshLockPath('claude-code', dir))).toBe(false);
    expect(fs.statSync(cataloguePath('claude-code', dir)!).mode & 0o777).toBe(0o600);
  });

  it('uses config maxCalls when no flag is given, and the flag wins over it', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ models: { refresh: { maxCalls: 5 } } }));
    const a = fakeClaude([...KNOWN_CLAUDE_IDS]);
    await runCli(['refresh'], harness({ spawn: a.spawn }).deps);
    expect(a.calls.length).toBe(5);

    const b = fakeClaude([...KNOWN_CLAUDE_IDS]);
    await runCli(['refresh', '--max-calls', '6'], harness({ spawn: b.spawn }).deps);
    expect(b.calls.length).toBe(6);
  });

  it('logs the capped candidates in the output', async () => {
    const { spawn } = fakeClaude([...KNOWN_CLAUDE_IDS]);
    const h = harness({ spawn });
    await runCli(['refresh', '--max-calls', '4'], h.deps);
    expect(h.text()).toContain('call cap (4) reached');
    expect(h.text()).toContain('not probed (call cap): ');
  });

  it('adds user candidates from the config', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ models: { refresh: { candidates: ['claude-sonnet-5-1'] } } }));
    const { spawn, calls } = fakeClaude([...KNOWN_CLAUDE_IDS, 'claude-sonnet-5-1']);
    await runCli(['refresh', '--max-calls', '25'], harness({ spawn }).deps);
    expect(calls).toContain('claude-sonnet-5-1');
    expect(loadCatalogue('claude-code', dir)!.models.map((m) => m.id)).toContain('claude-sonnet-5-1');
  });

  it('prints nothing with --quiet', async () => {
    const { spawn } = fakeClaude([...KNOWN_CLAUDE_IDS]);
    const h = harness({ spawn });
    expect(await runCli(['refresh', '--quiet', '--max-calls', '10'], h.deps)).toBe(0);
    expect(h.out).toEqual([]);
    expect(h.err).toEqual([]);
    expect(loadCatalogue('claude-code', dir)).not.toBeNull();
  });

  it('applies the strikes rule across refresh cycles: missing at once, deleted at the third failed probe', async () => {
    const all = [...KNOWN_CLAUDE_IDS];
    await runCli(['refresh', '--max-calls', '25'], harness({ spawn: fakeClaude(all).spawn }).deps);
    expect(loadCatalogue('claude-code', dir)!.models.find((m) => m.id === 'claude-opus-4-5')?.status).toBe('ok');

    const without = all.filter((id) => id !== 'claude-opus-4-5');
    const entry = () => loadCatalogue('claude-code', dir)!.models.find((m) => m.id === 'claude-opus-4-5');

    const first = harness({ spawn: fakeClaude(without).spawn });
    await runCli(['refresh', '--max-calls', '25'], first.deps);
    expect(entry()).toMatchObject({ status: 'missing', strikes: 1 });
    expect(first.text()).toContain('missing: claude-opus-4-5');

    await runCli(['refresh', '--max-calls', '25'], harness({ spawn: fakeClaude(without).spawn }).deps);
    expect(entry()).toMatchObject({ status: 'missing', strikes: 2 });

    const third = harness({ spawn: fakeClaude(without).spawn });
    await runCli(['refresh', '--max-calls', '25'], third.deps);
    expect(entry()).toBeUndefined();
    expect(third.text()).toContain('removed: claude-opus-4-5');

    // the id comes back: a new entry, strikes 0
    const back = harness({ spawn: fakeClaude(all).spawn });
    await runCli(['refresh', '--max-calls', '25'], back.deps);
    expect(entry()).toMatchObject({ status: 'ok', strikes: 0 });
  });

  it('a speculative neighbour that does not exist never enters the catalogue', async () => {
    await runCli(['refresh', '--max-calls', '25'], harness({ spawn: fakeClaude([...KNOWN_CLAUDE_IDS]).spawn }).deps);
    const ids = loadCatalogue('claude-code', dir)!.models.map((m) => m.id);
    expect(ids).not.toContain('claude-sonnet-6');
  });

  it('picks up a new model that appears as a neighbour', async () => {
    const h = harness({ spawn: fakeClaude([...KNOWN_CLAUDE_IDS, 'claude-sonnet-5-6']).spawn });
    await runCli(['refresh', '--max-calls', '25'], h.deps);
    expect(loadCatalogue('claude-code', dir)!.models.map((m) => m.id)).toContain('claude-sonnet-5-6');
    expect(h.text()).toContain('claude-sonnet-5-6');
  });

  it('moves an alias to the id it resolves to now', async () => {
    await runCli(['refresh', '--max-calls', '4'], harness({ spawn: fakeClaude([]).spawn }).deps);
    expect(loadCatalogue('claude-code', dir)!.models.find((m) => m.id === 'claude-sonnet-5-5')?.alias).toBe('sonnet');
    const spawn: Spawner = async (_c, args) => {
      const want = args[args.indexOf('--model') + 1];
      return done(okJson(want === 'sonnet' ? 'claude-sonnet-6' : ALIASES[want] ?? want));
    };
    await runCli(['refresh', '--max-calls', '4'], harness({ spawn }).deps);
    const models = loadCatalogue('claude-code', dir)!.models;
    expect(models.find((m) => m.id === 'claude-sonnet-6')?.alias).toBe('sonnet');
    expect(models.find((m) => m.id === 'claude-sonnet-5-5')?.alias).toBeUndefined();
  });

  it('leaves the catalogue untouched and exits 1 when no probe got an answer', async () => {
    const before = buildCatalogue('claude-code', [{ id: 'claude-sonnet-5-5', ok: true }], 'probe', null, new Date('2026-11-01T00:00:00Z'));
    saveCatalogue(before, dir);
    const spawn: Spawner = async () => ({ code: null, stdout: '', stderr: '', timedOut: true });
    const h = harness({ spawn });
    expect(await runCli(['refresh'], h.deps)).toBe(1);
    expect(loadCatalogue('claude-code', dir)).toEqual(before);
    expect(h.err.join('\n')).toContain('catalogue unchanged');
    expect(fs.existsSync(refreshLockPath('claude-code', dir))).toBe(false);
  });

  it('a round where every probe says "command not found" leaves a good catalogue and its age alone, and exits 1', async () => {
    const before = buildCatalogue(
      'claude-code',
      [
        { id: 'claude-sonnet-5-5', ok: true, alias: 'sonnet' },
        { id: 'claude-opus-5-5', ok: true, alias: 'opus' },
        { id: 'claude-haiku-5-5', ok: true, alias: 'haiku' }
      ],
      'probe',
      null,
      new Date('2026-11-01T00:00:00Z')
    );
    saveCatalogue(before, dir);
    const file = cataloguePath('claude-code', dir)!;
    const bytes = fs.readFileSync(file, 'utf8');
    // a broken wrapper: exit 127, text on stderr (and the old broad regex would have matched "not found")
    const spawn: Spawner = async () => ({ code: 127, stdout: 'node: not found', stderr: 'env: node: not found\nclaude: command not found', timedOut: false });
    const h = harness({ spawn });
    expect(await runCli(['refresh', '--max-calls', '25'], h.deps)).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(loadCatalogue('claude-code', dir)).toEqual(before);
    expect(loadCatalogue('claude-code', dir)!.updated_at).toBe('2026-11-01T00:00:00.000Z');
    expect(h.err.join('\n')).toContain('catalogue unchanged');
    expect(readAttempt('claude-code', dir)).toMatchObject({ result: 'inconclusive' });
  });

  it('a round with only failed probes and no ok probe at all is inconclusive, even with clean JSON rejections', async () => {
    const before = buildCatalogue('claude-code', [{ id: 'claude-sonnet-5-5', ok: true }, { id: 'claude-opus-5-5', ok: true }], 'probe', null, new Date('2026-11-01T00:00:00Z'));
    saveCatalogue(before, dir);
    const h = harness({ spawn: async () => done(REJECTED) });
    expect(await runCli(['refresh', '--max-calls', '25'], h.deps)).toBe(1);
    expect(loadCatalogue('claude-code', dir)).toEqual(before);
  });

  it('stamps the attempt at the end of every run: ok, and error when the catalogue could not be read', async () => {
    expect(await runCli(['refresh', '--quiet', '--max-calls', '4'], harness({ spawn: fakeClaude([...KNOWN_CLAUDE_IDS]).spawn }).deps)).toBe(0);
    expect(readAttempt('claude-code', dir)).toEqual({ ts: NOW.toISOString(), result: 'ok' });
    expect(fs.statSync(path.join(dir, 'claude-code.attempt.json')).mode & 0o777).toBe(0o600);
  });

  it('writes a lock heartbeat after every probe and releases the lock at the end', async () => {
    const lock = refreshLockPath('claude-code', dir);
    const beats: Array<number | undefined> = [];
    const spawn: Spawner = async (_c, args) => {
      beats.push(JSON.parse(fs.readFileSync(lock, 'utf8')).hb);
      return done(okJson(ALIASES[args[args.indexOf('--model') + 1]] ?? args[args.indexOf('--model') + 1]));
    };
    expect(await runCli(['refresh', '--quiet', '--max-calls', '3'], harness({ spawn }).deps)).toBe(0);
    // before the first probe there is no heartbeat; before each later probe the previous one has written it
    expect(beats[0]).toBeUndefined();
    expect(typeof beats[1]).toBe('number');
    expect(typeof beats[2]).toBe('number');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('exits without probing when another refresh holds the lock', async () => {
    fs.mkdirSync(dir, { recursive: true });
    // the parent process is alive and is not us
    fs.writeFileSync(refreshLockPath('claude-code', dir), JSON.stringify({ pid: process.ppid, ts: Date.now() }));
    const { spawn, calls } = fakeClaude([...KNOWN_CLAUDE_IDS]);
    const h = harness({ spawn });
    expect(await runCli(['refresh'], h.deps)).toBe(0);
    expect(calls).toEqual([]);
    expect(h.text()).toContain('another refresh of claude-code is running; nothing probed');
    expect(loadCatalogue('claude-code', dir)).toBeNull();
    // the other process's lock is left alone
    expect(JSON.parse(fs.readFileSync(refreshLockPath('claude-code', dir), 'utf8')).pid).toBe(process.ppid);
  });

  it('runs when the lock was handed to this very process by the trigger, and releases it', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(refreshLockPath('claude-code', dir), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const { spawn, calls } = fakeClaude([...KNOWN_CLAUDE_IDS]);
    expect(await runCli(['refresh', '--quiet', '--max-calls', '4'], harness({ spawn }).deps)).toBe(0);
    expect(calls.length).toBe(4);
    expect(fs.existsSync(refreshLockPath('claude-code', dir))).toBe(false);
  });

  it('two refreshes started together probe once: the second finds the lock', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const slow: Spawner = async (_c, args) => {
      calls.push(args[args.indexOf('--model') + 1]);
      await gate;
      return done(okJson(ALIASES[args[args.indexOf('--model') + 1]] ?? 'claude-sonnet-5-5'));
    };
    const first = runCli(['refresh', '--quiet', '--max-calls', '4'], harness({ spawn: slow }).deps);
    await new Promise((r) => setTimeout(r, 20));
    // a second process would have another pid; model that with a lock owned by the parent
    fs.writeFileSync(refreshLockPath('claude-code', dir), JSON.stringify({ pid: process.ppid, ts: Date.now() }));
    const second = harness({ spawn: fakeClaude([]).spawn });
    expect(await runCli(['refresh', '--max-calls', '4'], second.deps)).toBe(0);
    expect(second.text()).toContain('another refresh');
    release();
    await first;
    expect(calls.length).toBe(4);
  });
});

describe('refresh command (OpenCode and Antigravity)', () => {
  it('OpenCode: builds from the OpenRouter list and keeps the old catalogue when the fetch fails', async () => {
    const list = { data: [{ id: 'anthropic/claude-sonnet-4.5' }, { id: 'anthropic/claude-opus-4.1' }] };
    const okFetch = (async () => ({ ok: true, json: async () => list }) as unknown as Response) as unknown as typeof fetch;
    const h = harness({ fetch: okFetch });
    expect(await runCli(['refresh', '--harness', 'opencode'], h.deps)).toBe(0);
    const cat = loadCatalogue('opencode', dir)!;
    expect(cat.source).toBe('openrouter');
    expect(cat.models.map((m) => m.id)).toContain('anthropic/claude-sonnet-4.5');

    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const bad = harness({ fetch: failing });
    expect(await runCli(['refresh', '--harness', 'opencode'], bad.deps)).toBe(1);
    expect(loadCatalogue('opencode', dir)).toEqual(cat);
    expect(bad.err.join('\n')).toContain('catalogue unchanged');
  });

  it('Antigravity: builds from the configured tier map without any call', async () => {
    const { spawn, calls } = fakeClaude([]);
    const h = harness({ spawn });
    expect(await runCli(['refresh', '--harness', 'antigravity'], h.deps)).toBe(0);
    expect(calls).toEqual([]);
    const cat = loadCatalogue('antigravity', dir)!;
    expect(cat.source).toBe('static');
    expect(Object.fromEntries(cat.models.map((m) => [m.id, m.tier]))).toEqual({
      'openrouter/free': 'free',
      flash_lite: 'cheap',
      flash: 'standard',
      pro: 'deep'
    });
    expect(cat.models.every((m) => m.status === 'ok')).toBe(true);
  });

  it('Antigravity: follows the user config tier map', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ harnesses: { antigravity: { models: { standard: 'flash-2' } } } }));
    clearConfigCacheForTesting();
    await runCli(['refresh', '--harness', 'antigravity', '--quiet'], harness().deps);
    expect(loadCatalogue('antigravity', dir)!.models.map((m) => m.id)).toContain('flash-2');
  });
});

describe('status and list', () => {
  it('status says there is no catalogue, then reports age, source and ids', async () => {
    const none = harness();
    expect(await runCli(['status'], none.deps)).toBe(0);
    expect(none.text()).toContain('catalogue: none');
    expect(none.text()).toContain('background refresh: enabled');

    const cat = buildCatalogue(
      'claude-code',
      [{ id: 'claude-sonnet-5-5', ok: true }, { id: 'claude-opus-4-5', ok: true }, { id: 'claude-zephyr-1', ok: true }],
      'probe',
      null,
      new Date('2026-11-01T10:00:00Z')
    );
    saveCatalogue(buildCatalogue('claude-code', [{ id: 'claude-opus-4-5', ok: false }], 'probe', cat, new Date('2026-11-01T10:00:00Z')), dir);
    const h = harness();
    await runCli(['status'], h.deps);
    expect(h.text()).toContain('12.0 days ago, stale');
    expect(h.text()).toContain('source: probe');
    expect(h.text()).toContain('ok: claude-sonnet-5-5');
    expect(h.text()).toContain('missing: claude-opus-4-5');
    expect(h.text()).toContain('needs review: claude-zephyr-1');
  });

  it('status reflects a disabled background refresh', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ models: { refresh: { enabled: false, maxAgeDays: 14 } } }));
    const h = harness();
    await runCli(['status'], h.deps);
    expect(h.text()).toContain('background refresh: disabled (max age 14 days');
  });

  it('list shows the ladder per tier and the entries; --json gives the catalogue and ladders', async () => {
    saveCatalogue(
      buildCatalogue('claude-code', [{ id: 'claude-haiku-5-5', ok: true, alias: 'haiku' }, { id: 'claude-sonnet-5-5', ok: true }, { id: 'claude-sonnet-5', ok: true }], 'probe', null, NOW),
      dir
    );
    const h = harness();
    await runCli(['list'], h.deps);
    expect(h.text()).toContain('cheap: claude-haiku-5-5');
    expect(h.text()).toContain('standard: claude-sonnet-5-5, claude-sonnet-5');
    expect(h.text()).toContain('deep: none');
    expect(h.text()).toContain('alias=haiku');

    const j = harness();
    await runCli(['list', '--json'], j.deps);
    const parsed = JSON.parse(j.text());
    expect(parsed.harness).toBe('claude-code');
    expect(parsed.ladders.standard).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5']);
  });

  it('list says so when there is no catalogue', async () => {
    const h = harness();
    await runCli(['list'], h.deps);
    expect(h.text()).toContain('no catalogue for claude-code');
  });
});

describe('usage errors', () => {
  it('exit 2 with a message for a bad command line; help exits 0', async () => {
    const bad = harness();
    expect(await runCli(['refresh', '--max-calls', '0'], bad.deps)).toBe(2);
    expect(bad.err.join('\n')).toContain('--max-calls');
    const help = harness();
    expect(await runCli([], help.deps)).toBe(0);
    expect(help.text()).toContain('refresh [--harness');
  });
});

describe('summarise', () => {
  it('reports added, removed, newly missing, recovered and needs-review ids', () => {
    const before: Catalogue = buildCatalogue('claude-code', [{ id: 'a-1', ok: true }, { id: 'claude-sonnet-5', ok: true }, { id: 'claude-haiku-4-5', ok: true }], 'probe', null, NOW);
    const mid = buildCatalogue('claude-code', [{ id: 'claude-haiku-4-5', ok: false }], 'probe', before, NOW);
    const after = buildCatalogue(
      'claude-code',
      [{ id: 'claude-haiku-4-5', ok: true }, { id: 'claude-sonnet-5', ok: false }, { id: 'claude-opus-5', ok: true }],
      'probe',
      mid,
      NOW
    );
    expect(summarise(mid, after)).toEqual({
      added: ['claude-opus-5'],
      removed: [],
      nowMissing: ['claude-sonnet-5'],
      recovered: ['claude-haiku-4-5'],
      needsReview: ['a-1']
    });
  });
});

describe('the script as a process', () => {
  const run = (...args: string[]) =>
    Bun.spawnSync(['bun', SCRIPT, ...args], { env: { ...process.env, HOME: root, JEV_CONFIG_FILE: configFile, JEV_MODEL_REFRESH: 'off' } });

  it('status works with HOME pointed at a temp directory and does not create anything', () => {
    const p = run('status');
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain('catalogue: none');
    expect(fs.existsSync(path.join(root, '.config'))).toBe(false);
  });

  it('exits 2 on a bad option and prints the usage', () => {
    const p = run('refresh', '--max-calls', 'x');
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain('--max-calls');
  });

  it('antigravity refresh writes ~/.config/jev/models/antigravity.json under the temp HOME', () => {
    const p = run('refresh', '--harness', 'antigravity', '--quiet');
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toBe('');
    expect(fs.existsSync(path.join(root, '.config', 'jev', 'models', 'antigravity.json'))).toBe(true);
  });
});
