import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPreflight, autoHealAgyMcp } from '../antigravity/preflight.ts';
import { jevTelemetryFile, logJevTelemetry } from '../src/core/telemetry.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';

describe('antigravity preflight hook', () => {
  let tmpHome = '';
  let jevConfigDir = '';
  let agyDir = '';
  let origHome = '';
  let origConfig = '';
  let origTelemetry = '';
  let origQuota = '';

  beforeEach(() => {
    clearConfigCacheForTesting();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-preflight-test-'));
    jevConfigDir = path.join(tmpHome, '.config', 'jev');
    agyDir = path.join(tmpHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(jevConfigDir, { recursive: true });
    fs.mkdirSync(agyDir, { recursive: true });

    origHome = process.env.HOME || '';
    origConfig = process.env.JEV_CONFIG_FILE || '';
    origTelemetry = process.env.JEV_TELEMETRY_FILE || '';
    origQuota = process.env.JEV_QUOTA_STATE_FILE || '';

    process.env.HOME = tmpHome;
    process.env.JEV_CONFIG_FILE = path.join(jevConfigDir, 'config.json');
    process.env.JEV_TELEMETRY_FILE = path.join(agyDir, 'jev_telemetry.jsonl');
    process.env.JEV_QUOTA_STATE_FILE = path.join(agyDir, 'quota-state.json');
  });

  afterEach(() => {
    clearConfigCacheForTesting();
    process.env.HOME = origHome;
    if (origConfig) process.env.JEV_CONFIG_FILE = origConfig;
    else delete process.env.JEV_CONFIG_FILE;
    if (origTelemetry) process.env.JEV_TELEMETRY_FILE = origTelemetry;
    else delete process.env.JEV_TELEMETRY_FILE;
    if (origQuota) process.env.JEV_QUOTA_STATE_FILE = origQuota;
    else delete process.env.JEV_QUOTA_STATE_FILE;

    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('unconfigured or stray mode.json resolves to off', async () => {
    // Write a stray mode.json with "on", but config.json does not exist
    fs.writeFileSync(path.join(jevConfigDir, 'mode.json'), JSON.stringify({ mode: 'on' }));

    let stdout = '';
    const origLog = console.log;
    console.log = (msg: string) => { stdout += msg; };
    try {
      await runPreflight(JSON.stringify({ lastUserInput: 'hello' }));
    } finally {
      console.log = origLog;
    }

    // Since config.json was missing, readJevMode('antigravity') resolves 'off'.
    // And with no quota-state.json (quota normal/unknown), it emits {}
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({});
  });

  async function capture(input: object, deps: Parameters<typeof runPreflight>[1] = {}): Promise<string> {
    let stdout = '';
    const origLog = console.log;
    console.log = (msg: string) => { stdout += msg; };
    try {
      await runPreflight(JSON.stringify(input), deps);
    } finally {
      console.log = origLog;
    }
    return stdout;
  }

  function listTree(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        out.push(path.relative(dir, p) + (e.isDirectory() ? '/' : ''));
        if (e.isDirectory()) walk(p);
      }
    };
    walk(dir);
    return out.sort();
  }

  it('mode off runs only the MCP auto-heal, prints {} and writes nothing, even when the pool is low', async () => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ defaults: { mode: 'off' } }));
    fs.writeFileSync(
      path.join(agyDir, 'quota-state.json'),
      JSON.stringify({
        schema: 2,
        updated_at: Math.floor(Date.now() / 1000),
        active_model: 'gemini-3.8-flash-low',
        buckets: {
          'gemini-5h': { remaining_fraction: 0.05 },
          'gemini-weekly': { remaining_fraction: 0.05 }
        }
      })
    );
    const before = listTree(tmpHome);

    const healCalls: string[] = [];
    let dispatchCalls = 0;
    const stdout = await capture(
      { conversationId: 'c-off', modelName: 'gemini-3.8-flash-low', lastUserInput: 'hello there friend', invocationNum: 1 },
      {
        autoHeal: (m) => { healCalls.push(m); },
        callJev: async () => { dispatchCalls++; return null; }
      }
    );

    expect(JSON.parse(stdout)).toEqual({});
    expect(healCalls).toEqual(['off']);
    expect(dispatchCalls).toBe(0);
    // No session .model.json, no telemetry, nothing else under the temporary HOME.
    expect(listTree(tmpHome)).toEqual(before);
    expect(fs.existsSync(process.env.JEV_TELEMETRY_FILE!)).toBe(false);
  });

  it('autoHealAgyMcp disables the jev server in mode off and enables it otherwise (stubbed agy)', () => {
    const cfgDir = path.join(tmpHome, '.gemini', 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { jev: { disabled: false } } }));
    const calls: string[][] = [];
    const deps = { home: tmpHome, hasAgy: () => true, runAgy: (a: string[]) => { calls.push(a); } };

    autoHealAgyMcp('off', deps);
    expect(calls).toEqual([['mcp', 'disable', 'jev']]);

    calls.length = 0;
    autoHealAgyMcp('on', deps);
    expect(calls).toEqual([]); // already enabled

    fs.writeFileSync(path.join(cfgDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { jev: { disabled: true } } }));
    autoHealAgyMcp('on', deps);
    expect(calls).toEqual([['mcp', 'enable', 'jev']]);

    // No agy on PATH: nothing runs.
    calls.length = 0;
    autoHealAgyMcp('on', { ...deps, hasAgy: () => false });
    expect(calls).toEqual([]);
  });

  it('mode on quota messages carry the pool strategy and the actual remaining %, never a hard-coded threshold', async () => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ defaults: { mode: 'on' } }));
    const write = (remaining: number) =>
      fs.writeFileSync(
        path.join(agyDir, 'quota-state.json'),
        JSON.stringify({
          schema: 2,
          updated_at: Math.floor(Date.now() / 1000),
          active_model: 'gemini-3.8-flash-low',
          buckets: { 'gemini-5h': { remaining_fraction: remaining }, 'gemini-weekly': { remaining_fraction: remaining } }
        })
      );

    write(0.05);
    const low = JSON.parse(await capture({ conversationId: 'c-low', lastUserInput: 'hi' }, { autoHeal: () => {} }));
    const lowMsg: string = low.injectSteps[0].ephemeralMessage;
    expect(lowMsg).toContain('QUOTA EMERGENCY');
    expect(lowMsg).toContain('free_only');
    expect(lowMsg).toContain('5.0% remaining');
    expect(lowMsg).not.toMatch(/<\s*\d+\s*%/);

    write(0.15);
    const mid = JSON.parse(await capture({ conversationId: 'c-mid', lastUserInput: 'hi' }, { autoHeal: () => {} }));
    const midMsg: string = mid.injectSteps[0].ephemeralMessage;
    expect(midMsg).toContain('QUOTA CONSERVE');
    expect(midMsg).toContain('conserve');
    expect(midMsg).toContain('15.0% remaining');
    expect(midMsg).not.toMatch(/<\s*\d+\s*%/);
  });

  it('mode on emits Orchestrator directive and Argon-exhausted warning when appropriate', async () => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ defaults: { mode: 'on' } }));
    fs.writeFileSync(
      path.join(agyDir, 'quota-state.json'),
      JSON.stringify({
        schema: 2,
        updated_at: Math.floor(Date.now() / 1000),
        active_model: 'Orchestrator (Argon)',
        plan_tier: 'pro',
        buckets: {
          'gemini-5h': { remaining_fraction: 0.8 },
          'gemini-weekly': { remaining_fraction: 0.8 },
          'gemini-argon-wtu-weekly': { remaining_fraction: 0.0, reset_at: Math.floor(Date.now() / 1000) + 3600 }
        }
      })
    );

    let stdout = '';
    const origLog = console.log;
    console.log = (msg: string) => { stdout += msg; };
    try {
      await runPreflight(JSON.stringify({
        conversationId: '12345678-1234-1234-1234-123456789abc',
        modelName: 'Orchestrator (Argon)',
        lastUserInput: 'fix bug'
      }));
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(stdout);
    expect(parsed.injectSteps).toHaveLength(1);
    const msg = parsed.injectSteps[0].ephemeralMessage;
    expect(msg).toContain('ORCHESTRATOR ENFORCEMENT');
    expect(msg).toContain('ARGON EXHAUSTED WARNING');
    expect(msg).toContain('Gemini 4 Hydrogen');
    expect(msg).toContain('12345678-1234-1234-1234-123456789abc');
  });

  it('privacy: logs taskHash and taskLen, never raw task text or tool: jev_dispatch on PreInvocation lines', async () => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ defaults: { mode: 'on' } }));
    fs.writeFileSync(
      path.join(agyDir, 'quota-state.json'),
      JSON.stringify({
        schema: 2,
        updated_at: Math.floor(Date.now() / 1000),
        active_model: 'gemini-3.8-flash-low',
        buckets: { 'gemini-5h': { remaining_fraction: 0.8 } }
      })
    );

    const secretPrompt = 'SUPER_SECRET_USER_PROMPT_THAT_MUST_NEVER_BE_LOGGED';
    const stub = async () => ({
      answers: {
        recommendedSubagent: { choice: 'code-engineer' },
        recommendedTier: { choice: 'flash' }
      }
    });
    await capture(
      { conversationId: 'c-priv', lastUserInput: secretPrompt, invocationNum: 1 },
      { autoHeal: () => {}, callJev: stub as any }
    );

    // The telemetry path resolves at call time (JEV_TELEMETRY_FILE), so this file must exist and be the one written.
    const telemPath = process.env.JEV_TELEMETRY_FILE!;
    expect(fs.existsSync(telemPath)).toBe(true);
    const content = fs.readFileSync(telemPath, 'utf8');
    expect(content).not.toContain(secretPrompt);
    const lines = content.trim().split('\n').map((l) => JSON.parse(l));
    const pre = lines.filter((l) => l.toolOrHook === 'PreInvocation');
    expect(pre.length).toBe(1);
    expect(pre[0].taskLen).toBe(secretPrompt.length);
    expect(pre[0].taskHash).toMatch(/^[0-9a-f]{12}$/);
    for (const l of pre) expect(l.tool).not.toBe('jev_dispatch');
    expect(content).not.toContain('"tool":"jev_dispatch"');
    // Nothing leaked into the real home's telemetry file either: the real path is not the temporary one.
    expect(telemPath.startsWith(tmpHome)).toBe(true);
  });

  it('telemetry resolves HOME at call time when JEV_TELEMETRY_FILE is not set', async () => {
    delete process.env.JEV_TELEMETRY_FILE;
    expect(jevTelemetryFile()).toBe(path.join(tmpHome, '.gemini', 'antigravity-cli', 'jev_telemetry.jsonl'));
    await logJevTelemetry({ harness: 'antigravity', toolOrHook: 'probe' });
    expect(fs.existsSync(path.join(tmpHome, '.gemini', 'antigravity-cli', 'jev_telemetry.jsonl'))).toBe(true);
  });
});
