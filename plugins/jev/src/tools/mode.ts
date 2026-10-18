import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JEV_STATE_FILE, JEV_CONFIG_FILE, type JevMode, logTelemetry } from '../core/index.js';

const execFileAsync = promisify(execFile);
export const JEV_MODE_BIN = path.join(os.homedir(), '.local', 'bin', 'jev-mode');

export interface ModeDetails {
  mode: JevMode;
  title: string;
  explanation: string;
  characteristics: string[];
}

export function getModeDetails(mode: string): ModeDetails {
  const normalized = mode.trim().toLowerCase();
  if (normalized === 'off') {
    return {
      mode: 'off',
      title: 'OFF',
      explanation: 'MCP server disabled. Zero token overhead. Zero OpenRouter calls. Antigravity operates strictly with built-in native tools.',
      characteristics: [
        'MCP server disabled (zero token overhead)',
        'Zero external OpenRouter calls',
        'Antigravity operates strictly with built-in native tools',
        'No pre-flight routing or automatic quality evaluations'
      ]
    };
  }
  if (normalized === 'on-demand' || normalized === 'ondemand') {
    return {
      mode: 'on-demand',
      title: 'ON-DEMAND',
      explanation: 'MCP server enabled as a passive System 1 coprocessor. Invoked selectively for complex multi-role workflows and ad-hoc free-tier generation.',
      characteristics: [
        'Passive System 1 coprocessor',
        'Invoked selectively for complex multi-role workflows and routing',
        'Free-tier generative execution available on request (openrouter/free)',
        'No mandatory pre-flight dispatch on routine tasks'
      ]
    };
  }
  return {
    mode: 'on',
    title: 'ON (AGGRESSIVE)',
    explanation: 'Mandatory System 1 enforcement active: aggressive pre-flight routing, free-tier offloading, automated quality gates, and subagent tier clamping.',
    characteristics: [
      'Pre-Flight Everything: Non-trivial tasks dispatched via jev_dispatch to calibrate subagent role & tier',
      'Free-Tier Offloading: Boilerplate, text formatting, summaries, and commits offloaded to openrouter/free ($0.00 cost, 0 quota)',
      'Automated Quality Gates: Diff evaluations and pre-commit checks evaluated with jev_judge',
      'Subagent Tier Guard: Pro tier models strictly gated behind manual user approval'
    ]
  };
}

export async function readCurrentMode(): Promise<{ mode: JevMode; updatedAt?: string; raw?: Record<string, any> }> {
  try {
    if (fsSync.existsSync(JEV_STATE_FILE)) {
      const raw = await fs.readFile(JEV_STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      const m = (parsed.mode || 'on').toLowerCase();
      const validMode: JevMode = (m === 'off' || m === 'on-demand' || m === 'on') ? m : 'on';
      return { mode: validMode, updatedAt: parsed.updated_at, raw: parsed };
    }
  } catch {
    // Ignore read errors, default to on
  }
  return { mode: 'on' };
}

export async function writeModeState(mode: JevMode, harness?: string): Promise<string> {
  const dir = path.dirname(JEV_STATE_FILE);
  await fs.mkdir(dir, { recursive: true });
  const updatedAt = new Date().toISOString();
  const payload = JSON.stringify({ mode, updated_at: updatedAt });
  await fs.writeFile(JEV_STATE_FILE, payload + '\n', 'utf8');

  try {
    let cfg: any = {};
    if (fsSync.existsSync(JEV_CONFIG_FILE)) {
      cfg = JSON.parse(await fs.readFile(JEV_CONFIG_FILE, 'utf8'));
    }
    if (!cfg.harnesses) cfg.harnesses = {};
    if (harness) {
      if (!cfg.harnesses[harness]) cfg.harnesses[harness] = {};
      cfg.harnesses[harness].mode = mode;
    } else {
      if (!cfg.defaults) cfg.defaults = {};
      cfg.defaults.mode = mode;
      if (!cfg.harnesses.antigravity) cfg.harnesses.antigravity = {};
      cfg.harnesses.antigravity.mode = mode;
    }
    await fs.writeFile(JEV_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  } catch {
    // best-effort
  }

  return updatedAt;
}

export const setModeToolDefinition: Tool = {
  name: 'jev_set_mode',
  description: 'Switch TypeSafe Jev operating mode ("off" | "on-demand" | "on"). Updates ~/.config/jev/mode.json and MCP availability via ~/.local/bin/jev-mode.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['off', 'on-demand', 'on'],
        description: 'The operating mode to set: "off" (disabled, 0 overhead), "on-demand" (passive coprocessor), or "on" (aggressive System 1 enforcement)'
      }
    },
    required: ['mode']
  }
};

