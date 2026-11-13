import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  KNOWN_CLAUDE_IDS,
  MAX_CONSECUTIVE_ERRORS,
  PROBE_TIMEOUT_MS,
  discoverClaudeCode,
  generateCandidates,
  neighbourIds,
  parseProbeOutput,
  probeArgs,
  probeModel,
  reconcileAliases
} from '../src/refresh/claude-code.js';
import { buildCatalogue, type Catalogue, type ProbeResult } from '../src/core/catalogue.js';
import type { SpawnResult, Spawner } from '../src/refresh/spawn.js';

// The probe directory defaults to ~/.config/jev/probe-cwd: point HOME at a temp directory so no test touches the real one.
let fakeHome = '';
let stableRoot = '';
let stableCwd = '';
let savedHome: string | undefined;
beforeAll(() => {
  savedHome = process.env.HOME;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-probe-home-'));
  process.env.HOME = fakeHome;
  stableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-probe-stable-'));
  stableCwd = path.join(stableRoot, 'probe-cwd');
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(stableRoot, { recursive: true, force: true });
});

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'claude-probe');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const done = (stdout: string, extra: Partial<SpawnResult> = {}): SpawnResult => ({ code: 0, stdout, stderr: '', timedOut: false, ...extra });

/** A `claude -p --output-format json` result served by `models` (costUSD per model). */
function okJson(models: Record<string, number>): string {
  const usage = Object.fromEntries(
    Object.entries(models).map(([id, cost]) => [id, { inputTokens: 3, outputTokens: 5, costUSD: cost, contextWindow: 200000 }])
  );
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'OK',
    total_cost_usd: Object.values(models).reduce((a, b) => a + b, 0),
    modelUsage: usage
  });
}

/** The tail of the probe command line: the value after `--model`. */
const modelOf = (args: string[]): string => args[args.indexOf('--model') + 1];

/** Fake `claude`: every id in `account` works (an alias resolves through `aliases`), anything else is rejected. */
function fakeClaude(
  account: readonly string[],
  aliases: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' }
) {
  const calls: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const spawn: Spawner = async (_cmd, args) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 1));
    running--;
    const want = modelOf(args);
    calls.push(want);
    const served = aliases[want] ?? want;
    if (aliases[want] || account.includes(want)) return done(okJson({ [served]: 0.01 }));
    return done(fixture('error-model-not-found.json'));
  };
  return { spawn, calls, maxRunning: () => maxRunning };
}

const ACCOUNT = [...KNOWN_CLAUDE_IDS];

describe('candidate list', () => {
  it('generates the next minor and the next major of the newest known version, per family', () => {
    expect(neighbourIds(KNOWN_CLAUDE_IDS)).toEqual([
      'claude-haiku-5-6',
      'claude-haiku-6',
      'claude-sonnet-5-6',
      'claude-sonnet-6',
      'claude-opus-5-6',
      'claude-opus-6',
      'claude-fable-5-3',
      'claude-fable-6'
    ]);
  });

  it('moves the neighbours up when the previous catalogue already holds a newer id', () => {
    const previous = buildCatalogue('claude-code', [{ id: 'claude-sonnet-6', ok: true }], 'probe');
    const list = generateCandidates(previous);
    expect(list).toContain('claude-sonnet-6-1');
    expect(list).toContain('claude-sonnet-7');
    expect(list).not.toContain('claude-sonnet-5-6');
  });

  it('puts previous ids first, then the known ids, then user additions, then neighbours, without duplicates', () => {
    const previous = buildCatalogue('claude-code', [{ id: 'claude-opus-4-5', ok: true }, { id: 'claude-zephyr-1', ok: true }], 'probe');
    const list = generateCandidates(previous, ['claude-sonnet-5-1', 'claude-haiku-5-5', 'sonnet', 'not a model id ']);
    expect(list.slice(0, 2).sort()).toEqual(['claude-opus-4-5', 'claude-zephyr-1']);
    expect(new Set(list).size).toBe(list.length);
    expect(list.indexOf('claude-sonnet-5-1')).toBeGreaterThan(list.indexOf('claude-fable-5-2'));
    expect(list.indexOf('claude-sonnet-5-1')).toBeLessThan(list.indexOf('claude-haiku-6'));
    expect(list).not.toContain('sonnet');
  });
});

