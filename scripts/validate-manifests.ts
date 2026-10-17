#!/usr/bin/env bun
/**
 * Manifest Validator & CI Guard for agentic-hub
 * Validates all .claude-plugin/plugin.json, plugin.json, and .mcp.json files across plugins/.
 *
 * Checks:
 *  1. Valid JSON formatting.
 *  2. In .claude-plugin/plugin.json, file/script paths (e.g. hooks) start with "./".
 *  3. In .mcp.json, remote servers (having "url") declare "type": "http".
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

let errorCount = 0;
let fileCount = 0;

function reportError(filePath: string, message: string): void {
  const relPath = path.relative(REPO_ROOT, filePath);
  console.error(`❌ [ERROR] ${relPath}: ${message}`);
  errorCount++;
}

async function findFiles(dir: string, fileNames: Set<string>): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.agents') continue;
        results.push(...(await findFiles(fullPath, fileNames)));
      } else if (entry.isFile() && fileNames.has(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch {
    // skip unreadable
  }
  return results;
}

async function validateClaudePluginJson(filePath: string, data: any): Promise<void> {
  // Check known path fields like "hooks"
  if (typeof data.hooks === 'string') {
    if (!data.hooks.startsWith('./')) {
      reportError(filePath, `"hooks" path "${data.hooks}" must start with "./"`);
    }
  }

  // Check any additional relative path fields that might be configured
  for (const [key, val] of Object.entries(data)) {
    if (typeof val === 'string' && (key.endsWith('Path') || key === 'entrypoint' || key === 'script')) {
      if (!val.startsWith('./') && !val.startsWith('/') && !val.startsWith('http://') && !val.startsWith('https://')) {
        reportError(filePath, `path field "${key}" with value "${val}" must start with "./"`);
      }
    }
  }
}

async function validateMcpJson(filePath: string, data: any): Promise<void> {
  const mcpServers = data.mcpServers;
  if (!mcpServers || typeof mcpServers !== 'object') {
    reportError(filePath, `missing or invalid "mcpServers" object`);
    return;
  }

  for (const [serverName, serverConfig] of Object.entries<any>(mcpServers)) {
    if (!serverConfig || typeof serverConfig !== 'object') {
      reportError(filePath, `server "${serverName}" has invalid configuration`);
      continue;
    }

    // Remote servers (having url) must declare "type": "http"
    if (typeof serverConfig.url === 'string') {
      if (serverConfig.type !== 'http') {
        reportError(
          filePath,
          `remote server "${serverName}" declares "url": "${serverConfig.url}" but must declare "type": "http" (found "${serverConfig.type}")`
        );
      }
    }
  }
}

async function main(): Promise<void> {
  console.log(`🔍 Scanning ${path.relative(REPO_ROOT, PLUGINS_DIR)} for manifests...`);
  const targetNames = new Set(['plugin.json', '.mcp.json']);
  const manifestFiles = await findFiles(PLUGINS_DIR, targetNames);

  for (const filePath of manifestFiles) {
    fileCount++;
    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, 'utf8');
    } catch (err: any) {
      reportError(filePath, `Failed to read file: ${err.message}`);
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err: any) {
      reportError(filePath, `Invalid JSON syntax: ${err.message}`);
      continue;
    }

    if (filePath.endsWith(path.join('.claude-plugin', 'plugin.json'))) {
      await validateClaudePluginJson(filePath, parsed);
    }

    if (path.basename(filePath) === '.mcp.json') {
      await validateMcpJson(filePath, parsed);
    }
  }

  console.log(`\n📋 Validation Summary:`);
  console.log(`   Files checked: ${fileCount}`);
  console.log(`   Errors found:  ${errorCount}`);

  if (errorCount > 0) {
    console.error(`\n❌ Manifest validation failed with ${errorCount} error(s).`);
    process.exit(1);
  } else {
    console.log(`\n✓ All manifests validated successfully.`);
    process.exit(0);
  }
}

await main();
