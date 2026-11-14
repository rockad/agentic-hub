/**
 * The Jev MCP server, built but not connected: src/index.ts connects it to stdio; tests connect it to an
 * in-memory transport.
 *
 * It stays on the SDK's low-level `Server`. Every call is checked by `validateToolInput` (tools/validate.ts)
 * before its handler runs; a call that does not match the tool's strict input schema returns an `isError` result
 * and the handler never sees it. An unknown tool name is still a thrown "Unknown tool" error.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { allTools, toolHandlers } from './tools/index.js';
import { validateToolInput } from './tools/validate.js';

export function createJevServer(): Server {
  const server = new Server(
    { name: 'jev', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = toolHandlers[name];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const checked = validateToolInput(name, args);
    if (!checked.ok) return checked.result;
    return await handler(checked.data);
  });

  return server;
}
