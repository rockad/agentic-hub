/**
 * Core parity (W-d): every logTelemetry() line carries an integer `epoch` beside the ISO timestamp, and jev_dispatch,
 * jev_batch_dispatch, jev_quota and jev_select_model take an optional `conversationId` that is recorded, sanitized, as
 * `sessionId` (null when omitted). The handlers run in their own process with HOME pointed at a temp directory, because
 * the telemetry path is fixed from os.homedir() when the module loads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateToolInput } from '../src/tools/validate.ts';

const SRC = path.join(import.meta.dir, '..', 'src');
const RUNNER = path.join(import.meta.dir, 'fixtures', 'run-tool.ts');

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-convid-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const telemetryFile = () => path.join(home, '.gemini', 'antigravity-cli', 'jev_telemetry.jsonl');

function env(): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/KEY|TOKEN|SECRET|^JEV_|^CLAUDE|ANTIGRAVITY|GEMINI|OPENCODE|CORTEX/.test(k)) clean[k] = v;
  return {
    ...clean,
    HOME: home,
    JEV_HARNESS: 'cli',
    JEV_CONFIG_FILE: path.join(home, 'config.json'),
    JEV_CACHE_FILE: path.join(home, 'cache.sqlite'),
    JEV_OPENROUTER_API_KEY: 'test-key'
  };
}

function lines(): Array<Record<string, any>> {
  if (!fs.existsSync(telemetryFile())) return [];
  return fs.readFileSync(telemetryFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runTool(tool: string, args: Record<string, unknown>): Record<string, any> {
  const proc = Bun.spawnSync(['bun', RUNNER], { env: env(), stdin: new TextEncoder().encode(JSON.stringify({ tool, args })) });
  if (proc.exitCode !== 0) throw new Error(`${tool} failed: ${proc.stderr.toString()}`);
  const mine = lines().filter((l) => l.tool === tool);
  expect(mine).toHaveLength(1);
  return mine[0];
}

const ARGS: Record<string, Record<string, unknown>> = {
  jev_dispatch: { task: 'summarise the changelog' },
  jev_batch_dispatch: { tasks: [{ id: 'a', task: 'summarise the changelog' }] },
  jev_quota: {},
  jev_select_model: { task: 'summarise the changelog' }
};
const TOOLS = Object.keys(ARGS);

describe('telemetry epoch', () => {
  it('puts an integer Unix-seconds epoch beside the ISO timestamp in every logTelemetry line', () => {
    const before = Math.floor(Date.now() / 1000);
    const proc = Bun.spawnSync(
      ['bun', '-e', `import { logTelemetry } from '${SRC}/core/telemetry.ts'; await logTelemetry({ tool: 'jev_probe' });`],
      { env: env() }
    );
    expect(proc.exitCode).toBe(0);
    const [line] = lines();
    expect(Number.isInteger(line.epoch)).toBe(true);
    expect(line.epoch).toBeGreaterThanOrEqual(before);
    expect(line.epoch).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(Math.floor(Date.parse(line.timestamp) / 1000)).toBeGreaterThanOrEqual(line.epoch - 1);
    expect(Math.floor(Date.parse(line.timestamp) / 1000)).toBeLessThanOrEqual(line.epoch + 1);
  });

  it.each(TOOLS)('%s writes a numeric epoch', (tool) => {
    expect(typeof runTool(tool, ARGS[tool]).epoch).toBe('number');
  });
});

describe('conversationId argument', () => {
  it.each(TOOLS)('%s accepts conversationId at validation', (tool) => {
    const args = { ...ARGS[tool], conversationId: 'conv-1' };
    const v = validateToolInput(tool, args);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.data).toEqual(args);
  });

  it.each(TOOLS)('%s rejects a non-string conversationId', (tool) => {
    for (const bad of [42, true, { id: 'x' }, ['x']]) {
      const v = validateToolInput(tool, { ...ARGS[tool], conversationId: bad });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.result.content[0].text).toContain('at conversationId');
    }
  });

  it.each(TOOLS)('%s logs the conversationId as sessionId', (tool) => {
    expect(runTool(tool, { ...ARGS[tool], conversationId: 'conv-abc_123' }).sessionId).toBe('conv-abc_123');
  });

  it.each(TOOLS)('%s sanitizes a hostile conversationId before logging it', (tool) => {
    const line = runTool(tool, { ...ARGS[tool], conversationId: '../../x' });
    expect(line.sessionId).toBe('x');
    expect(JSON.stringify(line)).not.toContain('..');
  });

  it.each(TOOLS)('%s logs a null sessionId when nothing safe is left', (tool) => {
    expect(runTool(tool, { ...ARGS[tool], conversationId: '../..' }).sessionId).toBeNull();
  });

  it.each(TOOLS)('%s logs a null sessionId when conversationId is omitted', (tool) => {
    const line = runTool(tool, ARGS[tool]);
    expect('sessionId' in line).toBe(true);
    expect(line.sessionId).toBeNull();
  });
});
