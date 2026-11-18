import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { flushPendingServed, type PendingServedRecord } from '../antigravity/logic.ts';

const SESSION = '00000000-0000-4000-8000-000000000001';
const child = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const NOW = 1_700_000_000_000;

describe('flushPendingServed bounds', () => {
  let tmp = '';
  let sessionsDir = '';
  let file = '';
  let logged: Record<string, unknown>[] = [];
  const log = (e: Record<string, unknown>) => logged.push(e);

  const writeItems = (items: PendingServedRecord[]) => fs.writeFileSync(file, JSON.stringify(items) + '\n');
  const readItems = (): PendingServedRecord[] => JSON.parse(fs.readFileSync(file, 'utf8'));
  const item = (n: number, extra: Partial<PendingServedRecord> = {}): PendingServedRecord => ({
    requestedModel: 'flash',
    childConvId: child(n),
    createdAt: NOW - 1000 * (100 - n),
    ...extra
  });
  const flush = (clock?: () => number) => flushPendingServed(sessionsDir, SESSION, log, tmp, NOW, clock);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pending-'));
    sessionsDir = path.join(tmp, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    file = path.join(sessionsDir, `${SESSION}.pending-served.json`);
    logged = [];
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('counts a failed attempt on an unresolved item and keeps it', () => {
    writeItems([item(1)]);
    flush();
    expect(readItems()[0].attempts).toBe(1);
    expect(logged).toEqual([]);
  });

  it('drops an item at the attempt cap and logs it once as gave_up', () => {
    writeItems([item(1, { attempts: 9 })]);
    flush();
    expect(fs.existsSync(file)).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      event: 'subagent_served',
      harness: 'antigravity',
      child_conversation_id: child(1),
      requested_model: 'flash',
      served_model: null,
      backfill: 'gave_up'
    });
    flush();
    expect(logged).toHaveLength(1);
  });

  it('gives up after ten flushes in total', () => {
    writeItems([item(1)]);
    for (let i = 0; i < 9; i++) flush();
    expect(readItems()[0].attempts).toBe(9);
    expect(logged).toEqual([]);
    flush();
    expect(fs.existsSync(file)).toBe(false);
    expect(logged).toHaveLength(1);
  });

  it('examines at most three items per flush, oldest first, and keeps the rest untouched', () => {
    // Stored newest first, so only the sort puts the oldest at the front.
    writeItems([item(5), item(4), item(3), item(2), item(1)]);
    flush();
    const byChild = new Map(readItems().map((i) => [i.childConvId, i]));
    expect(byChild.size).toBe(5);
    for (const n of [1, 2, 3]) expect(byChild.get(child(n))?.attempts).toBe(1);
    for (const n of [4, 5]) expect(byChild.get(child(n))?.attempts).toBeUndefined();
  });

  it('stops starting items once the time budget is spent', () => {
    writeItems([item(1), item(2), item(3)]);
    let t = 0;
    // First call fixes the start; every later call is 250 ms on, past the 200 ms budget.
    const clock = () => (t++ === 0 ? 0 : 250);
    flush(clock);
    const attempts = readItems().map((i) => i.attempts);
    expect(attempts).toEqual([undefined, undefined, undefined]);
  });

  it('still resolves an item whose child has a model row and logs the served model', () => {
    const brain = path.join(tmp, '.gemini', 'antigravity-cli', 'brain', child(1));
    fs.mkdirSync(brain, { recursive: true });
    fs.writeFileSync(path.join(brain, 'transcript.jsonl'), JSON.stringify({ model: 'flash-x' }) + '\n');
    writeItems([item(1)]);
    flush();
    expect(fs.existsSync(file)).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ served_model: 'flash-x', backfilled: true });
  });

  it('drops expired items silently', () => {
    writeItems([item(1, { createdAt: NOW - 2 * 3600 * 1000 })]);
    flush();
    expect(fs.existsSync(file)).toBe(false);
    expect(logged).toEqual([]);
  });
});
