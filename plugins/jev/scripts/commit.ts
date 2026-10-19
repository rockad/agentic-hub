#!/usr/bin/env bun
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import {
  callOpenRouterFree,
  callJevDecision,
  loadEnvFile
} from '../src/core/client.js';

function getGitRepoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel 2>/dev/null', { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

// Load optional local repo or current directory .env files if present
const repoRoot = getGitRepoRoot();
loadEnvFile(path.join(repoRoot, '.env'));
loadEnvFile(path.join(process.cwd(), '.env'));

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

// Truncate diff if very large to fit comfortably in free model context
const truncatedDiff = cachedDiff.length > 8000
  ? cachedDiff.slice(0, 8000) + '\n... [diff truncated for length]'
  : cachedDiff;

async function generateCommitMessage(diffText: string): Promise<string> {
  const prompt = `Generate a conventional commit message for this staged diff:\n\n${diffText}`;
  const systemInstruction =
    'You are an expert software engineer generating concise, semantic git commit messages following Conventional Commits (e.g. feat(scope): message, fix(scope): message, chore(scope): message). Output ONLY the single-line commit message. No explanations, no markdown backticks, no quotes.';
  const result = await callOpenRouterFree(prompt, systemInstruction);
  const content = (result.content || '').trim();
  if (!content) {
    throw new Error('Received empty commit message from free model pool');
  }
  return content;
}

async function main() {
  const commitMsgRaw = await generateCommitMessage(truncatedDiff);
  let commitMsg = commitMsgRaw.replace(/^[`'"]+|[`'"]+$/g, '').trim();

  // Validate message with Jev Decisions API (fast binary judgment)
  console.log(`\x1b[90mCandidate: "${commitMsg}" — Evaluating via jev_judge...\x1b[0m`);
  try {
    const judgeData = await callJevDecision(
      `Diff summary:\n${truncatedDiff.slice(0, 500)}\n\nProposed commit message:\n${commitMsg}`,
      {
        valid_commit: {
          type: 'noul',
          instructions: 'Is this a valid, conventional commit message (type(scope): summary) matching the diff without filler words?'
        }
      }
    );
    const noul = judgeData?.answers?.valid_commit?.noul ?? 0.5;
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
  } catch (err: any) {
    // Non-blocking fallback
    console.log(`\x1b[90m(Jev judge fallback: ${err.message})\x1b[0m`);
  }

  console.log(`\x1b[1;36mCommit Message:\x1b[0m \x1b[1m${commitMsg}\x1b[0m`);

  if (isDryRun) {
    console.log('\x1b[33m--dry-run specified: Commit not executed.\x1b[0m');
    return;
  }

  // Pass the message as an argument, never through a shell: it comes from a model that reads the diff.
  const result = Bun.spawnSync(['git', 'commit', '-m', commitMsg], { stdio: ['inherit', 'inherit', 'inherit'] });
  if (result.exitCode !== 0) {
    console.error(`\x1b[31mGit commit failed:\x1b[0m git exited with code ${result.exitCode}`);
    process.exit(1);
  }
  console.log('\x1b[32m✔ Successfully committed changes!\x1b[0m');
}

main().catch(err => {
  console.error('\x1b[31mError generating commit:\x1b[0m', err.message);
  process.exit(1);
});
