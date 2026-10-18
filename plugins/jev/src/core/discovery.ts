import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

interface AgentCacheEntry {
  timestamp: number;
  dirPath?: string;
  dirMtime: number;
  agents: Record<string, string>;
}

let agentCache: AgentCacheEntry | null = null;

/**
 * Pure Dynamic Subagent Discovery
 * Scans .agents/agents/*.md (or legacy .agents/subagents/*.md) in active workspace or $DOPPELGANGER_HOME.
 * Uses filesystem mtime and 15s in-memory TTL cache to minimize I/O.
 */
export async function discoverWorkspaceAgents(cwd: string = process.cwd()): Promise<Record<string, string>> {
  const doppelHome = process.env.DOPPELGANGER_HOME || path.join(os.homedir(), 'projects', 'doppelganger');
  const candidates = [
    path.join(cwd, '.agents', 'agents'),
    path.join(cwd, '.agents', 'subagents'),
    path.join(doppelHome, '.agents', 'agents'),
    path.join(doppelHome, '.agents', 'subagents')
  ];

  let targetDir: string | null = null;
  for (const dir of candidates) {
    try {
      const st = await fs.stat(dir);
      if (st.isDirectory()) {
        targetDir = dir;
        break;
      }
    } catch {
      // continue
    }
  }

  if (!targetDir) {
    return {
      self: 'Direct execution in current context or clone of session',
      none: 'Direct answer without subagent delegation'
    };
  }

  try {
    const dirStat = await fs.stat(targetDir);
    const now = Date.now();
    if (agentCache && now - agentCache.timestamp < 15000 && agentCache.dirPath === targetDir && agentCache.dirMtime === dirStat.mtimeMs) {
      return { ...agentCache.agents };
    }

    const files = await fs.readdir(targetDir);
    const result: Record<string, string> = {};

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(targetDir, file);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (match) {
          const yamlBlock = match[1];
          let name = path.basename(file, '.md');
          let description = '';

          for (const line of yamlBlock.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('name:')) {
              name = trimmed.slice(5).trim().replace(/^['"]|['"]$/g, '');
            } else if (trimmed.startsWith('description:')) {
              description = trimmed.slice(12).trim().replace(/^['"]|['"]$/g, '');
            }
          }

          if (name) {
            result[name] = description || `Agent specialized in ${name.replace(/_/g, ' ')}`;
          }
        }
      } catch {
        // ignore unreadable file
      }
    }

    if (Object.keys(result).length === 0) {
      result.self = 'Direct execution in current context';
      result.none = 'Direct answer without subagent delegation';
    } else {
      if (!result.self) result.self = 'Direct clone of parent execution or current session';
      if (!result.none) result.none = 'Direct answer without subagent delegation';
    }

    agentCache = {
      timestamp: now,
      dirPath: targetDir,
      dirMtime: dirStat.mtimeMs,
      agents: result
    };

    return { ...result };
  } catch {
    return {
      self: 'Direct execution in current context',
      none: 'Direct answer without subagent delegation'
    };
  }
}
