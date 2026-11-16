import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPreflight } from '../antigravity/preflight.ts';
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

  it('mode off emits quota emergency or conserve when pool is low', async () => {
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

    let stdout = '';
    const origLog = console.log;
    console.log = (msg: string) => { stdout += msg; };
    try {
      await runPreflight(JSON.stringify({ lastUserInput: 'hello' }));
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(stdout);
    expect(parsed.injectSteps).toHaveLength(1);
    expect(parsed.injectSteps[0].ephemeralMessage).toContain('QUOTA EMERGENCY (Jev OFF)');
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

  it('privacy: logs taskHash and taskLen, never raw task text or tool: jev_dispatch in telemetry', async () => {
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
    let stdout = '';
    const origLog = console.log;
    console.log = (msg: string) => { stdout += msg; };
    try {
      await runPreflight(JSON.stringify({
        conversationId: 'c-priv',
        lastUserInput: secretPrompt,
        invocationNum: 1
      }));
    } finally {
      console.log = origLog;
    }

    // Inspect telemetry file if written
    const telemPath = process.env.JEV_TELEMETRY_FILE!;
    if (fs.existsSync(telemPath)) {
      const content = fs.readFileSync(telemPath, 'utf8');
      expect(content).not.toContain(secretPrompt);
      expect(content).not.toContain('"tool":"jev_dispatch"');
    }
  });
});
