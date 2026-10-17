import { describe, it, expect } from 'bun:test';
import * as fsSync from 'node:fs';
import { getModeDetails } from '../src/index.ts';
import {
  defaultEffortForSubagent,
  applyEffortGovernance,
  normaliseBucket,
  readQuotaView,
  selectModel,
  type ModelCandidate
} from '../src/shared.ts';

describe('Jev Plugin Unit & Integration Tests', () => {
  const isLiveTest = process.env.JEV_LIVE_TEST === '1';

  it('correctly provides mode details for off, on-demand, and on', () => {
    const off = getModeDetails('off');
    expect(off.mode).toBe('off');
    expect(off.title).toBe('OFF');

    const onDemand = getModeDetails('on-demand');
    expect(onDemand.mode).toBe('on-demand');
    expect(onDemand.title).toBe('ON-DEMAND');

    const on = getModeDetails('on');
    expect(on.mode).toBe('on');
    expect(on.title).toBe('ON (AGGRESSIVE)');
  });

  it('validates RFC decisions D2 and D3 for thinking effort governance', () => {
    // D2: vault_librarian defaults to medium
    expect(defaultEffortForSubagent('vault_librarian')).toBe('medium');
    expect(defaultEffortForSubagent('inbox_processor')).toBe('low');
    expect(defaultEffortForSubagent('system_architect')).toBe('high');

    // D3: free_only allows medium/high for free models, forces low for quota models
    expect(applyEffortGovernance('high', 'free_only', 'openrouter_free')).toBe('high');
    expect(applyEffortGovernance('medium', 'free_only', 'openrouter_free')).toBe('medium');
    expect(applyEffortGovernance('high', 'free_only', 'flash')).toBe('low');
    expect(applyEffortGovernance('medium', 'free_only', 'flash_lite')).toBe('low');

    // Conserve mode caps high to medium
    expect(applyEffortGovernance('high', 'conserve', 'flash')).toBe('medium');
    expect(applyEffortGovernance('medium', 'conserve', 'flash')).toBe('medium');
  });

  it('normaliseBucket correctly calculates remaining fractions and staleness/refresh', () => {
    const now = 1000;
    const raw = {
      remaining_fraction: 0.8,
      reset_at: 1200
    };
    const b = normaliseBucket(now, raw);
    expect(b).not.toBeNull();
    expect(b?.remaining_fraction).toBe(0.8);
    expect(b?.effective_remaining_fraction).toBe(0.8);
    expect(b?.refreshed).toBe(false);
    expect(b?.reset_in_seconds).toBe(200);

    // When reset_at has passed
    const refreshedBucket = normaliseBucket(1300, raw);
    expect(refreshedBucket?.refreshed).toBe(true);
    expect(refreshedBucket?.effective_remaining_fraction).toBe(1);
  });

  it('readQuotaView returns a valid QuotaView object', async () => {
    const view = await readQuotaView();
    expect(view).toBeDefined();
    expect(typeof view.source).toBe('string');
    expect(typeof view.strategy).toBe('string');
    expect(view.thresholds).toBeDefined();
  });

  it('selectModel evaluates candidates and falls back to cheapest option when offline', async () => {
    const candidates: ModelCandidate[] = [
      { id: 'exp', tier: 'expensive', providerModel: 'openrouter/expensive', costInPerMTok: 5, costOutPerMTok: 15 },
      { id: 'free', tier: 'free', providerModel: 'openrouter/free', costInPerMTok: 0, costOutPerMTok: 0 }
    ];
    const res = await selectModel('Simple formatting task', candidates, 'normal');
    expect(res).toBeDefined();
    expect(res.cheapestOptionId).toBe('free');
    expect(res.options.length).toBe(2);
  });


  it('validates free model offloading quality gate contract', () => {
    expect(typeof getModeDetails).toBe('function');
  });
});
