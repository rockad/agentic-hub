import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readZdrPolicy,
  callJevDecision,
  callJevRouter,
  callRouterCompletion,
  callOpenRouterFree,
  EGRESS_ZDR_UNAVAILABLE_CODE,
  clearDecisionCache,
  egressLogFile,
  assertEgressAllowed
} from '../src/shared.ts';

const ENV_KEYS = [
  'HOME',
  'JEV_ZDR',
  'JEV_CONFIG_FILE',
  'OPENROUTER_API_KEY',
  'JEV_CACHE_FILE',
  'CLAUDE_PROJECT_DIR',
  'JEV_HARNESS',
  'ANTIGRAVITY_CLI',
  'GEMINI_CLI',
  'CLAUDE_CODE',
  'CLAUDECODE',
  'OPENCODE_SESSION',
  'OPENCODE_HOME',
  'CORTEX_SESSION'
] as const;

let tmp = '';
let savedEnv: Record<string, string | undefined> = {};
let originalFetch: typeof fetch;
let fetchCalls: Array<{ url: string; body: any }> = [];

function writeEgress(content: Record<string, unknown>): void {
  const dir = path.join(process.env.HOME!, '.config', 'jev');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'egress.json'), JSON.stringify(content));
}

function writeConfig(content: Record<string, unknown>): void {
  const dir = path.join(process.env.HOME!, '.config', 'jev');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(content));
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-zdr-')));
  process.env.HOME = path.join(tmp, 'home');
  delete process.env.JEV_ZDR;
  delete process.env.JEV_CONFIG_FILE;
  delete process.env.CLAUDE_PROJECT_DIR;
  for (const h of [
    'JEV_HARNESS',
    'ANTIGRAVITY_CLI',
    'GEMINI_CLI',
    'CLAUDE_CODE',
    'CLAUDECODE',
    'OPENCODE_SESSION',
    'OPENCODE_HOME',
    'CORTEX_SESSION'
  ]) {
    delete process.env[h];
  }
  process.env.OPENROUTER_API_KEY = 'sk-test-zdr';
  process.env.JEV_CACHE_FILE = ':memory:';
  clearDecisionCache();
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    let bodyObj: any = null;
    if (init?.body && typeof init.body === 'string') {
      try {
        bodyObj = JSON.parse(init.body);
      } catch {
        bodyObj = init.body;
      }
    }
    fetchCalls.push({ url: String(url), body: bodyObj });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"answers":{"test":{"choice":"a"}}}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('readZdrPolicy resolution hierarchy', () => {
  it('defaults to "off" when no configs and no env vars exist', () => {
    expect(readZdrPolicy()).toBe('off');
  });

  it('reads JEV_ZDR when no config files exist', () => {
    process.env.JEV_ZDR = 'on';
    expect(readZdrPolicy()).toBe('on');

    process.env.JEV_ZDR = '1';
    expect(readZdrPolicy()).toBe('on');

    process.env.JEV_ZDR = 'true';
    expect(readZdrPolicy()).toBe('on');

    process.env.JEV_ZDR = 'strict';
    expect(readZdrPolicy()).toBe('strict');

    process.env.JEV_ZDR = 'STRICT';
    expect(readZdrPolicy()).toBe('strict');

    process.env.JEV_ZDR = 'off';
    expect(readZdrPolicy()).toBe('off');

    process.env.JEV_ZDR = '0';
    expect(readZdrPolicy()).toBe('off');

    process.env.JEV_ZDR = 'false';
    expect(readZdrPolicy()).toBe('off');
  });

  it('prioritizes config.json (privacy.zdr) over JEV_ZDR', () => {
    process.env.JEV_ZDR = 'off';
    writeConfig({ version: 2, privacy: { zdr: 'strict' } });

    expect(readZdrPolicy()).toBe('strict');
  });

  it('supports boolean true/false in config.json', () => {
    writeConfig({ version: 2, privacy: { zdr: true } });
    expect(readZdrPolicy()).toBe('on');

    writeConfig({ version: 2, privacy: { zdr: false } });
    expect(readZdrPolicy()).toBe('off');
  });

  it('prioritizes egress.json over config.json and JEV_ZDR', () => {
    process.env.JEV_ZDR = 'off';
    writeConfig({ version: 2, privacy: { zdr: 'off' } });
    writeEgress({ zdr: 'strict' });

    expect(readZdrPolicy()).toBe('strict');
  });

  it('supports boolean true/false in egress.json', () => {
    writeEgress({ zdr: true });
    expect(readZdrPolicy()).toBe('on');

    writeEgress({ zdr: false });
    expect(readZdrPolicy()).toBe('off');
  });
});

