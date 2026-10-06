#!/usr/bin/env bun
/**
 * Merlin Bridge MCP Server
 * Exposes in-browser Merlin generation tools to Antigravity and OpenCode
 */
import * as readline from 'node:readline';

const BRIDGE_URL = process.env.MERLIN_BRIDGE_URL || 'http://127.0.0.1:4340';

const TOOLS = [
  {
    name: 'merlin_complete',
    description: 'Offload text, boilerplate, summaries, or review generation to in-browser Merlin Pro at $0 cost and 0 Gemini quota.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The text prompt or instructions for Merlin' },
        model: { type: 'string', description: 'Model to request (default: gpt-4)', default: 'gpt-4' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'merlin_health',
    description: 'Check the live connection status of the Merlin CDP browser bridge.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

async function handleToolCall(name: string, args: any): Promise<any> {
  if (name === 'merlin_health') {
    try {
      const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Merlin bridge offline: ${e.message}` }], isError: true };
    }
  }

  if (name === 'merlin_complete') {
    const prompt = String(args.prompt || '');
    const model = String(args.model || 'gpt-4');
    try {
      const res = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false
        }),
        signal: AbortSignal.timeout(45000)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          content: [{ type: 'text', text: `Merlin bridge error (HTTP ${res.status}): ${errText}` }],
          isError: true
        };
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || JSON.stringify(data);
      return { content: [{ type: 'text', text: content }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Merlin complete failed: ${e.message}` }], isError: true };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const req = JSON.parse(trimmed);
    const id = req.id;

    if (req.method === 'initialize') {
      const res = {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'merlin-bridge-mcp', version: '1.0.0' }
        }
      };
      process.stdout.write(JSON.stringify(res) + '\n');
      return;
    }

    if (req.method === 'notifications/initialized') {
      return;
    }

    if (req.method === 'tools/list') {
      const res = {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS }
      };
      process.stdout.write(JSON.stringify(res) + '\n');
      return;
    }

    if (req.method === 'tools/call') {
      const toolName = req.params?.name;
      const toolArgs = req.params?.arguments || {};
      const result = await handleToolCall(toolName, toolArgs);
      const res = {
        jsonrpc: '2.0',
        id,
        result
      };
      process.stdout.write(JSON.stringify(res) + '\n');
      return;
    }

    // Default unknown method response
    if (id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) + '\n');
    }
  } catch (err: any) {
    // Malformed request
  }
});
