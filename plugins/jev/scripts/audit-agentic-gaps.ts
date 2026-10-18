#!/usr/bin/env bun
/**
 * Agentic Gap & Drift Discovery Engine CLI
 *
 * Scans Antigravity session transcripts and Jev telemetry to uncover:
 * 1. Tool execution errors and invalid enum parameters.
 * 2. Hook denials and recovery loops.
 * 3. Recommendation-to-execution drift (free-tier leakage, unapproved Pro spawns).
 * 4. Boundary transitions and live probe checks (--probe).
 */
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { evaluateDrift, type DriftReport } from '../src/audit/drift-detector.js';

interface CliArgs {
  all: boolean;
  probe: boolean;
  sessionId?: string;
  days: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    all: false,
    probe: false,
    days: 7
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      result.all = true;
    } else if (arg === '--probe') {
      result.probe = true;
    } else if (arg === '--session' && i + 1 < args.length) {
      result.sessionId = args[++i];
    } else if (arg === '--days' && i + 1 < args.length) {
      result.days = parseInt(args[++i], 10) || 7;
    }
  }

  return result;
}

interface Incident {
  sessionId: string;
  timestamp: string;
  category: 'tool_error' | 'hook_denial' | 'invalid_enum' | 'recovery_loop';
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: string;
  toolName?: string;
}

