import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readQuotaView } from '../src/core/governance.ts';

/** A7: the Carbon / Argon variant follows the resolved active model, not the stale global quota-state one. */
describe('readQuotaView variant source (A7)', () => {
  let dir = '';
  let sessions = '';
  let origQuota: string | undefined;
  let origConfig: string | undefined;
  const CONV = '00000000-0000-4000-8000-00000000a701';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-variant-'));
    sessions = path.join(dir, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    origQuota = process.env.JEV_QUOTA_STATE_FILE;
    origConfig = process.env.JEV_CONFIG_FILE;
    process.env.JEV_CONFIG_FILE = path.join(dir, 'config.json');
    process.env.JEV_QUOTA_STATE_FILE = path.join(dir, 'quota-state.json');
  });
  afterEach(() => {
    if (origQuota === undefined) delete process.env.JEV_QUOTA_STATE_FILE;
    else process.env.JEV_QUOTA_STATE_FILE = origQuota;
    if (origConfig === undefined) delete process.env.JEV_CONFIG_FILE;
    else process.env.JEV_CONFIG_FILE = origConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const now = () => Math.floor(Date.now() / 1000);
  const bucket = (f: number) => ({ remaining_fraction: f, reset_in_seconds: 3600 });
  function writeQuota(activeModel: string): void {
    fs.writeFileSync(
      process.env.JEV_QUOTA_STATE_FILE!,
      JSON.stringify({
        schema: 2,
        updated_at: now(),
        active_model: activeModel,
        buckets: { 'gemini-5h': bucket(0.8), 'gemini-weekly': bucket(0.6), 'gemini-argon-wtu-weekly': bucket(0.2) }
      })
    );
  }
  function writeConversation(model: string): void {
    fs.writeFileSync(path.join(sessions, `${CONV}.model.json`), JSON.stringify({ conversationId: CONV, model, updated_at: now() }));
  }
  const view = () => readQuotaView({ conversationId: CONV, overrideSessionsDir: sessions });

  it('the conversation says Carbon, quota-state says Argon: Carbon, and the frontier pool is the Carbon one', async () => {
    writeQuota('Orchestrator (Argon)');
    writeConversation('Orchestrator (Carbon)');
    const v = await view();
    expect(v.activeModelSource).toBe('argument');
    expect(v.variant).toBe('carbon');
    expect(v.pools?.frontier.weekly).toBeCloseTo(0.6);
  });

  it('the conversation says Argon, quota-state says Carbon: Argon, and the frontier pool is the Argon one', async () => {
    writeQuota('Orchestrator (Carbon)');
    writeConversation('Orchestrator (Argon)');
    const v = await view();
    expect(v.variant).toBe('argon');
    expect(v.pools?.frontier.weekly).toBeCloseTo(0.2);
  });

  it('the conversation says Orchestrator (Carbon) and quota-state names Hydrogen: Carbon', async () => {
    writeQuota('Gemini 4 Hydrogen (Low)');
    writeConversation('Orchestrator (Carbon)');
    expect((await view()).variant).toBe('carbon');
  });

  it('the conversation says Hydrogen and quota-state says Orchestrator (Carbon): not an orchestrator, no variant', async () => {
    writeQuota('Orchestrator (Carbon)');
    writeConversation('Gemini 4 Hydrogen (Low)');
    const v = await view();
    expect(v.variant).toBeUndefined();
    expect(v.pools).toBeUndefined();
  });

  it('with no conversation record the quota-state model decides (source quota-state)', async () => {
    writeQuota('Orchestrator (Carbon)');
    const v = await readQuotaView({ overrideSessionsDir: sessions });
    expect(v.activeModelSource).toBe('quota-state');
    expect(v.variant).toBe('carbon');
  });

  it('a conversation model with no variant in its name does not borrow the stale global variant', async () => {
    writeQuota('Orchestrator (Carbon)');
    writeConversation('Orchestrator');
    const v = await view();
    expect(v.activeModelSource).toBe('argument');
    expect(v.variant).toBe('argon'); // falls to the plan-tier / config default, never to the stale global model
  });
});
