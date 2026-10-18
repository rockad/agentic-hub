#!/usr/bin/env bun
/**
 * TypeSafe Jev MCP Server
 * Lean bootstrap (<200 lines) registering modular tools from src/tools/
 *
 * Mode scheduling contract (implemented in src/tools/mode.ts):
 * When targetMode === 'off', setTimeout(() => execFile(JEV_MODE_BIN, ['off'], () => {}), 150);
 * timer.unref?.();
 * Returns: 'Jev mode set to OFF (MCP server disable scheduled in 150ms after response flush)'
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initTracing } from './tracing.js';
import { allTools, toolHandlers } from './tools/index.js';

// Re-export for backward compatibility with existing tests
export { getModeDetails, type ModeDetails } from './tools/mode.js';

void initTracing();

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
  return await handler(args);
});

const transport = new StdioServerTransport();
await server.connect(transport);
