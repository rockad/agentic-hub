/**
 * Child process for tests/dir-lock-concurrency.test.ts. Waits for a shared start time so that several writers hit
 * the same state file at once, then does one write. Prints one line of JSON.
 *   bun tests/lock-writer.ts pending <sessionsDir> <sessionId> <n> <startAtMs>
 *   bun tests/lock-writer.ts guard   <sessionsDir> <sessionId> <n> <startAtMs>
 */
import { recordPendingServed } from '../antigravity/logic.ts';
import { evaluatePreToolGuards } from '../antigravity/guards.ts';

const [mode, sessionsDir, sessionId, nRaw, startRaw] = process.argv.slice(2);
const n = Number(nRaw);
const startAt = Number(startRaw);
while (Date.now() < startAt) {
  // spin: all writers leave the barrier together
}

if (mode === 'pending') {
  recordPendingServed(sessionsDir, sessionId, { stepIdx: n, requestedModel: 'flash', childConvId: null, createdAt: Date.now() });
  console.log(JSON.stringify({ n }));
} else {
  const res = await evaluatePreToolGuards({
    conversationId: sessionId,
    modelName: 'gemini-3.8-flash-low',
    toolCall: { name: 'edit_file', args: { Path: `src/file-${n}.ts` } }
  });
  console.log(JSON.stringify({ n, decision: res.decision }));
}
