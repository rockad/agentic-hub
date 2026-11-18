/**
 * Antigravity `agent_call` rows and the recommendation (R1): every row carries `modelRecommended` / `recommendedTier`
 * when the turn's recommendation is known when the call arrives, and a row written before the pre-flight finished is
 * marked `recommendationPending: true` and gets a late `agent_call_recommendation` row from the pre-flight, carrying the
 * same `callKey`. Hermetic: a temp HOME, a stubbed router, no real ~/.config or ~/.gemini.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPreflight } from '../antigravity/preflight.ts';
import { turnId, writeAntigravityTurn } from '../antigravity/logic.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';

const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const CONV = 'conv-late-rec';
const PROMPT = 'tidy up the synthetic notes folder please';
const TURN = turnId(PROMPT);

let home = '';
let origHome = '';
let origConfig = '';
let origTelemetry = '';
let origQuota = '';
const sessions = () => path.join(home, '.config', 'jev', 'antigravity-sessions');
const telemetryPath = () => path.join(home, '.gemini', 'antigravity-cli', 'jev_telemetry.jsonl');
const pendingFile = () => path.join(sessions(), `${CONV}.turn-pending.json`);

function setMode(mode: string) {
  fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode } }));
}

beforeEach(() => {
  clearConfigCacheForTesting();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-late-rec-'));
  fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'),
    JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' })
  );
  setMode('on');
  origHome = process.env.HOME || '';
  origConfig = process.env.JEV_CONFIG_FILE || '';
  origTelemetry = process.env.JEV_TELEMETRY_FILE || '';
  origQuota = process.env.JEV_QUOTA_STATE_FILE || '';
  process.env.HOME = home;
  process.env.JEV_CONFIG_FILE = path.join(home, '.config', 'jev', 'config.json');
  process.env.JEV_TELEMETRY_FILE = telemetryPath();
  process.env.JEV_QUOTA_STATE_FILE = path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json');
});

afterEach(() => {
  clearConfigCacheForTesting();
  process.env.HOME = origHome;
  for (const [k, v] of [
    ['JEV_CONFIG_FILE', origConfig],
    ['JEV_TELEMETRY_FILE', origTelemetry],
    ['JEV_QUOTA_STATE_FILE', origQuota]
  ] as const) {
    if (v) process.env[k] = v;
    else delete process.env[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function runHook(input: object) {
  return Bun.spawnSync(['bun', HOOK, 'pre-tool-use'], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: {
      ...process.env,
      HOME: home,
      JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json'),
      JEV_TELEMETRY_FILE: telemetryPath(),
      JEV_OPENROUTER_API_KEY: '',
      OPENROUTER_API_KEY: '',
      JEV_DOWNGRADE: 'off'
    }
  });
}

function call(model: string, id = 'call_a', stepIdx = 7, prompt = PROMPT) {
  return {
    conversationId: CONV,
    modelName: 'gemini-3.8-flash-low',
    lastUserInput: prompt,
    stepIdx,
    toolCall: { id, name: 'invoke_subagent', args: { TypeName: 'research', Role: 'worker', Prompt: 'read the notes', Model: model } }
  };
}

const rows = (): Record<string, any>[] =>
  fs.existsSync(telemetryPath())
    ? fs.readFileSync(telemetryPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];
const agentCalls = () => rows().filter((r) => r.event === 'agent_call');
const lateRows = () => rows().filter((r) => r.event === 'agent_call_recommendation');

async function preflight(recommendedTier = 'flash', prompt = PROMPT) {
  const origLog = console.log;
  console.log = () => {};
  try {
    await runPreflight(
      JSON.stringify({ conversationId: CONV, modelName: 'gemini-3.8-flash-low', lastUserInput: prompt, invocationNum: 1 }),
      {
        autoHeal: () => {},
        callJev: async () =>
          ({ answers: { recommendedSubagent: { choice: 'research' }, recommendedTier: { choice: recommendedTier } } }) as any
      }
    );
  } finally {
    console.log = origLog;
  }
}

describe('agent_call rows carry the recommendation known when the call arrives (all decisions)', () => {
  function seedTurn() {
    writeAntigravityTurn(sessions(), CONV, { turn: TURN, recommendedTier: 'flash', recommendedSubagent: 'research', at: new Date().toISOString() });
  }

  it('deny, pass and allow rows all attach modelRecommended and recommendedTier, none is pending', () => {
    seedTurn();
    expect(runHook(call('pro', 'c1')).exitCode).toBe(0); // above the ceiling, no approval: deny
    expect(runHook(call('flash_lite', 'c2')).exitCode).toBe(0); // within the ceiling: pass
    const out = rows().filter((r) => r.event === 'agent_call');
    expect(out.map((r) => r.decision)).toEqual(['deny', 'pass']);
    for (const r of out) {
      expect(r.modelRecommended).toBe('flash');
      expect(r.recommendedTier).toBe('flash');
      expect(r.recommendationPending).toBeUndefined();
      expect(r.turn).toBe(TURN);
    }
  });

  it('every agent_call row carries a callKey: the tool call id, else the step index', () => {
    seedTurn();
    runHook(call('flash_lite', 'call_x', 11));
    const noId = call('flash_lite', 'ignored', 12) as any;
    delete noId.toolCall.id;
    runHook(noId);
    expect(agentCalls().map((r) => r.callKey)).toEqual(['call_x', 'step:12']);
  });
});

describe('a row written before the pre-flight finished gets a late recommendation row', () => {
  it('deny row: marked pending, then the pre-flight appends agent_call_recommendation with the same callKey', async () => {
    runHook(call('pro', 'call_deny'));
    const first = agentCalls()[0];
    expect(first.decision).toBe('deny');
    expect(first.recommendationPending).toBe(true);
    expect(first.modelRecommended).toBeUndefined();
    expect(first.callKey).toBe('call_deny');

    await preflight('flash');

    const late = lateRows();
    expect(late.length).toBe(1);
    expect(late[0]).toMatchObject({
      harness: 'antigravity',
      toolOrHook: 'PreToolUse',
      event: 'agent_call_recommendation',
      turn: TURN,
      callKey: 'call_deny',
      modelRecommended: 'flash',
      recommendedTier: 'flash',
      recommendationLate: true,
      decision: 'deny',
      requestedModel: 'pro'
    });
    // Denied: the run did not go ahead, so no modelUsed on the late row either.
    expect(late[0].modelUsed).toBeUndefined();
    expect(late[0].modelUsedSource).toBeUndefined();
    // The pre-flight's own row is still written, and the late row comes after the state holds the recommendation.
    expect(rows().filter((r) => r.toolOrHook === 'PreInvocation').length).toBe(1);
    expect(fs.existsSync(pendingFile())).toBe(false);
  });

  it('pass row: the late row carries the decision, requestedModel and modelUsed so it stands alone', async () => {
    runHook(call('flash_lite', 'call_pass'));
    expect(agentCalls()[0].recommendationPending).toBe(true);
    await preflight('flash_lite');
    const late = lateRows()[0];
    expect(late).toMatchObject({
      callKey: 'call_pass',
      decision: 'pass',
      requestedModel: 'flash_lite',
      modelUsed: 'flash_lite',
      modelUsedSource: 'requested',
      recommendedTier: 'flash_lite',
      modelRecommended: 'flash_lite',
      recommendationLate: true,
      sessionModel: 'gemini-3.8-flash-low'
    });
  });

  it('every call of the turn written without a recommendation gets its own late row; a second pre-flight adds none', async () => {
    runHook(call('pro', 'call_1', 3));
    runHook(call('flash_lite', 'call_2', 4));
    await preflight('flash');
    expect(lateRows().map((r) => r.callKey).sort()).toEqual(['call_1', 'call_2']);
    await preflight('flash');
    expect(lateRows().length).toBe(2);
  });

  it('a call of another turn gets no late row from this turn\'s pre-flight', async () => {
    runHook(call('flash_lite', 'call_other', 5, 'a completely different synthetic request'));
    await preflight('flash');
    expect(lateRows().length).toBe(0);
  });

  it('on-demand mode never runs a pre-flight: the row is not marked pending and nothing is stored', () => {
    setMode('on-demand');
    runHook(call('flash_lite', 'call_od'));
    const r = agentCalls()[0];
    expect(r.recommendationPending).toBeUndefined();
    expect(fs.existsSync(pendingFile())).toBe(false);
  });

  it('a held lock fails open: the row is still written, pending, and the hook is not blocked for long', () => {
    fs.mkdirSync(sessions(), { recursive: true });
    const lock = path.join(sessions(), `${CONV}.turn.lock`);
    fs.mkdirSync(lock);
    const started = Date.now();
    const proc = runHook(call('flash_lite', 'call_locked'));
    expect(proc.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    const r = agentCalls()[0];
    expect(r.recommendationPending).toBe(true);
    expect(r.callKey).toBe('call_locked');
  });

  it('the pre-flight records no private text in the late row', async () => {
    runHook(call('pro', 'call_priv'));
    await preflight('flash');
    expect(JSON.stringify(lateRows())).not.toContain('tidy up');
    expect(JSON.stringify(lateRows())).not.toContain('read the notes');
  });
});
