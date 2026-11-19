import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readQuotaView, quotaStateFile } from '../src/core/governance.ts';
import { jevHomeDir } from '../src/core/private-fs.ts';

describe('readQuotaView source and call-time paths', () => {
  let dir = '';
  let origQuota: string | undefined;
  let origConfig: string | undefined;
  let origHome: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-source-'));
    origQuota = process.env.JEV_QUOTA_STATE_FILE;
    origConfig = process.env.JEV_CONFIG_FILE;
    origHome = process.env.HOME;
    process.env.JEV_CONFIG_FILE = path.join(dir, 'config.json');
  });

  afterEach(() => {
    if (origQuota === undefined) delete process.env.JEV_QUOTA_STATE_FILE;
    else process.env.JEV_QUOTA_STATE_FILE = origQuota;
    if (origConfig === undefined) delete process.env.JEV_CONFIG_FILE;
    else process.env.JEV_CONFIG_FILE = origConfig;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a legacy schema-1 file at the overridden path reports that path as its source', async () => {
    const file = path.join(dir, 'quota-v1.json');
    fs.writeFileSync(file, JSON.stringify({ remaining_fraction: 0.5, updated_at: Math.floor(Date.now() / 1000) }));
    process.env.JEV_QUOTA_STATE_FILE = file;
    const view = await readQuotaView({ overrideSessionsDir: path.join(dir, 'sessions') });
    expect(view.schema).toBe(1);
    expect(view.source).toBe(file);
  });

  it('JEV_QUOTA_LEGACY_FILE overrides the legacy fallback path at call time', async () => {
    const legacy = path.join(dir, 'legacy-quota.json');
    fs.writeFileSync(legacy, JSON.stringify({ remaining_fraction: 0.4, updated_at: Math.floor(Date.now() / 1000) }));
    process.env.JEV_QUOTA_STATE_FILE = path.join(dir, 'missing-state.json');
    const prev = process.env.JEV_QUOTA_LEGACY_FILE;
    process.env.JEV_QUOTA_LEGACY_FILE = legacy;
    try {
      const view = await readQuotaView({ overrideSessionsDir: path.join(dir, 'sessions') });
      expect(view.schema).toBe(1);
      expect(view.source).toBe(legacy);
    } finally {
      if (prev === undefined) delete process.env.JEV_QUOTA_LEGACY_FILE;
      else process.env.JEV_QUOTA_LEGACY_FILE = prev;
    }
  });

  it('the default quota path follows HOME at call time', () => {
    process.env.HOME = path.join(dir, 'home');
    expect(jevHomeDir()).toBe(path.join(dir, 'home'));
    expect(quotaStateFile()).toBe(path.join(dir, 'home', '.gemini', 'antigravity-cli', 'quota-state.json'));
  });
});
