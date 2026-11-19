import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeAntigravitySessionModel,
  readQuotaView,
  pruneExpiredSessionModels,
  ANTIGRAVITY_SESSION_TTL_SEC,
  QUOTA_STATE_FILE
} from '../src/core/governance.ts';
import { handleQuotaTool } from '../src/tools/quota.ts';
import { handleDispatchTool, handleBatchDispatchTool } from '../src/tools/dispatch.ts';

describe('Antigravity per-conversation session store', () => {
  let tmpDir = '';
  let sessionsDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-session-store-test-'));
    sessionsDir = path.join(tmpDir, 'antigravity-sessions');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeAntigravitySessionModel writes <safeId>.model.json and latest.json without pid', () => {
    const convId = 'conv-session-123';
    writeAntigravitySessionModel(convId, 'gemini-3.8-pro-preview', 1000, sessionsDir);

    const modelFile = path.join(sessionsDir, `${convId}.model.json`);
    const latestFile = path.join(sessionsDir, 'latest.json');

    expect(fs.existsSync(modelFile)).toBe(true);
    expect(fs.existsSync(latestFile)).toBe(true);

    const modelContent = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
    expect(modelContent).toEqual({
      conversationId: convId,
      model: 'gemini-3.8-pro-preview',
      updated_at: 1000
    });
    expect(modelContent.pid).toBeUndefined();

    const latestContent = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
    expect(latestContent).toEqual({
      conversationId: convId,
      model: 'gemini-3.8-pro-preview',
      updated_at: 1000
    });
    expect(latestContent.pid).toBeUndefined();
  });

  it('sanitizes conversationId and does nothing on invalid/empty id', () => {
    writeAntigravitySessionModel('../traversal', 'gemini-flash', 1000, sessionsDir);
    expect(fs.existsSync(sessionsDir)).toBe(true);
    // Sanitized to traversal
    expect(fs.existsSync(path.join(sessionsDir, 'traversal.model.json'))).toBe(true);

    // Empty/non-alphanumeric sanitizes to null -> does nothing
    writeAntigravitySessionModel('///...', 'gemini-flash', 1000, sessionsDir);
    expect(fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.model.json'))).toHaveLength(1);
  });

  it('prunes expired *.model.json strictly preserving approvals, locks, and latest.json', () => {
    fs.mkdirSync(sessionsDir, { recursive: true });

    // 1. Expired model file (updated_at = 1000, now = 1000 + 7201)
    const expiredFile = path.join(sessionsDir, 'expired.model.json');
    fs.writeFileSync(expiredFile, JSON.stringify({ conversationId: 'expired', model: 'pro', updated_at: 1000 }));

    // 2. Active model file (updated_at = 8000, now = 8200)
    const activeFile = path.join(sessionsDir, 'active.model.json');
    fs.writeFileSync(activeFile, JSON.stringify({ conversationId: 'active', model: 'pro', updated_at: 8000 }));

    // 3. Files that MUST NEVER be pruned
    const approvalsFile = path.join(sessionsDir, 'sess.approvals.json');
    fs.writeFileSync(approvalsFile, JSON.stringify({ approvals: [] }));

    const lockFile = path.join(sessionsDir, 'sess.approvals.lock');
    fs.writeFileSync(lockFile, 'locked');

    const latestFile = path.join(sessionsDir, 'latest.json');
    fs.writeFileSync(latestFile, JSON.stringify({ conversationId: 'expired', model: 'pro', updated_at: 1000 }));

    // Run pruning at nowSec = 1000 + ANTIGRAVITY_SESSION_TTL_SEC + 10 = 8210
    pruneExpiredSessionModels(sessionsDir, 1000 + ANTIGRAVITY_SESSION_TTL_SEC + 10, true);

    expect(fs.existsSync(expiredFile)).toBe(false);
    expect(fs.existsSync(activeFile)).toBe(true);
    expect(fs.existsSync(approvalsFile)).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(fs.existsSync(latestFile)).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, '.prune-stamp'))).toBe(true);
  });

  it('expires *.turn.json by mtime with the session TTL, and keeps a fresh one', () => {
    fs.mkdirSync(sessionsDir, { recursive: true });
    const nowSec = 1_900_000_000;
    const old = path.join(sessionsDir, '00000000-old.turn.json');
    const fresh = path.join(sessionsDir, '00000000-new.turn.json');
    fs.writeFileSync(old, '{}');
    fs.writeFileSync(fresh, '{}');
    fs.utimesSync(old, nowSec - ANTIGRAVITY_SESSION_TTL_SEC - 10, nowSec - ANTIGRAVITY_SESSION_TTL_SEC - 10);
    fs.utimesSync(fresh, nowSec - 5, nowSec - 5);

    pruneExpiredSessionModels(sessionsDir, nowSec, true);

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('expires *.turn-pending.json by mtime with the session TTL, and keeps a fresh one', () => {
    fs.mkdirSync(sessionsDir, { recursive: true });
    const nowSec = 1_900_000_000;
    const old = path.join(sessionsDir, '00000000-old.turn-pending.json');
    const fresh = path.join(sessionsDir, '00000000-new.turn-pending.json');
    fs.writeFileSync(old, '{}');
    fs.writeFileSync(fresh, '{}');
    fs.utimesSync(old, nowSec - ANTIGRAVITY_SESSION_TTL_SEC - 10, nowSec - ANTIGRAVITY_SESSION_TTL_SEC - 10);
    fs.utimesSync(fresh, nowSec - 5, nowSec - 5);

    pruneExpiredSessionModels(sessionsDir, nowSec, true);

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe('readQuotaView per-field precedence', () => {
  let tmpHome = '';
  let sessionsDir = '';
  let originalConfigFile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-quota-prec-test-'));
    sessionsDir = path.join(tmpHome, 'antigravity-sessions');
    originalConfigFile = process.env.JEV_CONFIG_FILE;
    process.env.JEV_CONFIG_FILE = path.join(tmpHome, 'config.json');
  });

  afterEach(() => {
    if (originalConfigFile !== undefined) {
      process.env.JEV_CONFIG_FILE = originalConfigFile;
    } else {
      delete process.env.JEV_CONFIG_FILE;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('reads activeModelSource: argument when matching session model exists', async () => {
    writeAntigravitySessionModel('c-arg', 'gemini-3.8-pro-preview', Math.floor(Date.now() / 1000), sessionsDir);

    const view = await readQuotaView({ conversationId: 'c-arg', overrideSessionsDir: sessionsDir });
    expect(view.active_model).toBe('gemini-3.8-pro-preview');
    expect(view.activeModelSource).toBe('argument');
  });

  it('reads activeModelSource: latest when conversationId is omitted but latest.json is valid', async () => {
    writeAntigravitySessionModel('c-latest', 'gemini-3.8-flash-low', Math.floor(Date.now() / 1000), sessionsDir);

    const view = await readQuotaView({ overrideSessionsDir: sessionsDir });
    expect(view.active_model).toBe('gemini-3.8-flash-low');
    expect(view.activeModelSource).toBe('latest');
  });

  it('falls back to activeModelSource: quota-state when session files are expired', async () => {
    // Write expired session (3 hours ago > 7200 sec)
    const oldSec = Math.floor(Date.now() / 1000) - 10800;
    writeAntigravitySessionModel('c-old', 'gemini-3.8-pro-preview', oldSec, sessionsDir);

    const view = await readQuotaView({ conversationId: 'c-old', overrideSessionsDir: sessionsDir });
    expect(view.activeModelSource).toBe('quota-state');
  });

  it('preserves quota_state_active_model alongside overridden active_model', async () => {
    writeAntigravitySessionModel('c-spec', 'gemini-3.8-pro-preview', Math.floor(Date.now() / 1000), sessionsDir);

    const view = await readQuotaView({ conversationId: 'c-spec', overrideSessionsDir: sessionsDir });
    expect(view.active_model).toBe('gemini-3.8-pro-preview');
    expect(view.activeModelSource).toBe('argument');
    // quota_state_active_model reflects whatever raw value quota-state had (or undefined if no quota-state file)
    expect('quota_state_active_model' in view).toBe(true);
  });

  it('per-field precedence against stale quota-state.json with newer updated_at in subprocess', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-prec-'));
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      // 1. quota-state.json is 30m stale (updated_at = nowSec - 1800) with Argon active_model
      const qDir = path.join(home, '.gemini', 'antigravity-cli');
      fs.mkdirSync(qDir, { recursive: true });
      fs.writeFileSync(
        path.join(qDir, 'quota-state.json'),
        JSON.stringify({
          schema: 2,
          active_model: 'Gemini 4 Argon (High)',
          updated_at: nowSec - 1800,
          buckets: { 'gemini-5h': { remaining_fraction: 0.15 } }
        })
      );

      // 2. Session model was written earlier (nowSec - 2500), but within 7200s TTL
      const sDir = path.join(home, '.config', 'jev', 'antigravity-sessions');
      fs.mkdirSync(sDir, { recursive: true });
      fs.writeFileSync(
        path.join(sDir, 'conv-prec.model.json'),
        JSON.stringify({
          conversationId: 'conv-prec',
          model: 'gemini-3.8-flash-low',
          updated_at: nowSec - 2500
        })
      );

      // 3. Run readQuotaView({ conversationId: 'conv-prec' }) in subprocess with HOME: home
      const script = `
        import { readQuotaView } from './src/core/governance.ts';
        const v = await readQuotaView({ conversationId: 'conv-prec' });
        console.log(JSON.stringify({
          active_model: v.active_model,
          activeModelSource: v.activeModelSource,
          quota_state_active_model: v.quota_state_active_model,
          stale: v.stale,
          updated_at: v.updated_at,
          rem: v.buckets['gemini-5h']?.remaining_fraction
        }));
      `;
      const proc = Bun.spawnSync(['bun', '-e', script], {
        cwd: path.join(import.meta.dir, '..'),
        env: {
          ...process.env,
          HOME: home,
          JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json')
        }
      });
      expect(proc.exitCode).toBe(0);
      const res = JSON.parse(proc.stdout.toString().trim());

      // active_model taken from session file (source: argument)
      expect(res.active_model).toBe('gemini-3.8-flash-low');
      expect(res.activeModelSource).toBe('argument');
      // quota_state_active_model retains raw quota-state value
      expect(res.quota_state_active_model).toBe('Gemini 4 Argon (High)');
      // stale, updated_at, and bucket fractions read from quota-state.json
      expect(res.stale).toBe(true);
      expect(res.updated_at).toBe(nowSec - 1800);
      expect(res.rem).toBe(0.15);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Tools activeModelSource surfacing', () => {
  let tmpHome = '';
  let sessionsDir = '';
  let originalConfigFile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tools-test-'));
    sessionsDir = path.join(tmpHome, 'antigravity-sessions');
    originalConfigFile = process.env.JEV_CONFIG_FILE;
    process.env.JEV_CONFIG_FILE = path.join(tmpHome, 'config.json');
  });

  afterEach(() => {
    if (originalConfigFile !== undefined) {
      process.env.JEV_CONFIG_FILE = originalConfigFile;
    } else {
      delete process.env.JEV_CONFIG_FILE;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('surfaces activeModelSource in jev_quota', async () => {
    writeAntigravitySessionModel('conv-q', 'gemini-3.8-pro-preview', Math.floor(Date.now() / 1000), sessionsDir);
    const res = await handleQuotaTool({ conversationId: 'conv-q' });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.activeModel).toBe('gemini-3.8-pro-preview');
    expect(parsed.activeModelSource).toBe('argument');
  });

  it('surfaces activeModelSource in jev_dispatch', async () => {
    writeAntigravitySessionModel('conv-d', 'gemini-3.8-flash-low', Math.floor(Date.now() / 1000), sessionsDir);
    const origKey = process.env.JEV_OPENROUTER_API_KEY;
    const origFetch = globalThis.fetch;
    process.env.JEV_OPENROUTER_API_KEY = 'test-key';
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          model: 'stub',
          answers: {
            recommendedSubagent: { choice: 'code-engineer', confidence: 0.9, probabilities: {} },
            recommendedTier: { choice: 'flash', confidence: 0.9, probabilities: {} }
          },
          usage: { input_tokens: 1 }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const res = await handleDispatchTool({ task: 'format markdown table', conversationId: 'conv-d' });
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.activeModelSource).toBe('argument');
    } finally {
      process.env.JEV_OPENROUTER_API_KEY = origKey;
      globalThis.fetch = origFetch;
    }
  });

  it('surfaces activeModelSource in jev_batch_dispatch', async () => {
    writeAntigravitySessionModel('conv-b', 'gemini-3.8-flash-low', Math.floor(Date.now() / 1000), sessionsDir);
    const res = await handleBatchDispatchTool({
      tasks: [{ id: 't1', task: 'format markdown table' }],
      conversationId: 'conv-b'
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.activeModelSource).toBe('argument');
  });
});
