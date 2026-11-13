import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { catalogueNotice, maybeStartCatalogueRefresh, findBun, type TriggerDeps } from '../claude/refresh-trigger.js';
import { buildCatalogue, saveCatalogue, loadCatalogue, type Catalogue } from '../src/core/catalogue.js';
import { refreshLockPath, type RefreshConfig } from '../src/refresh/config.js';
import { tryLock } from '../src/core/lock.js';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);
const CFG: RefreshConfig = { enabled: true, maxAgeDays: 7, maxCalls: 20, candidates: [] };

let dir = '';
let script = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-trigger-'));
  script = path.join(dir, 'jev-models.ts');
  fs.writeFileSync(script, '// stub');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function seed(at: Date, extra: Array<{ id: string; ok: boolean; alias?: string }> = [{ id: 'claude-sonnet-5-5', ok: true, alias: 'sonnet' }]): Catalogue {
  const cat = buildCatalogue('claude-code', extra, 'probe', null, at);
  expect(saveCatalogue(cat, path.join(dir, 'models'))).toBe(true);
  return cat;
}

function setup(over: Partial<TriggerDeps> = {}) {
  const spawned: Array<{ bun: string; args: string[] }> = [];
  const deps: TriggerDeps = {
    env: {},
    readMode: () => 'on',
    loadConfig: () => CFG,
    dir: path.join(dir, 'models'),
    now: NOW,
    findBun: () => '/usr/bin/bun',
    scriptPath: script,
    spawnDetached: (bun, args) => {
      spawned.push({ bun, args });
      return { pid: process.pid, unref() {} };
    },
    ...over
  };
  return { deps, spawned };
}

const lockFile = (): string => refreshLockPath('claude-code', path.join(dir, 'models'));

