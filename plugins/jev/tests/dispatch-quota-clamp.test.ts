/**
 * W-b / W-c (consolidated plan 32.4 Decisions 3 and 5, Invariants 3 and 5): the low-quota step of jev_dispatch and
 * jev_batch_dispatch reads the active pool's strategy (evaluatePoolStrategy, config-overridable thresholds) after the
 * session-model ceiling, and a judgement stage is exempt from the ceiling only. Default thresholds under test:
 * 5h conserve <= 0.30, free_only <= 0.10; weekly conserve <= 0.20, free_only <= 0.10.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyLowQuotaClamp, clampTierToSessionCeiling, evaluatePoolStrategy, getQuotaThresholds } from '../src/core/governance.ts';
import { isExplicitProOverride as fromAntigravityLogic } from '../antigravity/logic.ts';
import { isExplicitProOverride } from '../src/core/governance.ts';

const RUNNER = path.join(import.meta.dir, 'fixtures', 'run-dispatch.ts');
const MARKERS = ['JEV_HARNESS', 'ANTIGRAVITY_CLI', 'GEMINI_CLI', 'CORTEX_SESSION', 'CLAUDE_CODE', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID', 'OPENCODE_SESSION', 'OPENCODE_HOME'];
const BLANK_THRESHOLD_ENV = Object.fromEntries(
  ['JEV_QUOTA_5H_NORMAL_MIN', 'JEV_QUOTA_5H_THRESHOLD', 'JEV_QUOTA_5H_CONSERVE_MIN', 'JEV_QUOTA_5H_CRITICAL', 'JEV_QUOTA_WEEKLY_NORMAL_MIN', 'JEV_QUOTA_WEEKLY_THRESHOLD', 'JEV_QUOTA_7D_NORMAL_MIN', 'JEV_QUOTA_7D_THRESHOLD', 'JEV_QUOTA_WEEKLY_CONSERVE_MIN', 'JEV_QUOTA_7D_CONSERVE_MIN', 'JEV_QUOTA_WEEKLY_CRITICAL', 'JEV_QUOTA_NORMAL_MIN', 'JEV_QUOTA_CONSERVE_MIN'].map((k) => [k, ''])
);

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-quota-clamp-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeConfig(mode: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ defaults: { mode }, ...extra }));
}

/** A quota fixture: the pro session model (no ceiling clamp) with the given 5h and weekly Gemini remaining fractions. */
function writeQuota(fiveHour: number, weekly: number, activeModel = 'gemini-3-pro'): void {
  const dir = path.join(tmp, '.gemini', 'antigravity-cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'quota-state.json'),
    JSON.stringify({
      schema: 2,
      active_model: activeModel,
      updated_at: Math.floor(Date.now() / 1000),
      buckets: { 'gemini-5h': { remaining_fraction: fiveHour }, 'gemini-weekly': { remaining_fraction: weekly } }
    })
  );
}

function runTool(inputJson: { tool: 'batch' | 'single'; args: unknown; answers?: Record<string, string>; offline?: boolean }, harness = 'antigravity'): any {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !MARKERS.includes(k) && !/KEY|TOKEN|SECRET/.test(k)) clean[k] = v;
  const proc = Bun.spawnSync(['bun', RUNNER], {
    stdin: new TextEncoder().encode(JSON.stringify(inputJson)),
    env: {
      ...clean,
      ...BLANK_THRESHOLD_ENV,
      HOME: tmp,
      JEV_HARNESS: harness,
      JEV_CONFIG_FILE: path.join(tmp, 'config.json'),
      JEV_CACHE_FILE: path.join(tmp, 'cache.sqlite'),
      JEV_OPENROUTER_API_KEY: 'test-key'
    }
  });
  if (proc.exitCode !== 0) throw new Error(`runner failed: ${proc.stderr.toString()}`);
  return JSON.parse(proc.stdout.toString());
}

