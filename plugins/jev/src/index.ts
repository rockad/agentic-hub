#!/usr/bin/env bun
/**
 * TypeSafe Jev MCP Server
 * Lean bootstrap (<200 lines): connects the server built in src/server.ts to stdio. The modular tools are in
 * src/tools/, and every call is validated against the tool's strict input schema before its handler runs
 * (src/tools/validate.ts).
 *
 * Mode scheduling contract (implemented in src/tools/mode.ts):
 * When targetMode === 'off', setTimeout(() => execFile(JEV_MODE_BIN, ['off'], () => {}), 150);
 * timer.unref?.();
 * Returns: 'Jev mode set to OFF (MCP server disable scheduled in 150ms after response flush)'
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initTracing } from './tracing.js';
import { createJevServer } from './server.js';

// Re-export for backward compatibility with existing tests
export { getModeDetails, type ModeDetails } from './tools/mode.js';

void initTracing();

const server = createJevServer();
const transport = new StdioServerTransport();
await server.connect(transport);
