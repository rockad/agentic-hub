import { describe, expect, test } from 'bun:test';
import { evaluateDrift, type DriftEvent } from '../src/audit/drift-detector.js';
import { readQuotaView, discoverWorkspaceAgents } from '../src/shared.js';

describe('Stage 2: Dynamic Workspace Subagent Discovery', () => {
  test('discovers all workspace agents dynamically from .agents/agents or .agents/subagents', async () => {
    const agents = await discoverWorkspaceAgents();
    expect(agents).toBeDefined();
    expect(typeof agents).toBe('object');
    expect(agents.self).toBeDefined();
    expect(agents.none).toBeDefined();

    // In doppelganger, should find the core agents
    const keys = Object.keys(agents);
    expect(keys.length).toBeGreaterThanOrEqual(4);
  });

  test('returns cached agents map within 15s TTL', async () => {
    const t0 = performance.now();
    const agents1 = await discoverWorkspaceAgents();
    const t1 = performance.now();
    const agents2 = await discoverWorkspaceAgents();
    const t2 = performance.now();

    expect(agents1).toEqual(agents2);
    // Cached call should be faster than initial discovery
    expect(t2 - t1).toBeLessThanOrEqual(t1 - t0 + 5);
  });
});

describe('Stage 3: Drift Detection & Compliance Engine', () => {
  test('flags free tier leakage when task is openrouter_free but paid subagent was called', () => {
    const telemetry = [
      {
        timestamp: '2026-10-17T12:00:00.000Z',
        tool: 'jev_dispatch',
        recommendedTier: 'openrouter_free',
        sessionId: 'session-123'
      }
    ];

    const invocations = [
      {
        timestamp: '2026-10-17T12:01:00.000Z',
        sessionId: 'session-123',
        toolName: 'invoke_subagent',
        model: 'flash',
        role: 'code_engineer'
      }
    ];

    const report = evaluateDrift(telemetry, invocations);
    expect(report.totalDispatches).toBe(1);
    expect(report.totalViolations).toBe(1);
    expect(report.complianceRate).toBe(0);
    expect(report.violationsByType.free_tier_leakage).toBe(1);
    expect(report.events[0].type).toBe('free_tier_leakage');
  });

  test('flags unapproved pro usage when model is pro without user confirmation', () => {
    const telemetry = [
      {
        timestamp: '2026-10-17T12:00:00.000Z',
        tool: 'jev_dispatch',
        recommendedTier: 'pro',
        sessionId: 'session-456'
      }
    ];

    const invocations = [
      {
        timestamp: '2026-10-17T12:00:30.000Z',
        sessionId: 'session-456',
        toolName: 'invoke_subagent',
        model: 'pro',
        userApproved: false
      }
    ];

    const report = evaluateDrift(telemetry, invocations);
    expect(report.totalViolations).toBe(1);
    expect(report.violationsByType.unapproved_pro).toBe(1);
    expect(report.events[0].severity).toBe('critical');
  });

  test('flags invalid model enums passed to invoke_subagent', () => {
    const invocations = [
      {
        timestamp: '2026-10-17T12:00:00.000Z',
        sessionId: 'session-789',
        toolName: 'invoke_subagent',
        model: 'openrouter_free'
      }
    ];

    const report = evaluateDrift([], invocations);
    expect(report.violationsByType.enum_mismatch).toBe(1);
    expect(report.events[0].details).toContain('invalid Model enum');
  });

  test('computes 100% compliance when all executions match recommendations', () => {
    const telemetry = [
      {
        timestamp: '2026-10-17T12:00:00.000Z',
        tool: 'jev_dispatch',
        recommendedTier: 'flash',
        sessionId: 'session-100'
      }
    ];

    const invocations = [
      {
        timestamp: '2026-10-17T12:01:00.000Z',
        sessionId: 'session-100',
        toolName: 'invoke_subagent',
        model: 'flash',
        role: 'code_engineer'
      }
    ];

    const report = evaluateDrift(telemetry, invocations);
    expect(report.totalDispatches).toBe(1);
    expect(report.totalViolations).toBe(0);
    expect(report.complianceRate).toBe(100.0);
  });
});