const judgementBatch = (task = 'Decide the reversal of the storage choice') => ({
  availableSubagents: ['self'],
  tasks: [
    { id: 'judge', task, kind: 'judgement', needsEdit: false },
    { id: 'judge-edit', task, kind: 'judgement', needsEdit: true }
  ]
});

// 5h and weekly fixtures straddling each default boundary.
const BOUNDARIES: Array<[string, number, number, 'normal' | 'conserve' | 'free_only']> = [
  ['5h 0.31 is normal', 0.31, 0.5, 'normal'],
  ['5h 0.30 is conserve', 0.3, 0.5, 'conserve'],
  ['5h 0.11 is conserve', 0.11, 0.5, 'conserve'],
  ['5h 0.10 is free_only', 0.1, 0.5, 'free_only'],
  ['weekly 0.21 is normal', 0.9, 0.21, 'normal'],
  ['weekly 0.20 is conserve', 0.9, 0.2, 'conserve']
];

describe('the strategy boundaries the fixtures rely on (evaluatePoolStrategy, default thresholds)', () => {
  it.each(BOUNDARIES)('%s', (_name, five, weekly, expected) => {
    expect(evaluatePoolStrategy(five, weekly, getQuotaThresholds())).toBe(expected);
  });
});

describe('applyLowQuotaClamp', () => {
  const view = (strategy: 'normal' | 'conserve' | 'free_only' | 'unknown', min = 0.2) => ({
    active: { pool: 'gemini' as const, five_hour: min, weekly: min, min_remaining: min, strategy }
  });

  it('mode on: conserve clamps anything above flash_lite to flash_lite, free_only to the free tier', () => {
    expect(applyLowQuotaClamp('pro', view('conserve'), 'on', false).tier).toBe('flash_lite');
    expect(applyLowQuotaClamp('flash', view('conserve'), 'on', false).tier).toBe('flash_lite');
    expect(applyLowQuotaClamp('openrouter_free', view('conserve'), 'on', false).tier).toBe('openrouter_free');
    expect(applyLowQuotaClamp('pro', view('free_only'), 'on', false).tier).toBe('openrouter_free');
    expect(applyLowQuotaClamp('flash_lite', view('free_only'), 'on', false).tier).toBe('openrouter_free');
  });

  it('mode on: free_only goes to flash_lite, not the free tier, when the item edits files', () => {
    expect(applyLowQuotaClamp('pro', view('free_only'), 'on', true)).toMatchObject({ tier: 'flash_lite', wasClampedByQuota: true });
    expect(applyLowQuotaClamp('flash_lite', view('free_only'), 'on', true)).toMatchObject({ tier: 'flash_lite', wasClampedByQuota: false });
  });

  it('leaves a normal or unknown pool, and mode off, untouched', () => {
    expect(applyLowQuotaClamp('pro', view('normal'), 'on', false).tier).toBe('pro');
    expect(applyLowQuotaClamp('pro', view('unknown'), 'on', false).tier).toBe('pro');
    expect(applyLowQuotaClamp('pro', view('free_only'), 'off', false).tier).toBe('pro');
  });

  it('mode on-demand: pro survives with a warning naming the pool and the remaining percent; lower tiers carry none', () => {
    const res = applyLowQuotaClamp('pro', view('conserve', 0.2), 'on-demand', false);
    expect(res.tier).toBe('pro');
    expect(res.wasClampedByQuota).toBe(false);
    expect(res.quotaWarning).toContain('gemini');
    expect(res.quotaWarning).toContain('20%');
    expect(applyLowQuotaClamp('flash', view('free_only'), 'on-demand', false).quotaWarning).toBeUndefined();
  });
});