describe('probe result parsing', () => {
  it('is ok when modelUsage holds the requested id (a real success result)', () => {
    expect(parseProbeOutput(done(fixture('success-sonnet-5-5.json')), 'claude-sonnet-5-5')).toEqual({
      kind: 'ok',
      resolved: 'claude-sonnet-5-5',
      costUsd: 0.0412
    });
  });

  it('is a failure when another model served the call', () => {
    const r = parseProbeOutput(done(fixture('success-sonnet-5-5.json')), 'claude-fable-5-2');
    expect(r).toMatchObject({ kind: 'fail' });
    expect((r as any).reason).toContain('claude-sonnet-5-5');
  });

  it('is a failure when the harness rejects the model', () => {
    expect(parseProbeOutput(done(fixture('error-model-not-found.json')), 'claude-sonnet-4')).toMatchObject({ kind: 'fail' });
  });

  it('is inconclusive on a rate limit, a timeout, a start failure and unreadable output', () => {
    expect(parseProbeOutput(done(fixture('error-rate-limit.json')), 'claude-sonnet-5-5').kind).toBe('error');
    expect(parseProbeOutput({ stdout: '', timedOut: true, code: null }, 'claude-sonnet-5-5')).toEqual({ kind: 'error', reason: 'timed out' });
    expect(parseProbeOutput({ stdout: '', code: null, error: 'spawn claude ENOENT' }, 'claude-sonnet-5-5').kind).toBe('error');
    expect(parseProbeOutput(done('Welcome to Claude\n', { code: 1 }), 'claude-sonnet-5-5').kind).toBe('error');
  });

  it('free text without a JSON result is inconclusive, never a failure', () => {
    const rejectedText = 'There is an issue with the selected model (x). It may not exist or you may not have access to it.';
    expect(parseProbeOutput(done('', { code: 1, stderr: rejectedText }), 'x').kind).toBe('error');
    expect(parseProbeOutput(done(rejectedText, { code: 1 }), 'x').kind).toBe('error');
  });

  it('a broken wrapper ("node: not found", "command not found") is inconclusive', () => {
    expect(parseProbeOutput(done('', { code: 127, stderr: 'env: node: not found' }), 'sonnet').kind).toBe('error');
    expect(parseProbeOutput(done('', { code: 127, stderr: 'sh: 1: claude: command not found' }), 'sonnet').kind).toBe('error');
    expect(parseProbeOutput(done('node: not found', { code: 127 }), 'sonnet').kind).toBe('error');
  });

  it('a JSON error result counts as a failure only when it carries the narrow model-rejection message', () => {
    const err = (result: string) => JSON.stringify({ type: 'result', is_error: true, result, total_cost_usd: 0, modelUsage: {} });
    expect(parseProbeOutput(done(err('node: not found')), 'x').kind).toBe('error');
    expect(parseProbeOutput(done(err('Request failed: resource not found')), 'x').kind).toBe('error');
    expect(parseProbeOutput(done(err('Feature not available on your plan')), 'x').kind).toBe('error');
    expect(parseProbeOutput(done(err("There's an issue with the selected model (x). It may not exist or you may not have access to it.")), 'x').kind).toBe('fail');
  });

  it('tolerates a warning line before the JSON and an array of messages', () => {
    const json = fixture('success-sonnet-5-5.json').trim();
    expect(parseProbeOutput(done(`warning: something\n${json}\n`), 'claude-sonnet-5-5').kind).toBe('ok');
    const arr = JSON.stringify([{ type: 'system' }, JSON.parse(json)]);
    expect(parseProbeOutput(done(arr), 'claude-sonnet-5-5').kind).toBe('ok');
  });

  it('matches a usage key with a context suffix or a date stamp', () => {
    expect(parseProbeOutput(done(okJson({ 'claude-sonnet-5-5[1m]': 0.1 })), 'claude-sonnet-5-5').kind).toBe('ok');
    expect(parseProbeOutput(done(okJson({ 'claude-haiku-4-5-20251001': 0.1 })), 'claude-haiku-4-5').kind).toBe('ok');
    expect(parseProbeOutput(done(okJson({ 'claude-sonnet-5-5-extra': 0.1 })), 'claude-sonnet-5-5').kind).toBe('fail');
  });

  it('resolves an alias to the usage key of its own family, even when a helper model ran too', () => {
    const r = parseProbeOutput(done(fixture('success-two-models.json')), 'haiku');
    expect(r).toMatchObject({ kind: 'ok', resolved: 'claude-haiku-5-5' });
    expect(parseProbeOutput(done(fixture('success-two-models.json')), 'opus')).toMatchObject({ kind: 'ok', resolved: 'claude-opus-5-5' });
  });

  it('takes the costliest key when no key belongs to the alias family', () => {
    expect(parseProbeOutput(done(fixture('success-two-models.json')), 'fable')).toMatchObject({ resolved: 'claude-opus-5-5' });
  });
});

