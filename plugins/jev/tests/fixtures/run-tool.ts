/**
 * Runs one Jev tool handler by name in its own process with a stubbed Decisions API, so a test never touches the real
 * network, and (with HOME pointed at a temp directory by the caller) writes its telemetry line into that directory.
 * Input on stdin: { tool, args }. Prints the handler's text result.
 */
import { toolHandlers } from '../../src/tools/index.ts';

const { tool, args } = JSON.parse(await Bun.stdin.text());

globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const out: Record<string, unknown> = {};
  for (const [key, q] of Object.entries<any>(body.questions ?? {})) {
    out[key] = { choice: Object.keys(q.criteria ?? { x: 1 })[0], confidence: 0.9, probabilities: {} };
  }
  return new Response(JSON.stringify({ model: 'stub', answers: out, usage: { input_tokens: 1 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}) as typeof fetch;

const handler = (toolHandlers as Record<string, (a: unknown) => Promise<{ content: Array<{ text: string }> }>>)[tool];
const res = await handler(args);
process.stdout.write(res.content[0].text);
process.exit(0);