describe('jev_batch_dispatch: quota step after the ceiling, mode on', () => {
  it.each(BOUNDARIES)('judgement stages at %s', (_name, five, weekly, strategy) => {
    writeConfig('on');
    writeQuota(five, weekly);

    const plan = runTool({ tool: 'batch', args: judgementBatch(), offline: true });

    const [readOnly, editing] = plan.tasks;
    if (strategy === 'normal') {
      expect([readOnly.tier, editing.tier]).toEqual(['pro', 'pro']);
      expect([readOnly.requiresUserApproval, editing.requiresUserApproval, plan.requiresUserApproval]).toEqual([true, true, true]);
      expect(readOnly.wasClampedByQuota).toBeUndefined();
    } else {
      const expected = strategy === 'conserve' ? ['flash_lite', 'flash_lite'] : ['openrouter_free', 'flash_lite'];
      expect([readOnly.tier, editing.tier]).toEqual(expected);
      expect([readOnly.requiresUserApproval, editing.requiresUserApproval, plan.requiresUserApproval]).toEqual([false, false, false]);
      expect(readOnly.wasClampedByQuota).toBe(true);
      expect(readOnly.quotaWarning).toBeUndefined();
      expect(readOnly.executionGuidance).not.toContain('[jev-elevate:pro]');
    }
  });

  it('an override phrase in the task text does not lift the clamp', () => {
    writeConfig('on');
    writeQuota(0.3, 0.5);
    const task = 'Use gemini pro, claude opus and claude fable with manual pro approval and deep reasoning for this decision';

    const plan = runTool({ tool: 'batch', args: judgementBatch(task), offline: true });

    expect(plan.tasks.map((t: any) => [t.tier, t.requiresUserApproval])).toEqual([['flash_lite', false], ['flash_lite', false]]);
    expect(plan.requiresUserApproval).toBe(false);
  });

  it('the clamp reads configured thresholds, not a built-in percentage', () => {
    writeConfig('on', { thresholds: { five_hour_normal_min: 0.5 } });
    writeQuota(0.45, 0.9);

    const plan = runTool({ tool: 'batch', args: judgementBatch(), offline: true });

    expect(plan.tasks.map((t: any) => t.tier)).toEqual(['flash_lite', 'flash_lite']);
  });

  it('a stage that was ceiling-clamped to flash is then quota-clamped to flash_lite, and a legacy item is clamped too', () => {
    writeConfig('on');
    writeQuota(0.25, 0.5, 'flash');
    const args = {
      availableSubagents: ['self'],
      tasks: [
        { id: 'a', task: 'Fold the decisions into the spec', kind: 'settled-edit' },
        { id: 'b', task: 'Architecture overhaul of the schema' }
      ]
    };

    const plan = runTool({ tool: 'batch', args, offline: true });

    expect(plan.tasks.map((t: any) => t.tier)).toEqual(['flash_lite', 'flash_lite']);
    expect(plan.activeSessionModel).toBe('flash');
  });
});

describe('jev_batch_dispatch: mode on-demand', () => {
  it.each(BOUNDARIES)('pro survives with approval at %s', (_name, five, weekly, strategy) => {
    writeConfig('on-demand');
    writeQuota(five, weekly);

    const plan = runTool({ tool: 'batch', args: judgementBatch(), offline: true });

    for (const t of plan.tasks) {
      expect([t.tier, t.requiresUserApproval]).toEqual(['pro', true]);
      expect(t.wasClampedByQuota).toBeUndefined();
      if (strategy === 'normal') {
        expect(t.quotaWarning).toBeUndefined();
      } else {
        expect(t.quotaWarning).toContain('gemini');
        expect(t.quotaWarning).toContain(strategy);
        expect(t.quotaWarning).toMatch(/\d+% remaining/);
        expect(t.executionGuidance).toContain('Delegate to subagent');
      }
    }
    expect(plan.requiresUserApproval).toBe(true);
  });

  it('names the remaining percent of the pool', () => {
    writeConfig('on-demand');
    writeQuota(0.11, 0.5);

    const plan = runTool({ tool: 'batch', args: judgementBatch(), offline: true });

    expect(plan.tasks[0].quotaWarning).toContain('11% remaining');
  });
});