export const getModeToolDefinition: Tool = {
  name: 'jev_get_mode',
  description: 'Inspect current TypeSafe Jev operating mode, configuration state, and operating characteristics.',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

export async function handleSetModeTool(args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { mode } = (args || {}) as { mode: string };
  if (!mode) {
    throw new Error('jev_set_mode requires "mode" ("off" | "on-demand" | "on")');
  }

  const norm = String(mode).trim().toLowerCase();
  let targetMode: JevMode;
  if (norm === 'off' || norm === 'disable') {
    targetMode = 'off';
  } else if (norm === 'on-demand' || norm === 'ondemand') {
    targetMode = 'on-demand';
  } else if (norm === 'on' || norm === 'aggressive' || norm === 'enable') {
    targetMode = 'on';
  } else {
    throw new Error(`Invalid mode "${mode}". Supported modes: "off", "on-demand", "on"`);
  }

  let cliOutput = '';
  if (targetMode === 'off') {
    await writeModeState('off');
    if (fsSync.existsSync(JEV_MODE_BIN)) {
      const timer = setTimeout(() => {
        execFile(JEV_MODE_BIN, ['off'], () => {});
      }, 150);
      timer.unref?.();
    }
    cliOutput = 'Jev mode set to OFF (MCP server disable scheduled in 150ms after response flush)';
  } else {
    if (fsSync.existsSync(JEV_MODE_BIN)) {
      try {
        const { stdout, stderr } = await execFileAsync(JEV_MODE_BIN, [targetMode]);
        cliOutput = (stdout + (stderr ? `\n${stderr}` : '')).trim();
      } catch (execErr: any) {
        await writeModeState(targetMode);
        cliOutput = `Direct state update fallback (binary exec error: ${execErr.message})`;
      }
    } else {
      await writeModeState(targetMode);
      cliOutput = 'Direct state update fallback (jev-mode binary not found)';
    }
  }

  const currentState = await readCurrentMode();
  const details = getModeDetails(targetMode);

  const result = {
    mode: targetMode,
    status: 'success',
    title: details.title,
    explanation: details.explanation,
    characteristics: details.characteristics,
    stateFile: JEV_STATE_FILE,
    updatedAt: currentState.updatedAt || new Date().toISOString(),
    cliOutput
  };

  await logTelemetry({
    tool: 'jev_set_mode',
    mode: targetMode,
    status: 'success'
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}

export async function handleGetModeTool(_args?: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const currentState = await readCurrentMode();
  const details = getModeDetails(currentState.mode);

  let cliStatusOutput: string | undefined = undefined;
  let extractedMcpStatus: string | undefined = undefined;
  if (fsSync.existsSync(JEV_MODE_BIN)) {
    try {
      const { stdout } = await execFileAsync(JEV_MODE_BIN, ['status']);
      cliStatusOutput = stdout.trim();
      const match = cliStatusOutput.match(/MCP Status:\s+\x1b\[[0-9;]*m([^\x1b]+)\x1b/);
      if (match && match[1]) {
        extractedMcpStatus = match[1].trim();
      } else {
        const lines = cliStatusOutput.split('\n');
        for (const line of lines) {
          if (line.includes('MCP Status:')) {
            extractedMcpStatus = line.replace(/.*MCP Status:\s*/, '').replace(/\x1b\[[0-9;]*m/g, '').trim();
          }
        }
      }
    } catch {
      // Non-fatal status script error
    }
  }

  const result = {
    mode: currentState.mode,
    status: 'active',
    title: details.title,
    explanation: details.explanation,
    characteristics: details.characteristics,
    stateFile: JEV_STATE_FILE,
    updatedAt: currentState.updatedAt,
    cliStatus: cliStatusOutput,
    mcpStatus: extractedMcpStatus
  };

  await logTelemetry({
    tool: 'jev_get_mode',
    mode: currentState.mode,
    status: 'success'
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}