describe('background refresh trigger', () => {
  it('starts a detached refresh when the catalogue is missing', () => {
    const { deps, spawned } = setup();
    expect(maybeStartCatalogueRefresh(deps)).toBe('started');
    expect(spawned).toEqual([{ bun: '/usr/bin/bun', args: [script, 'refresh', '--harness', 'claude-code', '--quiet'] }]);
  });

  it('starts when the catalogue is older than maxAgeDays', () => {
    seed(daysAgo(8));
    const { deps, spawned } = setup();
    expect(maybeStartCatalogueRefresh(deps)).toBe('started');
    expect(spawned.length).toBe(1);
  });

  it('does nothing for a fresh catalogue', () => {
    seed(daysAgo(2));
    const { deps, spawned } = setup();
    expect(maybeStartCatalogueRefresh(deps)).toBe('fresh');
    expect(spawned).toEqual([]);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('honours models.refresh.maxAgeDays', () => {
    seed(daysAgo(8));
    const longer = setup({ loadConfig: () => ({ ...CFG, maxAgeDays: 30 }) });
    expect(maybeStartCatalogueRefresh(longer.deps)).toBe('fresh');
    const shorter = setup({ loadConfig: () => ({ ...CFG, maxAgeDays: 1 }) });
    expect(maybeStartCatalogueRefresh(shorter.deps)).toBe('started');
  });

  it('does nothing unless Jev mode is on', () => {
    for (const mode of ['off', 'on-demand']) {
      const { deps, spawned } = setup({ readMode: () => mode });
      expect(maybeStartCatalogueRefresh(deps)).toBe('mode-off');
      expect(spawned).toEqual([]);
    }
  });

  it('does nothing when the config turns the refresh off, or JEV_MODEL_REFRESH=off', () => {
    const cfgOff = setup({ loadConfig: () => ({ ...CFG, enabled: false }) });
    expect(maybeStartCatalogueRefresh(cfgOff.deps)).toBe('disabled');
    const envOff = setup({ env: { JEV_MODEL_REFRESH: 'off' } });
    expect(maybeStartCatalogueRefresh(envOff.deps)).toBe('disabled');
    expect(cfgOff.spawned.length + envOff.spawned.length).toBe(0);
  });

  it('does nothing while another refresh holds the lock', () => {
    expect(tryLock(lockFile(), 60_000)).toBe(true);
    const { deps, spawned } = setup();
    expect(maybeStartCatalogueRefresh(deps)).toBe('locked');
    expect(spawned).toEqual([]);
  });

  it('takes over a lock whose owner is gone', () => {
    fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: 2 ** 22 + 12345, ts: Date.now() }));
    const { deps, spawned } = setup();
    expect(maybeStartCatalogueRefresh(deps)).toBe('started');
    expect(spawned.length).toBe(1);
  });

  it('hands the lock to the spawned process, so a second session starting at once does nothing', () => {
    const { deps, spawned } = setup({ spawnDetached: () => ({ pid: process.ppid, unref() {} }) });
    expect(maybeStartCatalogueRefresh(deps)).toBe('started');
    expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8')).pid).toBe(process.ppid);
    expect(maybeStartCatalogueRefresh(deps)).toBe('locked');
    expect(spawned).toEqual([]);
  });

  it('releases the lock and reports the failure when the spawn throws', () => {
    const { deps } = setup({
      spawnDetached: () => {
        throw new Error('EAGAIN');
      }
    });
    expect(maybeStartCatalogueRefresh(deps)).toBe('spawn-failed');
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('releases the lock when the child has no pid', () => {
    const { deps } = setup({ spawnDetached: () => ({ unref() {} }) });
    expect(maybeStartCatalogueRefresh(deps)).toBe('spawn-failed');
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('skips silently when bun or the script is not found', () => {
    const noBun = setup({ findBun: () => null });
    expect(maybeStartCatalogueRefresh(noBun.deps)).toBe('no-bun');
    const noScript = setup({ scriptPath: path.join(dir, 'missing.ts') });
    expect(maybeStartCatalogueRefresh(noScript.deps)).toBe('no-script');
    expect(noBun.spawned.length + noScript.spawned.length).toBe(0);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('never throws, whatever fails', () => {
    const boom = setup({
      loadConfig: () => {
        throw new Error('bad config');
      }
    });
    expect(maybeStartCatalogueRefresh(boom.deps)).toBe('error');
    const badMode = setup({
      readMode: () => {
        throw new Error('bad mode');
      }
    });
    expect(maybeStartCatalogueRefresh(badMode.deps)).toBe('error');
  });

  it('returns at once: it does not wait for the refresh', () => {
    const { deps } = setup({ spawnDetached: () => ({ pid: process.pid, unref() {} }) });
    const start = performance.now();
    maybeStartCatalogueRefresh(deps);
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('the default spawn really is detached with ignored stdio (checked on a harmless command)', async () => {
    // A real run of the default spawner against a stub script that writes a marker file and exits.
    const marker = path.join(dir, 'marker');
    const stub = path.join(dir, 'stub.ts');
    fs.writeFileSync(stub, `import * as fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));`);
    const bun = findBun();
    expect(bun).not.toBeNull();
    const { deps } = setup({ findBun: () => bun, scriptPath: stub, spawnDetached: undefined });
    expect(maybeStartCatalogueRefresh(deps)).toBe('started');
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.readFileSync(marker, 'utf8')).toBe('refresh --harness claude-code --quiet');
  });
});

describe('findBun', () => {
  it('uses the running bun', () => {
    expect(findBun()).toBe(process.execPath);
  });
});

describe('catalogueNotice', () => {
  const models = (): string => path.join(dir, 'models');
  const opts = (extra = {}) => ({ dir: models(), now: NOW, maxAgeDays: 7, ...extra });

  it('says to refresh when there is no catalogue yet', () => {
    expect(catalogueNotice('claude-code', 'sonnet', opts())).toBe('Jev model catalogue: none yet for claude-code; run /jev-refresh');
  });

  it('is null for a known, usable id in a fresh catalogue', () => {
    seed(daysAgo(1));
    expect(catalogueNotice('claude-code', 'claude-sonnet-5-5', opts())).toBeNull();
    expect(catalogueNotice('claude-code', 'sonnet', opts())).toBeNull();
    expect(catalogueNotice('claude-code', 'claude-sonnet-5-5[1m]', opts())).toBeNull();
    expect(catalogueNotice('claude-code', 'claude-sonnet-5-5-20260101', opts())).toBeNull();
  });

  it('names an id the catalogue does not know', () => {
    seed(daysAgo(1));
    expect(catalogueNotice('claude-code', 'claude-sonnet-6', opts())).toBe('Jev model catalogue: "claude-sonnet-6" is not in the catalogue; run /jev-refresh');
    expect(catalogueNotice('claude-code', 'opus', opts())).toContain('is not in the catalogue');
  });

  it('names an id marked missing', () => {
    seed(daysAgo(1), [{ id: 'claude-sonnet-5-5', ok: true }, { id: 'claude-opus-4-5', ok: true }]);
    const cat = loadCatalogue('claude-code', models())!;
    saveCatalogue(buildCatalogue('claude-code', [{ id: 'claude-opus-4-5', ok: false }], 'probe', cat, daysAgo(1)), models());
    expect(catalogueNotice('claude-code', 'claude-opus-4-5', opts())).toBe('Jev model catalogue: "claude-opus-4-5" is marked missing; run /jev-refresh');
  });

  it('names an id that needs review', () => {
    seed(daysAgo(1), [{ id: 'claude-zephyr-1', ok: true }]);
    expect(catalogueNotice('claude-code', 'claude-zephyr-1', opts())).toBe('Jev model catalogue: "claude-zephyr-1" is not ranked yet (needs review); run /jev-refresh');
  });

  it('warns about a stale catalogue for a known id', () => {
    seed(daysAgo(10));
    expect(catalogueNotice('claude-code', 'claude-sonnet-5-5', opts())).toBe('Jev model catalogue: last refreshed 10 days ago; run /jev-refresh');
  });

  it('puts an unknown id before staleness', () => {
    seed(daysAgo(30));
    expect(catalogueNotice('claude-code', 'claude-sonnet-9', opts())).toContain('is not in the catalogue');
  });

  it('is null for an empty id and never throws', () => {
    expect(catalogueNotice('claude-code', '', opts())).toBeNull();
    expect(catalogueNotice('../evil', 'sonnet', opts())).toBe('Jev model catalogue: none yet for ../evil; run /jev-refresh');
  });
});