describe('jev_dispatch: quota step after the ceiling', () => {
  const single = { task: 'Design the storage layer' };
  const answers = { recommendedSubagent: 'self', recommendedTier: 'pro' };

  it.each(BOUNDARIES)('mode on at %s', (_name, five, weekly, strategy) => {
    writeConfig('on');
    writeQuota(five, weekly);

    const res = runTool({ tool: 'single', args: single, answers });

    if (strategy === 'normal') {
      expect([res.recommendedTier, res.requiresUserApproval]).toEqual(['pro', true]);
      expect(res.wasClampedByQuota).toBeUndefined();
    } else {
      expect(res.recommendedTier).toBe(strategy === 'conserve' ? 'flash_lite' : 'openrouter_free');
      expect([res.requiresUserApproval, res.wasClampedByQuota, res.wasClampedByCeiling]).toEqual([false, true, false]);
      expect(res.executionGuidance).not.toContain('[jev-elevate:pro]');
      expect('approvalReason' in res).toBe(false);
    }
  });

  it('mode on-demand keeps pro, with approval and a warning, in a low pool', () => {
    writeConfig('on-demand');
    writeQuota(0.1, 0.5);

    const res = runTool({ tool: 'single', args: single, answers });

    expect([res.recommendedTier, res.requiresUserApproval]).toEqual(['pro', true]);
    expect(res.quotaWarning).toContain('gemini');
    expect(res.quotaWarning).toContain('10% remaining');
  });

  it('an override phrase exempts the ceiling clamp only; mode on still clamps the low pool', () => {
    writeConfig('on');
    writeQuota(0.25, 0.5, 'flash');
    const task = 'Use claude fable for this design';

    const res = runTool({ tool: 'single', args: { task }, answers });

    expect([res.recommendedTier, res.wasClampedByCeiling, res.sessionCeilingTier]).toEqual(['flash_lite', false, 'flash']);
    expect(res.wasClampedByQuota).toBe(true);
    expect(res.requiresUserApproval).toBe(false);
  });

  it('reports the ceiling clamp accurately when the pool is healthy', () => {
    writeConfig('on');
    writeQuota(0.9, 0.9, 'flash');

    const res = runTool({ tool: 'single', args: single, answers });

    expect([res.recommendedTier, res.wasClampedByCeiling, res.sessionCeilingTier]).toEqual(['flash', true, 'flash']);
    expect(res.wasClampedByQuota).toBeUndefined();
  });

  it('mode off clamps nothing for quota', () => {
    writeConfig('off');
    writeQuota(0.05, 0.05);

    const res = runTool({ tool: 'single', args: single, answers });

    expect(res.recommendedTier).toBe('pro');
  });
});

describe('isExplicitProOverride in the ceiling clamp (W-c)', () => {
  it('is the same function from governance and from antigravity/logic', () => {
    expect(fromAntigravityLogic).toBe(isExplicitProOverride);
  });

  it('keeps "use claude fable for this" exempt from the ceiling clamp', () => {
    expect(isExplicitProOverride('use claude fable for this', 'pro')).toBe(true);
    const res = clampTierToSessionCeiling('pro', 'gemini-2.5-flash', 'use claude fable for this');
    expect([res.wasClamped, res.clampedTier, res.ceilingTier]).toEqual([false, 'pro', 'flash']);
    expect(clampTierToSessionCeiling('pro', 'gemini-2.5-flash', 'use fable for this').wasClamped).toBe(false);
  });

  it('keeps explicit argon phrases exempt, and a bare "argon" is no longer an override', () => {
    for (const text of ['use gemini argon for this', 'launch an argon subagent for the review']) {
      expect(clampTierToSessionCeiling('pro', 'gemini-2.5-flash', text).wasClamped).toBe(false);
    }
    expect(clampTierToSessionCeiling('pro', 'gemini-2.5-flash', 'hash the password with argon2').wasClamped).toBe(true);
    expect(clampTierToSessionCeiling('pro', 'gemini-2.5-flash', 'hash it with argon').wasClamped).toBe(true);
  });

  it('a negated phrase is not an override', () => {
    expect(clampTierToSessionCeiling('pro', 'gemini-2.5-flash', "don't use claude fable here").wasClamped).toBe(true);
  });
});
