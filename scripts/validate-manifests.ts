#!/usr/bin/env bun
/**
 * Manifest Validator & CI Guard for agentic-hub
 * Validates all .claude-plugin/plugin.json, plugin.json, and .mcp.json files across plugins/, and a file
 * that a .claude-plugin/plugin.json names in its "mcpServers" field.
 *
 * Checks:
 *  1. Valid JSON formatting.
 *  2. In .claude-plugin/plugin.json, file/script paths (e.g. hooks) start with "./".
 *  3. In .mcp.json, remote servers (having "url") declare "type": "http".
 *  4. Per plugins/<dir>, the name and version of plugin.json, .claude-plugin/plugin.json and the
 *     plugin's entries in .claude-plugin/marketplace.json and marketplace.json are equal.
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

async function readJson(filePath: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null; // a missing file is not drift; a syntax error is already reported by main()
  }
}

/**
 * Version drift guard: for every plugins/<dir> the version (and name) of plugin.json (agy),
 * .claude-plugin/plugin.json (Claude Code), its entry in .claude-plugin/marketplace.json (source
 * "./plugins/<dir>") and its entry in the root marketplace.json (path "plugins/<dir>") must be equal.
 * A file or entry that does not exist is skipped, so a plugin with one manifest is not an error.
 */
async function validateVersionDrift(): Promise<void> {
  const claudeMarket = await readJson(path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json'));
  const rootMarket = await readJson(path.join(REPO_ROOT, 'marketplace.json'));
  const dirs = (await fs.readdir(PLUGINS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory());

  for (const dir of dirs) {
    const base = path.join(PLUGINS_DIR, dir.name);
    const found: { where: string; file: string; name?: string; version?: string }[] = [];
    const agy = await readJson(path.join(base, 'plugin.json'));
    if (agy) found.push({ where: 'plugin.json', file: path.join(base, 'plugin.json'), name: agy.name, version: agy.version });
    const claude = await readJson(path.join(base, '.claude-plugin', 'plugin.json'));
    if (claude) {
      const file = path.join(base, '.claude-plugin', 'plugin.json');
      found.push({ where: '.claude-plugin/plugin.json', file, name: claude.name, version: claude.version });
    }
    const cm = (claudeMarket?.plugins ?? []).find((p: any) => p.source === `./plugins/${dir.name}`);
    if (cm) {
      found.push({ where: '.claude-plugin/marketplace.json', file: path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json'), name: cm.name, version: cm.version });
    }
    const rm = (rootMarket?.plugins ?? []).find((p: any) => p.path === `plugins/${dir.name}`);
    if (rm) {
      found.push({ where: 'marketplace.json', file: path.join(REPO_ROOT, 'marketplace.json'), name: rm.id, version: rm.version });
    }
    if (found.length < 2) continue;

    const first = found[0];
    for (const other of found.slice(1)) {
      if (other.version !== first.version) {
        reportError(other.file, `plugins/${dir.name}: version "${other.version}" in ${other.where} differs from "${first.version}" in ${first.where}`);
      }
      if (other.name !== first.name) {
        reportError(other.file, `plugins/${dir.name}: name "${other.name}" in ${other.where} differs from "${first.name}" in ${first.where}`);
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
      // A manifest may point `mcpServers` at a file of any name (coordination: ./claude/mcp.json, so agy,
      // which never loads a .mcp.json, finds nothing to warn about): validate that file like a .mcp.json.
      if (typeof parsed.mcpServers === 'string') {
        const target = path.resolve(path.dirname(path.dirname(filePath)), parsed.mcpServers);
        const pluginRoot = path.dirname(path.dirname(filePath));
        if (!parsed.mcpServers.startsWith('./') || path.relative(pluginRoot, target).startsWith('..')) {
          reportError(filePath, `"mcpServers" path "${parsed.mcpServers}" must start with "./" and stay inside the plugin`);
        } else {
          const mcp = await readJson(target);
          if (mcp === null) {
            reportError(filePath, `"mcpServers" points at "${parsed.mcpServers}", which is missing or not valid JSON`);
          } else {
            fileCount++;
            await validateMcpJson(target, mcp);
          }
        }
      }
    }

    if (path.basename(filePath) === '.mcp.json') {
      await validateMcpJson(filePath, parsed);
    }
  }

  await validateVersionDrift();

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
