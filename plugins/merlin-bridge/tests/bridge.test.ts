import { describe, it, expect, beforeAll } from 'bun:test';

const PORT = Number(process.env.MERLIN_BRIDGE_PORT || 4340);
const BASE_URL = `http://127.0.0.1:${PORT}`;

describe('Merlin Bridge Service', () => {
  beforeAll(async () => {
    // Verify server is listening or give a grace period
    for (let i = 0; i < 5; i++) {
      try {
        const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok || res.status === 503) return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  });

  describe('Health Check Endpoint (/health)', () => {
    it('returns a valid JSON response with HTTP 200 or 503', async () => {
      const res = await fetch(`${BASE_URL}/health`);
      expect([200, 503]).toContain(res.status);

      const contentType = res.headers.get('content-type') || '';
      expect(contentType).toContain('application/json');

      const data = await res.json();
      expect(typeof data).toBe('object');
      expect(data).toHaveProperty('status');
      expect(['ok', 'degraded', 'offline']).toContain(data.status);
      expect(data).toHaveProperty('chromePort');
      expect(typeof data.chromePort).toBe('number');
      expect(data).toHaveProperty('cdpConnected');
      expect(typeof data.cdpConnected).toBe('boolean');
    });

    it('also responds identically on /ready', async () => {
      const res = await fetch(`${BASE_URL}/ready`);
      expect([200, 503]).toContain(res.status);
      const data = await res.json();
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('cdpConnected');
    });
  });

  describe('Status Endpoint Parsing (/status)', () => {
    it('returns and correctly parses the complete bridge status schema', async () => {
      const res = await fetch(`${BASE_URL}/status`);
      expect([200, 503]).toContain(res.status);

      const data = await res.json();
      expect(typeof data).toBe('object');
      expect(data).toBeDefined();

      // Verify all required status schema fields
      expect(data).toHaveProperty('status');
      expect(['ok', 'degraded', 'offline']).toContain(data.status);

      expect(data).toHaveProperty('chromePort');
      expect(typeof data.chromePort).toBe('number');

      expect(data).toHaveProperty('cdpConnected');
      expect(typeof data.cdpConnected).toBe('boolean');

      expect(data).toHaveProperty('merlinTargetFound');
      expect(typeof data.merlinTargetFound).toBe('boolean');

      expect(data).toHaveProperty('uptimeSeconds');
      expect(typeof data.uptimeSeconds).toBe('number');
      expect(data.uptimeSeconds).toBeGreaterThanOrEqual(0);

      // Target information if connected
      if (data.merlinTargetFound) {
        expect(typeof data.targetId).toBe('string');
        expect(typeof data.targetUrl).toBe('string');
        expect(data.targetUrl).toContain('getmerlin.in');
      }
    });
  });

  describe('Models Endpoint (/v1/models)', () => {
    it('returns list of models in OpenAI format', async () => {
      const res = await fetch(`${BASE_URL}/v1/models`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.object).toBe('list');
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
      expect(data.data[0]).toHaveProperty('id');
      expect(data.data[0]).toHaveProperty('owned_by');
    });
  });

  describe('Error Handling', () => {
    it('returns 404 for unknown endpoints', async () => {
      const res = await fetch(`${BASE_URL}/unknown_path`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(404);
    });

    it('returns 400 for completions without messages', async () => {
      const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] })
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(400);
    });
  });
});