describe('probeModel', () => {
  it('runs claude with isolated settings, hooks off and the Jev plugin off, in a fresh empty directory', async () => {
    let seen: { cmd: string; args: string[]; cwd: string; timeoutMs: number; settings: any; cwdEntries: string[] } | null = null;
    let root = '';
    const spawn: Spawner = async (cmd, args, opts) => {
      const settingsFile = args[args.indexOf('--settings') + 1];
      root = path.dirname(settingsFile);
      seen = {
        cmd,
        args,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        settings: JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
        cwdEntries: fs.readdirSync(opts.cwd)
      };
      return done(fixture('success-sonnet-5-5.json'));
    };
    const r = await probeModel('claude-sonnet-5-5', { spawn, cwd: stableCwd });

    expect(r.kind).toBe('ok');
    expect(seen!.cmd).toBe('claude');
    expect(seen!.args).toEqual(probeArgs('claude-sonnet-5-5', seen!.args[seen!.args.indexOf('--settings') + 1]));
    expect(seen!.args.slice(0, 4)).toEqual(['-p', 'Reply OK', '--model', 'claude-sonnet-5-5']);
    expect(seen!.args).toContain('--no-session-persistence');
    expect(seen!.args.slice(seen!.args.indexOf('--setting-sources'), seen!.args.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', 'project']);
    expect(seen!.args.slice(-2)).toEqual(['--output-format', 'json']);
    expect(seen!.settings).toEqual({ disableAllHooks: true, enabledPlugins: { 'jev@agentic-hub': false } });
    expect(seen!.cwdEntries).toEqual([]);
    expect(seen!.cwd).toBe(stableCwd);
    expect(seen!.timeoutMs).toBe(PROBE_TIMEOUT_MS);
    expect(PROBE_TIMEOUT_MS).toBe(60_000);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('uses one stable empty probe directory, created owner-only and reused, so there is a single project entry', async () => {
    const seenCwds: string[] = [];
    const spawn: Spawner = async (_c, _a, opts) => {
      seenCwds.push(opts.cwd);
      return done(fixture('success-sonnet-5-5.json'));
    };
    const cwd = path.join(stableRoot, 'nested', 'probe-cwd');
    await probeModel('claude-sonnet-5-5', { spawn, cwd });
    await probeModel('claude-sonnet-5-5', { spawn, cwd });
    await probeModel('claude-sonnet-5-5', { spawn, cwd });
    expect(seenCwds).toEqual([cwd, cwd, cwd]);
    expect(fs.statSync(cwd).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it('defaults the probe directory to ~/.config/jev/probe-cwd', async () => {
    const seenCwds: string[] = [];
    await probeModel('haiku', { spawn: async (_c, _a, o) => (seenCwds.push(o.cwd), done(fixture('success-sonnet-5-5.json'))) });
    expect(seenCwds).toEqual([path.join(fakeHome, '.config', 'jev', 'probe-cwd')]);
  });

  it('turns auto-memory off for the probe', async () => {
    let env: NodeJS.ProcessEnv | undefined;
    await probeModel('haiku', { spawn: async (_c, _a, o) => ((env = o.env), done(fixture('success-sonnet-5-5.json'))), cwd: stableCwd });
    expect(env!.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  it('passes an allowlisted environment: keeps PATH, HOME and the Claude auth variables, drops JEV_ and OPENROUTER_ keys', async () => {
    let env: NodeJS.ProcessEnv | undefined;
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      USER: 'x',
      LANG: 'C',
      TERM: 'xterm',
      TMPDIR: '/tmp',
      SHELL: '/bin/sh',
      XDG_CONFIG_HOME: '/home/x/.config',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      CLAUDE_CONFIG_DIR: '/home/x/.claude-alt',
      HTTPS_PROXY: 'p',
      HTTP_PROXY: 'p',
      NO_PROXY: 'n',
      SSL_CERT_FILE: '/c.pem',
      NODE_EXTRA_CA_CERTS: '/e.pem',
      JEV_OPENROUTER_API_KEY: 'secret',
      JEV_MODEL_REFRESH: 'off',
      OPENROUTER_API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      GITHUB_TOKEN: 'secret'
    };
    await probeModel('haiku', { spawn: async (_c, _a, o) => ((env = o.env), done(fixture('success-sonnet-5-5.json'))), cwd: stableCwd, env: source });
    expect(Object.keys(env!).sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CONFIG_DIR',
        'HOME',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'LANG',
        'NODE_EXTRA_CA_CERTS',
        'NO_PROXY',
        'PATH',
        'SHELL',
        'SSL_CERT_FILE',
        'TERM',
        'TMPDIR',
        'USER',
        'XDG_CONFIG_HOME'
      ]
    );
    expect(env!.ANTHROPIC_API_KEY).toBe('k');
  });

  it('reports a spawner that throws as inconclusive and still removes its temp directory', async () => {
    let root = '';
    const r = await probeModel('haiku', {
      spawn: async (_c, args) => {
        root = path.dirname(args[args.indexOf('--settings') + 1]);
        throw new Error('boom');
      }
    });
    expect(r).toEqual({ kind: 'error', reason: 'boom' });
    expect(fs.existsSync(root)).toBe(false);
  });

  it('passes a timeout through as inconclusive', async () => {
    const r = await probeModel('haiku', { spawn: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }) });
    expect(r).toEqual({ kind: 'error', reason: 'timed out' });
  });
});

describe('discoverClaudeCode', () => {
  it('probes the four aliases first and records which id each resolves to', async () => {
    const fake = fakeClaude(ACCOUNT);
    const out = await discoverClaudeCode({ previous: null, spawn: fake.spawn, maxCalls: 4 });

    expect(fake.calls).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    expect(out.aliases).toEqual({ haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' });
    expect(out.results).toEqual([
      { id: 'claude-haiku-5-5', ok: true, alias: 'haiku' },
      { id: 'claude-sonnet-5-5', ok: true, alias: 'sonnet' },
      { id: 'claude-opus-5-5', ok: true, alias: 'opus' },
      { id: 'claude-fable-5-2', ok: true, alias: 'fable' }
    ]);
    expect(out.calls).toBe(4);
    expect(out.costUsd).toBeCloseTo(0.04, 5);
  });

  it('keeps alias opus on the catalogue entry when the fable alias is served by opus', async () => {
    const fake = fakeClaude(ACCOUNT, { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-opus-5-5' });
    const out = await discoverClaudeCode({ previous: null, spawn: fake.spawn, maxCalls: 4 });

    expect(out.aliases.fable).toBe('claude-opus-5-5');
    expect(out.notes.some((n) => n.includes('alias fable resolved to claude-opus-5-5'))).toBe(true);
    // the fable probe only ever proves the id works: it never claims the alias `fable` for it
    expect(out.results.some((r) => r.alias === 'fable')).toBe(false);

    const cat = buildCatalogue('claude-code', out.results, 'probe');

    expect(cat.models.find((m) => m.id === 'claude-opus-5-5')).toMatchObject({ alias: 'opus', status: 'ok' });
  });

  it('never exceeds the call cap, logs what it dropped, and returns it', async () => {
    const fake = fakeClaude(ACCOUNT);
    const lines: string[] = [];
    const out = await discoverClaudeCode({ previous: null, spawn: fake.spawn, maxCalls: 7, log: (l) => lines.push(l) });

    expect(fake.calls.length).toBe(7);
    expect(out.calls).toBe(7);
    expect(fake.calls.slice(0, 4)).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    expect(fake.calls.slice(4)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-sonnet-4-5']);
    expect(out.dropped.length).toBeGreaterThan(0);
    expect(out.dropped).toContain('claude-opus-5');
    expect(out.dropped).toContain('claude-fable-6');
    expect(out.dropped.some((id) => fake.calls.includes(id))).toBe(false);
    const capLine = lines.find((l) => l.includes('call cap (7)'));
    expect(capLine).toBeDefined();
    for (const id of out.dropped) expect(capLine).toContain(id);
  });

  it('runs the probes one after another, never in parallel', async () => {
    const fake = fakeClaude(ACCOUNT);
    await discoverClaudeCode({ previous: null, spawn: fake.spawn, maxCalls: 12 });
    expect(fake.maxRunning()).toBe(1);
  });

  it('skips an id an alias probe already verified', async () => {
    const fake = fakeClaude(ACCOUNT);
    const out = await discoverClaudeCode({ previous: null, spawn: fake.spawn, maxCalls: 100 });
    for (const id of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2']) {
      expect(fake.calls.filter((c) => c === id)).toEqual([]);
    }
    expect(new Set(fake.calls).size).toBe(fake.calls.length);
    // 4 aliases + 5 known ids + 8 generated neighbours
    expect(out.calls).toBe(17);
    expect(out.dropped).toEqual([]);
  });

  it('records an available older id and notes, without recording, a neighbour that does not exist', async () => {
    const fake = fakeClaude(ACCOUNT);
    const out = await discoverClaudeCode({ previous: null, spawn: fake.spawn, maxCalls: 100 });
    expect(out.results.find((r) => r.id === 'claude-sonnet-4-5')).toEqual({ id: 'claude-sonnet-4-5', ok: true });
    expect(out.results.some((r) => r.id === 'claude-sonnet-6')).toBe(false);
    expect(out.notes).toContain('claude-sonnet-6 is not available');
  });

  it('records a failed probe of an id the previous catalogue had, so the strikes rule can act', async () => {
    const previous = buildCatalogue('claude-code', [{ id: 'claude-opus-4-5', ok: true }], 'probe');
    const fake = fakeClaude(ACCOUNT.filter((id) => id !== 'claude-opus-4-5'));
    const out = await discoverClaudeCode({ previous, spawn: fake.spawn, maxCalls: 100 });
    expect(out.results).toContainEqual({ id: 'claude-opus-4-5', ok: false });
  });

  it('probes a user-added candidate', async () => {
    const fake = fakeClaude([...ACCOUNT, 'claude-sonnet-5-1']);
    const out = await discoverClaudeCode({ previous: null, spawn: fake.spawn, maxCalls: 100, extra: ['claude-sonnet-5-1'] });
    expect(fake.calls).toContain('claude-sonnet-5-1');
    expect(out.results).toContainEqual({ id: 'claude-sonnet-5-1', ok: true });
  });

  it('does not attach an alias to an id from another family', async () => {
    const fake = fakeClaude(ACCOUNT, { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-sonnet-5-5' });
    const out = await discoverClaudeCode({ previous: null, spawn: fake.spawn, maxCalls: 4 });
    expect(out.results.filter((r) => r.id === 'claude-sonnet-5-5')).toEqual([
      { id: 'claude-sonnet-5-5', ok: true, alias: 'sonnet' },
      { id: 'claude-sonnet-5-5', ok: true }
    ]);
    expect(out.notes.some((n) => n.includes('fable'))).toBe(true);
  });

  it('leaves an id alone when the probe gave no answer, and stops after three in a row', async () => {
    const calls: string[] = [];
    const spawn: Spawner = async (_c, args) => {
      calls.push(modelOf(args));
      return done(fixture('error-rate-limit.json'));
    };
    const previous = buildCatalogue('claude-code', [{ id: 'claude-sonnet-5-5', ok: true }], 'probe');
    const out = await discoverClaudeCode({ previous, spawn, maxCalls: 20 });

    expect(MAX_CONSECUTIVE_ERRORS).toBe(3);
    expect(calls.length).toBe(3);
    expect(out.results).toEqual([]);
    expect(out.inconclusive).toEqual(['haiku', 'sonnet', 'opus']);
    expect(out.aborted).toContain('3 probes in a row');
    expect(out.dropped).toContain('claude-sonnet-5-5');
  });

  it('a timeout is inconclusive, not a strike', async () => {
    const previous = buildCatalogue('claude-code', [{ id: 'claude-sonnet-5-5', ok: true }], 'probe');
    let n = 0;
    const spawn: Spawner = async (_c, args) => {
      n++;
      if (modelOf(args) === 'sonnet') return { code: null, stdout: '', stderr: '', timedOut: true };
      return done(okJson({ [{ haiku: 'claude-haiku-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' }[modelOf(args)] ?? modelOf(args)]: 0.01 }));
    };
    const out = await discoverClaudeCode({ previous, spawn, maxCalls: 5 });
    expect(out.inconclusive).toContain('sonnet');
    expect(out.results.some((r) => r.id === 'claude-sonnet-5-5' && r.ok === false)).toBe(false);
    expect(out.aborted).toBeUndefined();
    expect(n).toBe(5);
  });
});

describe('discoverClaudeCode heartbeat hook', () => {
  it('calls onProbe after every probe, and a throwing callback does not stop the run', async () => {
    let beats = 0;
    const { spawn, calls } = fakeClaude([...KNOWN_CLAUDE_IDS]);
    await discoverClaudeCode({
      previous: null,
      spawn,
      maxCalls: 6,
      onProbe: () => {
        beats++;
        throw new Error('disk full');
      }
    });
    expect(calls.length).toBe(6);
    expect(beats).toBe(6);
  });
});

describe('reconcileAliases', () => {
  it('removes an alias from an entry the alias no longer resolves to', () => {
    const cat: Catalogue = buildCatalogue('claude-code', [
      { id: 'claude-sonnet-5', ok: true, alias: 'sonnet' },
      { id: 'claude-sonnet-5-5', ok: true, alias: 'sonnet' }
    ] as ProbeResult[], 'probe');
    reconcileAliases(cat, { sonnet: 'claude-sonnet-5-5' });
    expect(cat.models.find((m) => m.id === 'claude-sonnet-5')?.alias).toBeUndefined();
    expect(cat.models.find((m) => m.id === 'claude-sonnet-5-5')?.alias).toBe('sonnet');
  });
});
