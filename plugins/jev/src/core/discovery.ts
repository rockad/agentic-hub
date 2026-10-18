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

export function clearAgentCache(): void {
  agentCache = null;
}

function parseAgentContent(content: string, defaultName: string): { name: string; description: string } {
  let name = defaultName;
  let description = '';

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match) {
    const yamlBlock = match[1];
    for (const line of yamlBlock.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('name:')) {
        const val = trimmed.slice(5).trim().replace(/^['"]|['"]$/g, '');
        if (val) name = val;
      } else if (trimmed.startsWith('description:')) {
        const val = trimmed.slice(12).trim().replace(/^['"]|['"]$/g, '');
        if (val) description = val;
      }
    }
  }

  return {
    name,
    description: description || `Agent specialized in ${name.replace(/[-_]/g, ' ')}`
  };
}

/**
 * Pure Dynamic Subagent Discovery
 * Scans .agents/agents (or legacy .agents/subagents) in active workspace or $DOPPELGANGER_HOME.
 * Supports directory-per-agent (${dir}/agent.md) and fallback standalone .md files.
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

    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    const result: Record<string, string> = {};

    // 1. First pass: Directory-per-agent (${targetDir}/${item}/agent.md)
    for (const entry of entries) {
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const st = await fs.stat(path.join(targetDir, entry.name));
          isDir = st.isDirectory();
        } catch {
          // ignore broken link
        }
      }

      if (isDir) {
        const agentFile = path.join(targetDir, entry.name, 'agent.md');
        try {
          const st = await fs.stat(agentFile);
          if (st.isFile()) {
            const content = await fs.readFile(agentFile, 'utf8');
            const parsed = parseAgentContent(content, entry.name);
            if (parsed.name) {
              result[parsed.name] = parsed.description;
            }
          }
        } catch {
          // agent.md doesn't exist or is not readable
        }
      }
    }

    // 2. Second pass: Standalone .md files as fallback (backward compatibility)
    for (const entry of entries) {
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = await fs.stat(path.join(targetDir, entry.name));
          isFile = st.isFile();
        } catch {
          // ignore broken link
        }
      }

      if (isFile && entry.name.endsWith('.md')) {
        const defaultName = path.basename(entry.name, '.md');
        const filePath = path.join(targetDir, entry.name);
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const parsed = parseAgentContent(content, defaultName);
          if (parsed.name && !result[parsed.name]) {
            result[parsed.name] = parsed.description;
          }
        } catch {
          // ignore unreadable file
        }
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
