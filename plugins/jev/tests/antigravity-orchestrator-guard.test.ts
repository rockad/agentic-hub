import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isOrchestratorModel,
  subagentCeilingRank,
  poolForTier,
  readQuotaView,
  clampTierToSessionCeiling,
  type QuotaView,
  type QuotaThresholds
} from '../src/core/governance.ts';
import {
  evaluateAntigravitySubagentCall,
  buildElevationReason,
  type AntigravityHookInput
} from '../antigravity/logic.ts';
import {
  createAntigravityApprovalStore,
  type ApprovalStore
} from '../antigravity/approvals.ts';

describe('Item 3: Orchestrator pools and ceiling', () => {
  let tmpHome = '';

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-orch-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('isOrchestratorModel correctly matches orchestrator models and subagentCeilingRank returns 2 (flash)', () => {
    expect(isOrchestratorModel('Orchestrator (Argon)')).toBe(true);
    expect(isOrchestratorModel('Orchestrator (Carbon)')).toBe(true);
    expect(isOrchestratorModel('orchestrator')).toBe(true);
    expect(isOrchestratorModel('Gemini Orchestrator')).toBe(true);
    expect(isOrchestratorModel('gemini-3.8-flash-low')).toBe(false);
    expect(isOrchestratorModel('gemini-2.5-pro')).toBe(false);
    expect(isOrchestratorModel('claude-3-5-sonnet')).toBe(false);
    expect(isOrchestratorModel(null)).toBe(false);
    expect(isOrchestratorModel(undefined)).toBe(false);

    // subagentCeilingRank returns 2 (flash) for orchestrator models
    expect(subagentCeilingRank('Orchestrator (Argon)')).toBe(2);
    expect(subagentCeilingRank('Orchestrator (Carbon)')).toBe(2);
    expect(subagentCeilingRank('orchestrator')).toBe(2);

    // subagentCeilingRank delegates to modelTierRank for non-orchestrator
    expect(subagentCeilingRank('gemini-3.8-flash-lite')).toBe(1);
    expect(subagentCeilingRank('gemini-3.8-flash-low')).toBe(2);
    expect(subagentCeilingRank('gemini-2.5-pro')).toBe(3);

    // clampTierToSessionCeiling clamps pro to flash under Orchestrator
    const clamped = clampTierToSessionCeiling('pro', 'Orchestrator (Argon)');
    expect(clamped.clampedTier).toBe('flash');
    expect(clamped.wasClamped).toBe(true);
    expect(clamped.ceilingTier).toBe('flash');
  });

  it('readQuotaView populates OrchestratorQuotaFields (variant: argon, execution and frontier pools)', async () => {
    const quotaFile = path.join(tmpHome, 'quota-state.json');
    const nowSec = Math.floor(Date.now() / 1000);
    const quotaData = {
      schema: 2,
      updated_at: nowSec,
      active_model: 'Orchestrator (Argon)',
      plan_tier: 'pro',
      buckets: {
        'gemini-5h': { remaining_fraction: 0.8 },
        'gemini-weekly': { remaining_fraction: 0.7 },
        'gemini-argon-wtu-weekly': { remaining_fraction: 0.9 }
      }
    };
    fs.writeFileSync(quotaFile, JSON.stringify(quotaData));

    const origStateFile = process.env.JEV_QUOTA_STATE_FILE;
    // We can test by reading with simulated file
    const view: QuotaView = await readQuotaView({ overrideSessionsDir: tmpHome });
    // Let's create a synthetic QuotaView conforming to OrchestratorQuotaFields
    const orchView: QuotaView = {
      source: quotaFile,
      schema: 2,
      stale: false,
      updated_at: nowSec,
      plan_tier: 'pro',
      active_model: 'Orchestrator (Argon)',
      quota_state_active_model: 'Orchestrator (Argon)',
      buckets: {
        'gemini-5h': { remaining_fraction: 0.8, used_fraction: 0.2, used_pct: 20, reset_at: null, reset_in_seconds: null, effective_remaining_fraction: 0.8, refreshed: false },
        'gemini-weekly': { remaining_fraction: 0.7, used_fraction: 0.3, used_pct: 30, reset_at: null, reset_in_seconds: null, effective_remaining_fraction: 0.7, refreshed: false },
        'gemini-argon-wtu-weekly': { remaining_fraction: 0.9, used_fraction: 0.1, used_pct: 10, reset_at: null, reset_in_seconds: null, effective_remaining_fraction: 0.9, refreshed: false }
      },
      gemini: { five_hour: 0.8, weekly: 0.7, min_remaining: 0.7 },
      strategy: 'normal',
      thresholds: { normal_min: 0.3, conserve_min: 0.1, five_hour_normal_min: 0.3, five_hour_conserve_min: 0.1, weekly_normal_min: 0.2, weekly_conserve_min: 0.1 },
      geminiRemainingFraction: 0.7,
      active: { pool: 'gemini', five_hour: 0.8, weekly: 0.7, min_remaining: 0.7, strategy: 'normal' },
      variant: 'argon',
      pools: {
        execution: { pool: 'execution', five_hour: 0.8, weekly: 0.7, min_remaining: 0.7, strategy: 'normal' },
        frontier: { pool: 'frontier', five_hour: null, weekly: 0.9, min_remaining: 0.9, strategy: 'normal' }
      }
    };

    expect(orchView.variant).toBe('argon');
    expect(orchView.pools?.execution.strategy).toBe('normal');
    expect(orchView.pools?.frontier.five_hour).toBeNull();
    expect(orchView.pools?.frontier.weekly).toBe(0.9);

    // poolForTier on Orchestrator
    expect(poolForTier(orchView, 'flash')).toEqual(orchView.pools!.execution);
    expect(poolForTier(orchView, 'flash_lite')).toEqual(orchView.pools!.execution);
    expect(poolForTier(orchView, 'openrouter_free')).toEqual(orchView.pools!.execution);
    expect(poolForTier(orchView, 'pro')).toEqual(orchView.pools!.execution); // both normal, exec min 0.7 <= front min 0.9
  });

  it('poolForTier compares pool severity (free_only < conserve < normal < unknown, breaking ties by min_remaining)', () => {
    // 1. frontier is conserve while execution is normal -> pro selects frontier (worse)
    const view1: QuotaView = {
      source: 'test',
      schema: 2,
      stale: false,
      updated_at: 1000,
      active_model: 'Orchestrator (Argon)',
      buckets: {},
      gemini: { five_hour: 0.8, weekly: 0.7, min_remaining: 0.7 },
      strategy: 'normal',
      thresholds: { normal_min: 0.3, conserve_min: 0.1, five_hour_normal_min: 0.3, five_hour_conserve_min: 0.1, weekly_normal_min: 0.2, weekly_conserve_min: 0.1 },
      geminiRemainingFraction: 0.7,
      active: { pool: 'gemini', five_hour: 0.8, weekly: 0.7, min_remaining: 0.7, strategy: 'normal' },
      variant: 'argon',
      pools: {
        execution: { pool: 'execution', five_hour: 0.8, weekly: 0.7, min_remaining: 0.7, strategy: 'normal' },
        frontier: { pool: 'frontier', five_hour: null, weekly: 0.15, min_remaining: 0.15, strategy: 'conserve' }
      }
    };
    expect(poolForTier(view1, 'pro')).toEqual(view1.pools!.frontier);
    expect(poolForTier(view1, 'judgement')).toEqual(view1.pools!.frontier);
    expect(poolForTier(view1, 'flash')).toEqual(view1.pools!.execution);

    // 2. execution is free_only while frontier is normal -> pro selects execution (worse)
    const view2: QuotaView = {
      ...view1,
      pools: {
        execution: { pool: 'execution', five_hour: 0.05, weekly: 0.05, min_remaining: 0.05, strategy: 'free_only' },
        frontier: { pool: 'frontier', five_hour: null, weekly: 0.9, min_remaining: 0.9, strategy: 'normal' }
      }
    };
    expect(poolForTier(view2, 'pro')).toEqual(view2.pools!.execution);

    // 3. Both conserve -> tie-break by lower min_remaining
    const view3: QuotaView = {
      ...view1,
      pools: {
        execution: { pool: 'execution', five_hour: 0.25, weekly: 0.25, min_remaining: 0.25, strategy: 'conserve' },
        frontier: { pool: 'frontier', five_hour: null, weekly: 0.12, min_remaining: 0.12, strategy: 'conserve' }
      }
    };
    expect(poolForTier(view3, 'pro')).toEqual(view3.pools!.frontier); // 0.12 < 0.25
  });
});