describe('Client Payload Integration for ZDR', () => {
  const questions = { test: { type: 'choice', instructions: 'choose', criteria: { a: 'A' } } };

  it('callJevDecision injects provider.zdr and data_collection when ZDR is on', async () => {
    process.env.JEV_ZDR = 'on';

    await callJevDecision('test state', questions);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.provider).toEqual({ zdr: true, data_collection: 'deny' });
  });

  it('callJevDecision injects provider.zdr when ZDR is strict', async () => {
    process.env.JEV_ZDR = 'strict';

    await callJevDecision('test state', questions);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.provider).toEqual({ zdr: true, data_collection: 'deny' });
  });

  it('callJevDecision omits provider when ZDR is off', async () => {
    process.env.JEV_ZDR = 'off';

    await callJevDecision('test state', questions);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.provider).toBeUndefined();
  });

  it('callJevRouter injects provider.zdr when ZDR is on', async () => {
    process.env.JEV_ZDR = 'on';

    await callJevRouter('test state', questions);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.provider).toEqual({ zdr: true, data_collection: 'deny' });
  });

  it('callRouterCompletion injects provider.zdr when ZDR is on', async () => {
    process.env.JEV_ZDR = 'on';

    await callRouterCompletion('test prompt');

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.provider).toEqual({ zdr: true, data_collection: 'deny' });
  });
});

describe('callOpenRouterFree ZDR gating', () => {
  it('throws JEV_ZDR_UNAVAILABLE before fetch when ZDR is strict', async () => {
    process.env.JEV_ZDR = 'strict';

    let thrown: any = null;
    try {
      await callOpenRouterFree('test free prompt');
    } catch (err: any) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe(EGRESS_ZDR_UNAVAILABLE_CODE);
    expect(thrown.message).toContain('Zero Data Retention (ZDR)');
    expect(fetchCalls.length).toBe(0);
  });

  it('executes successfully and omits provider.zdr when ZDR is on', async () => {
    process.env.JEV_ZDR = 'on';

    const result = await callOpenRouterFree('test free prompt');

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.provider?.zdr).toBeUndefined();
    expect(result.content).toBeDefined();
  });
});

describe('Upstream 404 Guardrail Rejections', () => {
  const questions = { test: { type: 'choice', instructions: 'choose', criteria: { a: 'A' } } };

  it('callJevDecision wraps 404 guardrail restrictions as JEV_ZDR_UNAVAILABLE', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ error: { message: 'Provider rejected request due to guardrail restrictions' } }),
        { status: 404 }
      );
    }) as typeof fetch;

    let thrown: any = null;
    try {
      await callJevDecision('test state', questions);
    } catch (err: any) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe(EGRESS_ZDR_UNAVAILABLE_CODE);
  });

  it('callJevRouter wraps 404 data policy error as JEV_ZDR_UNAVAILABLE', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ error: { message: 'No router pool model is routable with current data policy' } }),
        { status: 404 }
      );
    }) as typeof fetch;

    let thrown: any = null;
    try {
      await callJevRouter('test state', questions);
    } catch (err: any) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe(EGRESS_ZDR_UNAVAILABLE_CODE);
  });
});

describe('Audit Logging for ZDR', () => {
  it('records zdr_policy and zdr_applied in egress log', () => {
    writeEgress({ allowPaths: [process.cwd()], zdr: 'on' });

    assertEgressAllowed(
      'https://openrouter.ai/api/v1/chat/completions',
      JSON.stringify({ model: 'test/model', provider: { zdr: true, data_collection: 'deny' } })
    );

    const logFile = egressLogFile();
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf8').trim();
    const entry = JSON.parse(content);
    expect(entry.zdr_policy).toBe('on');
    expect(entry.zdr_applied).toBe(true);
  });
});