async function runLiveProbe(): Promise<void> {
  console.log('\x1b[1;36m=== Upstream Health & Failover Probe ===\x1b[0m\n');

  // 1. Check OpenRouter API Keys
  const jevKey = process.env.JEV_OPENROUTER_API_KEY || '';
  const generalKey = process.env.OPENROUTER_API_KEY || '';

  console.log(`• JEV_OPENROUTER_API_KEY: ${jevKey ? '\x1b[32mPresent\x1b[0m' : '\x1b[31mMissing\x1b[0m'}`);
  console.log(`• OPENROUTER_API_KEY:     ${generalKey ? '\x1b[32mPresent\x1b[0m' : '\x1b[33mUnset (fallback will use Jev key)\x1b[0m'}`);

  // 2. Probe Free Inference Endpoint
  const activeKey = generalKey || jevKey;
  if (!activeKey) {
    console.log('\x1b[31m✖ No API key available to probe OpenRouter endpoint.\x1b[0m\n');
    return;
  }

  const start = performance.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${activeKey}`
      },
      body: JSON.stringify({
        model: 'openrouter/free',
        messages: [{ role: 'user', content: 'Ping. Reply with "pong".' }],
        max_tokens: 10
      })
    });

    const latency = Math.round(performance.now() - start);
    if (res.ok) {
      const data = (await res.json()) as any;
      const text = data.choices?.[0]?.message?.content?.trim() || '';
      console.log(`\x1b[32m✔ OpenRouter Free Endpoint: Responded in ${latency}ms ("${text}")\x1b[0m`);
    } else {
      console.log(`\x1b[31m✖ OpenRouter Free Endpoint: HTTP ${res.status} (${res.statusText}) in ${latency}ms\x1b[0m`);
      if (res.status === 404) {
        console.log('  → Hint: Key might have Zero Data Retention (ZDR) policy enabled blocking model inference.');
      }
    }
  } catch (err: any) {
    console.log(`\x1b[31m✖ OpenRouter Free Endpoint Failed: ${err.message}\x1b[0m`);
  }

  // 3. Probe Local Hook Subprocess
  const hookCandidates = [
    path.join(process.cwd(), '.agents', 'hooks', 'jev-pre-tool.sh'),
    path.join(os.homedir(), '.gemini', 'config', 'hooks', 'jev-pre-tool.sh'),
    ...(process.env.JEV_PRE_TOOL_HOOK ? [process.env.JEV_PRE_TOOL_HOOK] : [])
  ];
  const hookPath = hookCandidates.find(p => fsSync.existsSync(p));
  if (hookPath) {
    try {
      const proc = Bun.spawnSync([hookPath], {
        stdin: Buffer.from(
          JSON.stringify({
            toolCall: {
              name: 'invoke_subagent',
              args: { Subagents: [{ Role: 'test', Model: 'openrouter_free' }] }
            }
          })
        )
      });

      const stdout = proc.stdout.toString().trim();
      if (stdout.includes('"decision":"deny"') || stdout.includes('Free Tier Guard')) {
        console.log('\x1b[32m✔ Jev Pre-Tool Hook: Free Model Guard active (correctly denied openrouter_free in invoke_subagent)\x1b[0m');
      } else {
        console.log(`\x1b[33m▲ Jev Pre-Tool Hook: Unexpected response: ${stdout}\x1b[0m`);
      }
    } catch (err: any) {
      console.log(`\x1b[31m✖ Hook Subprocess Execution Failed: ${err.message}\x1b[0m`);
    }
  } else {
    console.log('\x1b[33m- Pre-Tool Hook: Not installed in active workspace or global config (skipped)\x1b[0m');
  }

  console.log('\n\x1b[1;36m=== Probe Complete ===\x1b[0m\n');
}

async function main() {
  const cliArgs = parseArgs();

  if (cliArgs.probe) {
    await runLiveProbe();
    if (!cliArgs.all && !cliArgs.sessionId) {
      return;
    }
  }

  const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
  if (!fsSync.existsSync(brainDir)) {
    console.error(`Brain directory not found at: ${brainDir}`);
    process.exit(1);
  }

  const now = Date.now();
  const maxAgeMs = cliArgs.all ? Infinity : cliArgs.days * 24 * 60 * 60 * 1000;

  const sessionDirs = await fs.readdir(brainDir);
  const targetSessions: string[] = [];

  for (const dir of sessionDirs) {
    if (cliArgs.sessionId && dir !== cliArgs.sessionId) {
      continue;
    }

    const fullPath = path.join(brainDir, dir);
    try {
      const st = await fs.stat(fullPath);
      if (st.isDirectory()) {
        if (cliArgs.all || cliArgs.sessionId || now - st.mtimeMs <= maxAgeMs) {
          targetSessions.push(dir);
        }
      }
    } catch {
      // ignore
    }
  }

  console.log(`\n\x1b[1;36m🔍 Auditing ${targetSessions.length} session(s) (Window: ${cliArgs.all ? 'All Time' : `${cliArgs.days} days`})...\x1b[0m\n`);

  const incidents: Incident[] = [];
  const toolInvocations: any[] = [];

  for (const sid of targetSessions) {
    const transcriptPath = path.join(brainDir, sid, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fsSync.existsSync(transcriptPath)) continue;

    try {
      const content = await fs.readFile(transcriptPath, 'utf8');
      const lines = content.split('\n');

      let lastToolCallSignature = '';
      let repeatCount = 0;

      for (const line of lines) {
        if (!line.trim()) continue;
        let step: any;
        try {
          step = JSON.parse(line);
        } catch {
          continue;
        }

        const ts = step.created_at || new Date().toISOString();

        // 1. Check Hook Denials
        if (step.content && typeof step.content === 'string') {
          if (step.content.includes('"decision":"deny"')) {
            incidents.push({
              sessionId: sid,
              timestamp: ts,
              category: 'hook_denial',
              severity: 'medium',
              details: step.content.slice(0, 150)
            });

            toolInvocations.push({
              sessionId: sid,
              timestamp: ts,
              hookDenied: true,
              reason: step.content
            });
          }
        }

        // 2. Check Tool Calls & Invocations
        if (step.tool_calls && Array.isArray(step.tool_calls)) {
          for (const tc of step.tool_calls) {
            const toolName = tc.name || '';
            const args = tc.args || {};

            // Record invocation for drift analysis
            if (toolName === 'invoke_subagent' && Array.isArray(args.Subagents)) {
              for (const sa of args.Subagents) {
                toolInvocations.push({
                  sessionId: sid,
                  timestamp: ts,
                  toolName,
                  model: sa.Model,
                  role: sa.Role
                });

                // Check Enum Mismatch
                const allowed = ['inherit', 'flash_lite', 'flash', 'pro'];
                if (sa.Model && !allowed.includes(sa.Model.toLowerCase())) {
                  incidents.push({
                    sessionId: sid,
                    timestamp: ts,
                    category: 'invalid_enum',
                    severity: 'high',
                    details: `invoke_subagent called with unsupported Model "${sa.Model}". Allowed: ${allowed.join(', ')}`,
                    toolName
                  });
                }
              }
            } else {
              toolInvocations.push({
                sessionId: sid,
                timestamp: ts,
                toolName
              });
            }

            // Check Repeated Recovery Loops
            const sig = `${toolName}:${JSON.stringify(args).slice(0, 80)}`;
            if (sig === lastToolCallSignature) {
              repeatCount++;
              if (repeatCount === 3) {
                incidents.push({
                  sessionId: sid,
                  timestamp: ts,
                  category: 'recovery_loop',
                  severity: 'high',
                  details: `Agent executed tool ${toolName} with identical args 3+ consecutive times.`,
                  toolName
                });
              }
            } else {
              lastToolCallSignature = sig;
              repeatCount = 1;
            }
          }
        }

        // 3. Check Tool Errors
        if (step.status === 'ERROR' || (step.type === 'GENERIC' && typeof step.content === 'string' && step.content.includes('Encountered error in tool execution'))) {
          incidents.push({
            sessionId: sid,
            timestamp: ts,
            category: 'tool_error',
            severity: 'high',
            details: String(step.content || '').slice(0, 160)
          });
        }
      }
    } catch {
      // ignore unreadable transcript
    }
  }

  // Read Jev Telemetry for Drift Analysis
  const telemetryPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'jev_telemetry.jsonl');
  let telemetryEvents: any[] = [];
  if (fsSync.existsSync(telemetryPath)) {
    try {
      const telContent = await fs.readFile(telemetryPath, 'utf8');
      telemetryEvents = telContent
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      // ignore
    }
  }

  const driftReport: DriftReport = evaluateDrift(telemetryEvents, toolInvocations);

  // Print Summary Table
  console.log('┌──────────────────────────────────────┬───────────┬──────────────┬───────────────┐');
  console.log('│ Incident Category                    │ Count     │ Sessions Hit │ Severity      │');
  console.log('├──────────────────────────────────────┼───────────┼──────────────┼───────────────┤');

  const categories = [
    { cat: 'invalid_enum', label: 'Invalid Model Enum Calls' },
    { cat: 'hook_denial', label: 'Pre-Tool Hook Denials' },
    { cat: 'tool_error', label: 'Tool Execution Errors' },
    { cat: 'recovery_loop', label: 'Recovery / Retry Loops' }
  ] as const;

  for (const c of categories) {
    const matching = incidents.filter((i) => i.category === c.cat);
    const sessions = new Set(matching.map((m) => m.sessionId)).size;
    const countStr = String(matching.length).padEnd(9);
    const sessionStr = String(sessions).padEnd(12);
    const sevStr = (matching.some((m) => m.severity === 'critical')
      ? '\x1b[31mCritical\x1b[0m'
      : matching.some((m) => m.severity === 'high')
      ? '\x1b[33mHigh\x1b[0m    '
      : '\x1b[32mMedium\x1b[0m  ').padEnd(15);

    console.log(`│ ${c.label.padEnd(36)} │ ${countStr} │ ${sessionStr} │ ${sevStr} │`);
  }
  console.log('└──────────────────────────────────────┴───────────┴──────────────┴───────────────┘');

  console.log(`\n\x1b[1;36m📊 Agentic Compliance Score: \x1b[1;32m${driftReport.complianceRate}%\x1b[0m (${driftReport.totalViolations} drift events across ${driftReport.totalDispatches} dispatches)`);

  if (driftReport.events.length > 0) {
    console.log('\n\x1b[1;33mRecent Drift Violations:\x1b[0m');
    for (const ev of driftReport.events.slice(-5)) {
      console.log(`  • [${ev.severity.toUpperCase()}] ${ev.type}: ${ev.details}`);
    }
  }

  // Save report to disk
  const reportDir = path.join(os.homedir(), '.config', 'jev');
  if (!fsSync.existsSync(reportDir)) fsSync.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'audit_report.json');

  const finalOutput = {
    generatedAt: new Date().toISOString(),
    windowDays: cliArgs.days,
    sessionsScanned: targetSessions.length,
    incidents,
    driftReport
  };

  await fs.writeFile(reportPath, JSON.stringify(finalOutput, null, 2), 'utf8');
  console.log(`\n\x1b[32m✔ Full audit report saved to:\x1b[0m ${reportPath}\n`);
}

main().catch((err) => {
  console.error('Audit CLI Error:', err);
  process.exit(1);
});
