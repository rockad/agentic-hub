/**
 * The per-turn pending-call store behind the late `agent_call_recommendation` row: bounded, expiring, one turn at a
 * time, written under the turn dir-lock. Hermetic: a temp directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  turnId,
  writeAntigravityTurn,
  claimTurnRecommendation,
  commitAntigravityTurn,
  PENDING_RECOMMENDATION_MAX_CALLS,
  type PendingRecommendationCall
} from '../antigravity/logic.ts';

const CONV = 'conv-late-rec';
const TURN = turnId('tidy up the synthetic notes folder please');
let dir = '';
const sessions = () => dir;
const pendingFile = () => path.join(dir, `${CONV}.turn-pending.json`);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pending-rec-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('pending-call store (turn-pending.json)', () => {
  const pc = (n: number, extra: Partial<PendingRecommendationCall> = {}): PendingRecommendationCall => ({
    callKey: `k${n}`,
    at: Date.now(),
    decision: 'pass',
    requestedModel: null,
    toolName: 'invoke_subagent',
    sessionModel: null,
    sessionModelSource: null,
    ...extra
  });

  it('is bounded: only the newest calls are kept', () => {
    for (let i = 0; i < PENDING_RECOMMENDATION_MAX_CALLS + 10; i++) {
      claimTurnRecommendation(sessions(), CONV, TURN, pc(i));
    }
    const stored = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
    expect(stored.turn).toBe(TURN);
    expect(stored.calls.length).toBe(PENDING_RECOMMENDATION_MAX_CALLS);
    expect(stored.calls.at(-1).callKey).toBe(`k${PENDING_RECOMMENDATION_MAX_CALLS + 9}`);
  });

  it('a stale call (older than the TTL) is dropped, a different turn replaces the list', () => {
    claimTurnRecommendation(sessions(), CONV, TURN, pc(1, { at: Date.now() - 3_600_000 }));
    claimTurnRecommendation(sessions(), CONV, TURN, pc(2));
    expect(JSON.parse(fs.readFileSync(pendingFile(), 'utf8')).calls.map((c: any) => c.callKey)).toEqual(['k2']);
    claimTurnRecommendation(sessions(), CONV, 'other-turn', pc(3));
    const stored = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
    expect(stored.turn).toBe('other-turn');
    expect(stored.calls.map((c: any) => c.callKey)).toEqual(['k3']);
  });

  it('claim returns the recommendation when the state already holds it, and records nothing', () => {
    writeAntigravityTurn(sessions(), CONV, { turn: TURN, recommendedTier: 'pro', at: '' });
    const res = claimTurnRecommendation(sessions(), CONV, TURN, pc(1));
    expect(res.turnState?.recommendedTier).toBe('pro');
    expect(res.recorded).toBe(false);
    expect(fs.existsSync(pendingFile())).toBe(false);
  });

  it('commit writes the state and hands back (and clears) the pending calls of that turn only', () => {
    claimTurnRecommendation(sessions(), CONV, TURN, pc(1));
    const taken = commitAntigravityTurn(sessions(), CONV, { turn: TURN, recommendedTier: 'flash', at: '' });
    expect(taken.map((c) => c.callKey)).toEqual(['k1']);
    expect(fs.existsSync(pendingFile())).toBe(false);

    claimTurnRecommendation(sessions(), CONV, TURN, pc(2));
    const none = commitAntigravityTurn(sessions(), CONV, { turn: 'different', recommendedTier: 'flash', at: '' });
    expect(none).toEqual([]);
  });
});
