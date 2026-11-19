import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initTracingSync, resetTracerForTesting, jevVersion } from '../src/tracing.ts';

const pkgVersion: string = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'package.json'), 'utf8')).version;

describe('tracing reports the real plugin version', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetTracerForTesting();
  });

  it('jevVersion() is the package.json version', () => {
    expect(jevVersion()).toBe(pkgVersion);
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the OTLP scope version is the package.json version, not a hard-coded one', async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const tracer = initTracingSync({ enabled: true, endpoint: 'http://127.0.0.1:4318', serviceName: 'jev-version-test' });
    tracer.startSpan('jev.probe').end();
    // The exporter posts without blocking: give the microtask queue a turn.
    await new Promise((r) => setTimeout(r, 20));
    expect(bodies.length).toBeGreaterThan(0);
    const scope = JSON.parse(bodies[0]).resourceSpans[0].scopeSpans[0].scope;
    expect(scope.version).toBe(pkgVersion);
    expect(bodies[0]).not.toContain('2.3.15');
  });
});