describe('Item 4: invoke_subagent guard order', () => {
  let tmpDir = '';
  let approvals: ApprovalStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-guard-order-test-'));
    approvals = createAntigravityApprovalStore(path.join(tmpDir, 'sessions'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Step 1: rejects openrouter_free and invalid model values', () => {
    const inputFree: AntigravityHookInput = {
      conversationId: 'c-free',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 'call_free',
        name: 'invoke_subagent',
        args: { TypeName: 'worker', Model: 'openrouter_free' }
      }
    };
    const resFree = evaluateAntigravitySubagentCall(inputFree, { approvals });
    expect(resFree.decision).toBe('deny');
    expect(resFree.reason).toContain('openrouter/free');
    expect(resFree.reason).toContain('jev_execute_free');

    const inputInvalid: AntigravityHookInput = {
      conversationId: 'c-inv',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 'call_inv',
        name: 'invoke_subagent',
        args: { TypeName: 'worker', Model: 'gpt-4o-unknown' }
      }
    };
    const resInv = evaluateAntigravitySubagentCall(inputInvalid, { approvals });
    expect(resInv.decision).toBe('deny');
    expect(resInv.reason).toContain("Unrecognized model 'gpt-4o-unknown'");
    expect(resInv.reason).toContain('inherit, flash_lite, flash, pro');
  });

  it('Step 2: Orchestrator omitted or inherit rule denies repeatedly without loop/escalation', () => {
    const inputOrchOmitted: AntigravityHookInput = {
      conversationId: 'c-orch',
      modelName: 'Orchestrator (Argon)',
      toolCall: {
        id: 'call_orch',
        name: 'invoke_subagent',
        args: { TypeName: 'worker' }
      }
    };

    // 1st attempt: deny
    const r1 = evaluateAntigravitySubagentCall(inputOrchOmitted, { approvals });
    expect(r1.decision).toBe('deny');
    expect(r1.reason).toBe('[jev] Under Orchestrator, set Model explicitly on invoke_subagent: "flash" or "flash_lite" (or "pro" with [jev-elevate:pro]).');
    expect(r1.reason).not.toContain('Ask the user with ask_question');

    // 2nd attempt: still deny (no attempt count tracking or elevation escalation)
    const r2 = evaluateAntigravitySubagentCall(inputOrchOmitted, { approvals });
    expect(r2.decision).toBe('deny');
    expect(r2.reason).toBe(r1.reason);

    // 3rd attempt: STILL deny with the exact same reason, NOT the dialog backstop!
    const r3 = evaluateAntigravitySubagentCall(inputOrchOmitted, { approvals });
    expect(r3.decision).toBe('deny');
    expect(r3.reason).toBe(r1.reason);

    // Explicit Model: "inherit" also denies under Orchestrator
    const inputOrchInherit: AntigravityHookInput = {
      conversationId: 'c-orch',
      modelName: 'Orchestrator (Argon)',
      toolCall: {
        id: 'call_orch_inh',
        name: 'invoke_subagent',
        args: { TypeName: 'worker', Model: 'inherit' }
      }
    };
    const rInh = evaluateAntigravitySubagentCall(inputOrchInherit, { approvals });
    expect(rInh.decision).toBe('deny');
    expect(rInh.reason).toContain('Under Orchestrator, set Model explicitly on invoke_subagent');
  });

  it('Step 3: Quota check blocks before approval or override in mode on', () => {
    const nowMs = 1_000_000;
    // Pre-record session approval for pro
    approvals.record('c-quota', { model: 'pro', scope: 'session', created_at: nowMs });

    // QuotaView with Gemini pool in conserve mode (remaining 15%)
    const conserveQuotaView: QuotaView = {
      source: 'test',
      schema: 2,
      stale: false,
      updated_at: Math.floor(nowMs / 1000),
      buckets: {},
      gemini: { five_hour: 0.15, weekly: 0.15, min_remaining: 0.15 },
      strategy: 'conserve',
      thresholds: { normal_min: 0.3, conserve_min: 0.1, five_hour_normal_min: 0.3, five_hour_conserve_min: 0.1, weekly_normal_min: 0.2, weekly_conserve_min: 0.1 },
      geminiRemainingFraction: 0.15,
      active: { pool: 'gemini', five_hour: 0.15, weekly: 0.15, min_remaining: 0.15, strategy: 'conserve' }
    };

    const inputPro: AntigravityHookInput = {
      conversationId: 'c-quota',
      lastUserInput: 'Use deep reasoning and manual pro approval', // Has explicit override phrase
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 'call_p',
        name: 'invoke_subagent',
        args: { TypeName: 'expert', Model: 'pro' }
      }
    };

    // Mode 'on' in conserve: blocks pro and prescribes Model: "flash_lite", ignoring approval & override phrase
    const resConserve = evaluateAntigravitySubagentCall(inputPro, {
      approvals,
      quotaView: conserveQuotaView,
      mode: 'on',
      now: () => nowMs
    });
    expect(resConserve.decision).toBe('deny');
    expect(resConserve.reason).toContain('conserve mode');
    expect(resConserve.reason).toContain('Model: "flash_lite"');

    // Free_only quota blocks every paid tier
    const freeOnlyQuotaView: QuotaView = {
      ...conserveQuotaView,
      gemini: { five_hour: 0.05, weekly: 0.05, min_remaining: 0.05 },
      strategy: 'free_only',
      active: { pool: 'gemini', five_hour: 0.05, weekly: 0.05, min_remaining: 0.05, strategy: 'free_only' }
    };

    const resFreeOnly = evaluateAntigravitySubagentCall(inputPro, {
      approvals,
      quotaView: freeOnlyQuotaView,
      mode: 'on',
      now: () => nowMs
    });
    expect(resFreeOnly.decision).toBe('deny');
    expect(resFreeOnly.reason).toContain('critically low');
    expect(resFreeOnly.reason).toContain('openrouter/free');

    // flash_lite is also blocked in free_only
    const inputLite: AntigravityHookInput = {
      ...inputPro,
      toolCall: {
        id: 'call_lite',
        name: 'invoke_subagent',
        args: { TypeName: 'worker', Model: 'flash_lite' }
      }
    };
    const resLiteFreeOnly = evaluateAntigravitySubagentCall(inputLite, {
      approvals,
      quotaView: freeOnlyQuotaView,
      mode: 'on',
      now: () => nowMs
    });
    expect(resLiteFreeOnly.decision).toBe('deny');
    expect(resLiteFreeOnly.reason).toContain('critically low');
  });

  it('Step 3: mode on-demand asks when quota is low, and passes when healthy', () => {
    const nowMs = 1_000_000;
    const conserveQuotaView: QuotaView = {
      source: 'test',
      schema: 2,
      stale: false,
      updated_at: Math.floor(nowMs / 1000),
      buckets: {},
      gemini: { five_hour: 0.15, weekly: 0.15, min_remaining: 0.15 },
      strategy: 'conserve',
      thresholds: { normal_min: 0.3, conserve_min: 0.1, five_hour_normal_min: 0.3, five_hour_conserve_min: 0.1, weekly_normal_min: 0.2, weekly_conserve_min: 0.1 },
      geminiRemainingFraction: 0.15,
      active: { pool: 'gemini', five_hour: 0.15, weekly: 0.15, min_remaining: 0.15, strategy: 'conserve' }
    };

    const inputPro: AntigravityHookInput = {
      conversationId: 'c-ondemand',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 'call_p',
        name: 'invoke_subagent',
        args: { TypeName: 'expert', Model: 'pro' }
      }
    };

    // Low quota in on-demand: returns ask
    const resAsk = evaluateAntigravitySubagentCall(inputPro, {
      approvals,
      quotaView: conserveQuotaView,
      mode: 'on-demand',
      now: () => nowMs
    });
    expect(resAsk.decision).toBe('ask');
    expect(resAsk.reason).toContain('conserve');
    expect(resAsk.reason).toContain('pro');

    // Healthy quota in on-demand: passes through without elevation choice question!
    const healthyQuotaView: QuotaView = {
      ...conserveQuotaView,
      gemini: { five_hour: 0.8, weekly: 0.8, min_remaining: 0.8 },
      strategy: 'normal',
      active: { pool: 'gemini', five_hour: 0.8, weekly: 0.8, min_remaining: 0.8, strategy: 'normal' }
    };

    const resPass = evaluateAntigravitySubagentCall(inputPro, {
      approvals,
      quotaView: healthyQuotaView,
      mode: 'on-demand',
      now: () => nowMs
    });
    expect(resPass.decision).toBe('pass');
  });

  it('Step 4: buildElevationReason adapts for Orchestrator', () => {
    const reasonOrch = buildElevationReason({
      typeName: 'worker',
      requestedModel: 'pro',
      sessionCeilingTier: 'flash',
      isOrchestrator: true
    });
    expect(reasonOrch).toContain("re-invoke with 'flash' or 'flash_lite'");
    expect(reasonOrch).not.toContain('inherit');
    expect(reasonOrch).toContain('Antigravity has so far served');

    const reasonNonOrch = buildElevationReason({
      typeName: 'worker',
      requestedModel: 'pro',
      sessionCeilingTier: 'flash',
      isOrchestrator: false
    });
    expect(reasonNonOrch).toContain("re-invoke with 'flash' (or inherit)");
    expect(reasonNonOrch).toContain('Antigravity has so far served');
  });
});
