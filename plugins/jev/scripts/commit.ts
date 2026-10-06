#!/usr/bin/env bun
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function getGitRepoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel 2>/dev/null', { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function getApiKey(): string {
  if (process.env.JEV_OPENROUTER_API_KEY) return process.env.JEV_OPENROUTER_API_KEY;
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const repoRoot = getGitRepoRoot();
  const envPaths = [
    path.join(os.homedir(), '.config/zsh/secrets.env'),
    path.join(os.homedir(), '.config/jev/env'),
    path.join(os.homedir(), 'projects/agentic-hub/plugins/jev/.env'),
    path.resolve(__dirname, '..', '.env'),
    path.join(repoRoot, '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('JEV_OPENROUTER_API_KEY=')) {
            const val = trimmed.replace('JEV_OPENROUTER_API_KEY=', '').trim();
            if (val) return val;
          }
          if (trimmed.startsWith('OPENROUTER_API_KEY=')) {
            const val = trimmed.replace('OPENROUTER_API_KEY=', '').trim();
            if (val) return val;
          }
        }
      } catch {}
    }
  }

  // Fallback: check ~/.gemini/config/mcp_config.json
  const mcpConfigFile = path.join(os.homedir(), '.gemini/config/mcp_config.json');
  if (fs.existsSync(mcpConfigFile)) {
    try {
      const conf = JSON.parse(fs.readFileSync(mcpConfigFile, 'utf8'));
      if (conf.mcpServers?.jev?.env?.OPENROUTER_API_KEY) {
        return conf.mcpServers.jev.env.OPENROUTER_API_KEY;
      }
    } catch {}
  }

  return '';
}

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const autoStage = args.includes('-a') || args.includes('--all');
const allowForce = args.includes('--force') || args.includes('--no-verify');

// Ensure we are inside a git repository
try {
  execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
} catch {
  console.error('\x1b[31mError:\x1b[0m Not inside a git repository.');
  process.exit(1);
}

if (autoStage) {
  try {
    execSync('git add -u', { stdio: 'inherit' });
  } catch (err: any) {
    console.error('Failed to stage modified files:', err.message);
    process.exit(1);
  }
}

let cachedDiff = '';
try {
  cachedDiff = execSync('git diff --cached', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
} catch (err: any) {
  console.error('Failed to get git diff:', err.message);
  process.exit(1);
}

if (!cachedDiff.trim()) {
  const status = execSync('git status --porcelain', { encoding: 'utf8' });
  if (status.trim()) {
    console.error('\x1b[33mNo staged changes found.\x1b[0m Stage changes first with `git add` or run `commit -a`.');
  } else {
    console.log('\x1b[32mWorking tree clean, nothing to commit.\x1b[0m');
  }
  process.exit(0);
}

const apiKey = getApiKey();
if (!apiKey) {
  console.error('\x1b[31mError:\x1b[0m OPENROUTER_API_KEY not found in environment, ~/.config/jev/env, or plugin .env');
  process.exit(1);
}

// Truncate diff if very large to fit comfortably in free model context
const truncatedDiff = cachedDiff.length > 8000
  ? cachedDiff.slice(0, 8000) + '\n... [diff truncated for length]'
  : cachedDiff;

const FREE_MODELS = [
  'cohere/north-mini-code:free',
  'nvidia/nemotron-3.5-lightning:free',
  'google/gemma-4-31b-it:free',
  'openrouter/free'
];

async function callFreeModel(prompt: string, systemMsg: string): Promise<string> {
  let lastErr = '';
  for (const model of FREE_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/agentic-hub/jev',
          'X-Title': 'Antigravity Free Commit Generator'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemMsg },
            { role: 'user', content: prompt }
          ]
        })
      });

      if (!res.ok) {
        lastErr = await res.text();
        continue;
      }

      const data: any = await res.json();
      const content = (data.choices?.[0]?.message?.content || '').trim();
      // Skip safety classifier responses or empty strings
      if (content && !content.toLowerCase().startsWith('user safety:')) {
        return content;
      }
    } catch (e: any) {
      lastErr = e.message;
    }
  }
  throw new Error(`Failed to generate commit message across free models: ${lastErr}`);
}

async function main() {
  const commitMsgRaw = await callFreeModel(
    `Generate a conventional commit message for this staged diff:\n\n${truncatedDiff}`,
    'You are an expert software engineer generating concise, semantic git commit messages following Conventional Commits (e.g. feat(scope): message, fix(scope): message, chore(scope): message). Output ONLY the single-line commit message. No explanations, no markdown backticks, no quotes.'
  );
  let commitMsg = commitMsgRaw.replace(/^[`'"]+|[`'"]+$/g, '').trim();

  // Validate message with Jev Decisions API (fast binary judgment)
  console.log(`\x1b[90mCandidate: "${commitMsg}" — Evaluating via jev_judge...\x1b[0m`);
  try {
    const judgeRes = await fetch('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/agentic-hub/jev',
        'X-Title': 'Antigravity Jev Commit Gate'
      },
      body: JSON.stringify({
        model: '~typesafe/jev-latest',
        state: `Diff summary:\n${truncatedDiff.slice(0, 500)}\n\nProposed commit message:\n${commitMsg}`,
        questions: {
          valid_commit: {
            type: 'noul',
            instructions: 'Is this a valid, conventional commit message (type(scope): summary) matching the diff without filler words?'
          }
        }
      })
    });
    if (judgeRes.ok) {
      const judgeData: any = await judgeRes.json();
      const noul = judgeData.answers?.valid_commit?.noul ?? 0.5;
      if (noul < 0.35) {
        if (allowForce) {
          console.warn(`\x1b[33mWarning: Jev quality gate scored confidence low (${noul.toFixed(2)}), but proceeding due to force flag.\x1b[0m`);
        } else {
          console.error(`\x1b[31mError: Jev quality gate rejected commit message (noul ${noul.toFixed(2)} < 0.35).\x1b[0m`);
          console.error(`Proposed commit message: "${commitMsg}"`);
          console.error(`Use --force or --no-verify to override.`);
          process.exit(1);
        }
      } else {
        console.log(`\x1b[32m✔ Jev quality gate verified (noul ${noul.toFixed(2)})\x1b[0m`);
      }
    }
  } catch (err: any) {
    // Non-blocking fallback
    console.log(`\x1b[90m(Jev judge fallback: ${err.message})\x1b[0m`);
  }

  console.log(`\x1b[1;36mCommit Message:\x1b[0m \x1b[1m${commitMsg}\x1b[0m`);

  if (isDryRun) {
    console.log('\x1b[33m--dry-run specified: Commit not executed.\x1b[0m');
    return;
  }

  try {
    execSync(`git commit -m ${JSON.stringify(commitMsg)}`, { stdio: 'inherit' });
    console.log('\x1b[32m✔ Successfully committed changes!\x1b[0m');
  } catch (err: any) {
    console.error('\x1b[31mGit commit failed:\x1b[0m', err.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\x1b[31mError generating commit:\x1b[0m', err.message);
  process.exit(1);
});
