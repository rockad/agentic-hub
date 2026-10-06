#!/usr/bin/env bun
/**
 * OpenCode V2 plugin — Jev-driven cost-tiered model selection & delegation.
 *
 * Principle: run each turn on the cheapest model tier that can do the job.
 * Expensive tiers require manual approval; otherwise the plugin continues on
 * the cheaper suitable option. Jev returns the expensive and cheaper options
 * together so the user can choose.
 *
 * OpenRouter-backed Jev only — never the Google/Antigravity subscription.
 *
 * Options:
 *   mode        "off" | "advisory" | "enforce"  (default "advisory")
 *   swap        boolean — attempt true model swap via ctx.aisdk.hook("language") (default false)
 *   candidates  cost-annotated model options for selectModel + swap targets
 *   allowPro    advisory-only escape hatch: never require approval
 *
 * The OpenCode V2 plugin API is beta. Every hook is defensive: a failure or an
 * unexpected event shape no-ops rather than failing the turn.
 *
 * NOTE: OpenCode background service (`opencode serve`) caches plugin ESM modules in memory.
 * After upgrading or modifying the Jev plugin source files, restart the service
 * (`pkill -f "opencode serve"`) to load the new version.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { callJev, readJevMode, readQuotaView, selectModel, loadEnvFile, defaultEffortForSubagent, applyEffortGovernance, type ModelCandidate, type ModelSelection } from '../src/shared.js';
import { applyModelSwap, describeLanguageEvent } from './swap.js';

export type JevPluginMode = 'off' | 'advisory' | 'enforce';

export interface JevPluginOptions {
  mode?: JevPluginMode;
  timeoutMs?: number;
  delegationTool?: string;
  availableSubagents?: string[];
  decisionsLogPath?: string;
  /** Never require approval for expensive tiers. */
  allowPro?: boolean;
  /** Cost-annotated candidates for selectModel and as swap targets. */
  candidates?: ModelCandidate[];
  /** Attempt true model swap via ctx.aisdk.hook("language"). */
  swap?: boolean;
}

interface ResolvedOptions {
  mode: JevPluginMode;
  timeoutMs: number;
  delegationTool: string;
  availableSubagents: string[];
  decisionsLogPath: string;
  allowPro: boolean;
  candidates: ModelCandidate[];
  swap: boolean;
}

const DEFAULT_SUBAGENTS = ['explore', 'general', 'self'];

const SUBAGENT_CRITERIA: Record<string, string> = {
  explore: 'Fast codebase exploration: find files, search code, answer questions about the codebase',
  general: 'General-purpose multi-step tasks and research',
  self: 'Direct answer without delegation',
  // Fallbacks for other harnesses / custom agents.
  code_engineer: 'Implementation, refactors, tests, debugging, build/config changes',
  research: 'Investigation, web/archive lookup, comparison, evidence gathering',
  general_assistant: 'Mixed or unclear work that does not need a specialist',
  review: 'Reviewing diffs, quality checks, risk assessment',
  vault_librarian: 'Vault/notes organisation, filing, frontmatter',
  ghostwriter: 'Drafting prose, docs, emails',
  career_advisor: 'Career records, CV tailoring, applications',
  inbox_processor: 'Triage and filing of incoming material'
};

const TIER_CRITERIA: Record<string, string> = {
  openrouter_free: 'Lightweight summaries, drafts, syntax transforms, formatting, boilerplate ($0 cost)',
  flash_lite: 'Trivial triage, quick lookups, file moves, formatting',
  flash: 'Standard agentic steps, routine edits, content synthesis, local commands',
  pro: 'Deep reasoning, architecture, complex multi-file refactors, high-stakes writing'
};

interface Dispatch {
  recommendedSubagent: string;
  recommendedTier: string;
  recommendedEffort: string;
  confidence: number;
  requiresUserApproval: boolean;
  quotaStrategy: string;
}

function resolveOptions(raw: any): ResolvedOptions {
  const o = raw && typeof raw === 'object' ? raw : {};
  const candidates = Array.isArray(o.candidates)
    ? (o.candidates as ModelCandidate[]).filter(
        (c) => c && typeof c.id === 'string' && typeof c.providerModel === 'string'
      )
    : [];
  return {
    mode: o.mode === 'off' || o.mode === 'enforce' ? o.mode : 'advisory',
    timeoutMs: Number.isFinite(o.timeoutMs) ? o.timeoutMs : 4000,
    delegationTool: typeof o.delegationTool === 'string' ? o.delegationTool : 'task',
    availableSubagents: Array.isArray(o.availableSubagents) && o.availableSubagents.length ? o.availableSubagents : DEFAULT_SUBAGENTS,
    decisionsLogPath: typeof o.decisionsLogPath === 'string'
      ? o.decisionsLogPath
      : path.join(os.homedir(), '.gemini', 'antigravity-cli', 'jev_opencode_decisions.jsonl'),
    allowPro: o.allowPro === true,
    candidates,
    swap: o.swap === true
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('jev timeout')), ms))
  ]);
}

async function fetchRecallMemory(workspace = path.basename(process.cwd()) || 'default'): Promise<any> {
  const tryReadRecall = async (identifier: string) => {
    try {
      const res = await withTimeout(
        fetch('http://127.0.0.1:8110/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'read_note',
              arguments: {
                identifier,
                output_format: 'json',
                include_frontmatter: true
              }
            }
          })
        }),
        800
      );
      if (res.ok) {
        const text = await res.text();
        for (const line of text.split('\n')) {
          if (line.startsWith('data: ')) {
            const parsed = JSON.parse(line.slice(6));
            const fm = parsed?.result?.structuredContent?.result?.frontmatter;
            if (fm && fm.activeGoal) {
              return fm;
            }
          }
        }
      }
    } catch {
      // fallback
    }
    return null;
  };

  const remote = (await tryReadRecall(`session-memory:${workspace}`)) || (await tryReadRecall(`session-handoff:${workspace}`));
  if (remote) return remote;

  for (const file of ['memory.json', 'handoff.json']) {
    try {
      const filePath = path.join(os.homedir(), 'projects', workspace, '.agents', file);
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      // try next
    }
  }

  return null;
}

async function logDecision(file: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    // metadata-only logging is best-effort
  }
}

/** Ask Jev for subagent + tier; returns null on any failure (never throws). */
async function jevDispatch(task: string, opts: ResolvedOptions, quotaStrategy: string): Promise<Dispatch | null> {
  if (!task || task.trim().length < 8) return null;
  try {
    const subagentCriteria: Record<string, string> = {};
    for (const s of opts.availableSubagents) subagentCriteria[s] = SUBAGENT_CRITERIA[s] || s;

    const data: any = await withTimeout(
      callJev(
        `Task: ${task}\n\nQuota strategy for this machine: ${quotaStrategy}.`,
        {
          recommendedSubagent: {
            type: 'choice',
            instructions: 'Select the best specialized agent for this task (or self for direct work)',
            criteria: subagentCriteria
          },
          recommendedTier: {
            type: 'choice',
            instructions: 'Determine the required model tier from cognitive load and complexity',
            criteria: TIER_CRITERIA
          }
        }
      ),
      opts.timeoutMs
    );

    const sa = data?.answers?.recommendedSubagent;
    const tier = data?.answers?.recommendedTier;
    const recommendedTier = typeof tier?.choice === 'string' && tier.choice in TIER_CRITERIA ? tier.choice : 'flash';
    const recommendedSubagent = typeof sa?.choice === 'string' && sa.choice in subagentCriteria ? sa.choice : 'self';
    const confidence = Math.min(sa?.confidence ?? 0.9, tier?.confidence ?? 0.9);
    const rawEffort = defaultEffortForSubagent(recommendedSubagent, task);
    const recommendedEffort = applyEffortGovernance(rawEffort, quotaStrategy, recommendedTier);

    return {
      recommendedSubagent,
      recommendedTier,
      recommendedEffort,
      confidence,
      requiresUserApproval: recommendedTier === 'pro',
      quotaStrategy
    };
  } catch {
    return null;
  }
}

/** Best-effort extraction of recent user/assistant text from a request event. */
function taskText(event: any): string {
  const out: string[] = [];
  const messages = event?.messages;
  if (Array.isArray(messages)) {
    for (const m of messages.slice(-6)) {
      const parts = m?.parts ?? m?.content;
      if (typeof parts === 'string') out.push(parts);
      else if (Array.isArray(parts)) {
        for (const p of parts) {
          if (typeof p === 'string') out.push(p);
          else if (p && typeof p.text === 'string') out.push(p.text);
        }
      }
    }
  }
  return out.join('\n').slice(-4000);
}

function injectDirective(system: any, directive: string): void {
  // OpenCode V2 requires system parts to be objects: `{ type: "text", text }`.
  // Pushing a bare string fails request assembly, and per the hook contract
  // ("a hook failure fails the operation it intercepts") that kills the turn.
  // https://opencode.ai/v2/docs/build/plugins
  if (Array.isArray(system)) system.push({ type: 'text', text: directive });
}

function formatOptions(sel: ModelSelection): string {
  return sel.options
    .map((o) => `${o.id}[${o.tier}] $${o.costInPerMTok}/$${o.costOutPerMTok} p=${(o.prob * 100).toFixed(0)}%${o.suitable ? '' : ' (insufficient)'}`)
    .join(' | ');
}

async function setupInner(ctx: any, rawOptions?: any): Promise<() => void> {
  // Make the OpenRouter key available the same way the MCP server does.
  loadEnvFile(path.join(os.homedir(), '.config/jev/env'));
  loadEnvFile(path.join(process.cwd(), '.env'));
  loadEnvFile(path.resolve((import.meta as any).dir || process.cwd(), '../.env'));

  const opts = resolveOptions(rawOptions ?? ctx?.options);
  const log = (msg: string) => { try { void ctx?.app?.log?.({ body: { service: 'jev', level: 'info', message: msg } }); } catch { /* noop */ } };
  if (opts.mode === 'off') {
    log('jev plugin loaded in off mode');
    return () => {};
  }

  // Auto-detect OpenCode subagents so dispatch advises real targets.
  let detectedSubagents: string[] = [];
  try {
    if (typeof ctx?.agent?.list === 'function') {
      const list: any = await ctx.agent.list();
      const arr = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : [];
      detectedSubagents = arr
        .filter((a: any) => a?.mode === 'subagent')
        .map((a: any) => a.id)
        .filter(Boolean);
      if (detectedSubagents.length) {
        // Additive: keep the built-in baseline even if the host reports a
        // partial set, so dispatch never loses explore/general/self.
        opts.availableSubagents = [...new Set([...detectedSubagents, ...DEFAULT_SUBAGENTS])];
      }
    }
  } catch {
    // keep defaults
  }

  // sessionID -> { hash, rec, at }
  const cache = new Map<string, { hash: string; rec: Dispatch | null; at: number }>();
  const TTL_MS = 20_000;
  // Most recent swap target (aisdk.language has no session id); short-lived.
  const SWAP_WINDOW_MS = 5_000;
  let pendingTarget: { ref: string; at: number } | null = null;
  let lastProbeAt = 0;

  const getAvailableCandidates = async (candidates: ModelCandidate[]): Promise<ModelCandidate[]> => {
    return candidates;
  };

  const compute = async (sessionID: string, text: string, quotaStrategy: string): Promise<Dispatch | null> => {
    const hash = `${text.length}:${text.slice(0, 64)}:${text.slice(-64)}`;
    const hit = cache.get(sessionID);
    if (hit && hit.hash === hash && Date.now() - hit.at < TTL_MS) return hit.rec;
    const rec = await jevDispatch(text, opts, quotaStrategy);
    cache.set(sessionID, { hash, rec, at: Date.now() });
    return rec;
  };

  const hasSessionHook = typeof ctx?.session?.hook === 'function';
  const hasToolHook = typeof ctx?.tool?.hook === 'function';
  const hasAisdkHook = typeof ctx?.aisdk?.hook === 'function';

  // ── Advisory ───────────────────────────────────────────────────────────────
  // Runs once per unique turn text (hash-deduped) so new turns get fresh advice
  // and repeated model calls within one turn do not re-advise. Fully guarded:
  // Jev being slow, unavailable, or misconfigured must never fail a turn.
  const advisedRecently = new Map<string, number>();

  const runAdvisory = async (event: any, hookName: string): Promise<void> => {
    try {
      const jevMode = await readJevMode();
      if (jevMode === 'off') return;
      const quota = await readQuotaView();
      const text = taskText(event);
      if (!text) return;

      // Bound the hot-path advisory so a slow/unreachable Jev cannot stall the turn.
      const advisoryTimeout = Math.min(opts.timeoutMs, 1500);

      const rec = await withTimeout(
        compute(String(event?.sessionID ?? 'unknown'), text, quota.strategy),
        advisoryTimeout
      ).catch(() => null);
      let sel: ModelSelection | null = null;
      const activeCandidates = await getAvailableCandidates(opts.candidates);
      if (activeCandidates.length) {
        try {
          sel = await withTimeout(selectModel(text, activeCandidates, quota.strategy), advisoryTimeout);
        } catch {
          sel = null; // Jev slow/unavailable: never block or fail the turn
        }
      }

      // Select the swap target (cheapest suitable unless the user approves an upgrade).
      if (opts.swap && sel?.recommendedOptionId) {
        const chosen = activeCandidates.find((c) => c.id === sel.recommendedOptionId);
        if (chosen?.providerModel) pendingTarget = { ref: chosen.providerModel, at: Date.now() };
      }

      const parts: string[] = [];
      if (rec) {
        parts.push(`subagent="${rec.recommendedSubagent}"`);
        if (rec.recommendedEffort) parts.push(`effort="${rec.recommendedEffort}"`);
      }
      if (sel) {
        parts.push(
          `model: recommended=${sel.recommendedOptionId} (${sel.recommendation}), cheapestSufficient=${sel.cheapestSufficient}, ` +
          `options: ${formatOptions(sel)}`
        );
      }
      if (!parts.length) return;

      // selectModel (cost) is authoritative for approval when candidates are configured.
      const needsApproval = sel ? sel.recommendation === 'ask_user' : rec?.recommendedTier === 'pro';
      const directive =
        `[JEV] cost-tiered recommendation (quota=${quota.strategy}): ${parts.join('; ')}. ` +
        `Main session model defines the absolute hard ceiling. Lower/cheaper models (or openrouter_free) are encouraged to save cost; subagents/tasks must NEVER execute on a higher/next-generation model tier or version without explicit manual user approval. ` +
        (needsApproval
          ? `the cheapest sufficient option exceeds current ceiling — present options and require explicit user approval before upgrading.`
          : `delegate to the recommended subagent.`);
      // Check for cross-harness memory from Antigravity / Recall (managed via scripts/memory.sh)
      try {
        const workspace = path.basename(process.cwd()) || 'doppelganger';
        const memory = await fetchRecallMemory(workspace);
        if (memory && memory.lastHarness === 'antigravity' && memory.activeGoal) {
          const memoryDirective =
            `[CROSS-HARNESS MEMORY from Antigravity (${memory.updatedAt})]\n` +
            `Active Goal: ${memory.activeGoal}\n` +
            `Next Action: ${memory.nextAction || 'none'}\n` +
            `Current Milestone: ${memory.currentMilestone || 'none'}\n` +
            `(Synced via scripts/memory.sh)`;
          injectDirective(event?.system, memoryDirective);
        }
      } catch {
        // ignore
      }

      injectDirective(event?.system, directive);

      await logDecision(opts.decisionsLogPath, {
        hook: `session.${hookName}`,
        session: event?.sessionID ?? null,
        subagent: rec?.recommendedSubagent ?? null,
        tier: rec?.recommendedTier ?? null,
        effort: rec?.recommendedEffort ?? null,
        recommendation: sel?.recommendation ?? null,
        recommendedOptionId: sel?.recommendedOptionId ?? null,
        upgradeOptionId: sel?.upgradeOptionId ?? null,
        cheapestSufficient: sel?.cheapestSufficient ?? null,
        quota: quota.strategy,
        mode: opts.mode
      });
    } catch {
      // never fail a turn on Jev
    }
  };

  // ── Session hook ───────────────────────────────────────────────────────────
  // Register only `context`: the single documented hook that mutates system
  // instructions immediately before model dispatch. A minimal, fully-guarded
  // surface is what keeps a Jev outage from breaking OpenCode.
  const registeredSessionHooks: string[] = [];
  const failedSessionHooks: string[] = [];

  if (hasSessionHook) {
    try {
      await ctx.session.hook('context', async (event: any) => {
        try {
          const text = taskText(event);
          if (!text) return;
          const hash = `${text.length}:${text.slice(0, 64)}:${text.slice(-64)}`;
          const last = advisedRecently.get(hash) ?? 0;
          if (Date.now() - last < TTL_MS * 2) return;
          advisedRecently.set(hash, Date.now());
          await runAdvisory(event, 'context');
        } catch {
          // never fail a turn on Jev
        }
      });
      registeredSessionHooks.push('context');
    } catch {
      failedSessionHooks.push('context');
    }
  }
  if (!registeredSessionHooks.length) log(`no session hook registered (failed: ${failedSessionHooks.join(',')})`);

  // ── True model swap (experimental) ─────────────────────────────────────────
  if (opts.swap && hasAisdkHook) {
    try {
      await ctx.aisdk.hook('language', (event: any) => {
        try {
          const now = Date.now();
          if (now - lastProbeAt > 30_000) {
            lastProbeAt = now;
            void logDecision(opts.decisionsLogPath, { hook: 'aisdk.language.probe', ...describeLanguageEvent(event) });
          }
          if (!pendingTarget || now - pendingTarget.at > SWAP_WINDOW_MS) return;
          const target = pendingTarget.ref;
          // Cross-provider swap reuses the current provider's SDK to build a
          // foreign model, which breaks the request. Only swap within the same
          // provider; otherwise refuse and let the turn run on its own model.
          const currentProvider = event?.model?.providerID ?? event?.model?.provider;
          const targetProvider = target.includes('/') ? target.slice(0, target.indexOf('/')) : '';
          if (currentProvider && targetProvider && currentProvider !== targetProvider) {
            void logDecision(opts.decisionsLogPath, {
              hook: 'aisdk.language.swap', target, ok: false,
              reason: `refused cross-provider swap (${currentProvider} -> ${targetProvider})`
            });
            pendingTarget = null;
            return;
          }
          const res = applyModelSwap(event, target);
          void logDecision(opts.decisionsLogPath, { hook: 'aisdk.language.swap', target, ok: res.ok, reason: res.reason });
          if (res.ok) pendingTarget = null;
        } catch {
          // never fail dispatch
        }
      });
    } catch {
      log('aisdk.hook("language") unavailable; true swap disabled');
    }
  }

  // ── Delegation guard: expensive execution requires approval ────────────────
  if (hasToolHook && opts.mode === 'enforce' && !opts.allowPro) {
    try {
      await ctx.tool.hook('execute.before', async (a: any, b: any) => {
        try {
          const event = a ?? {};
          const out = b ?? event;
          const tool = event.tool ?? event.name ?? out.tool;
          if (tool !== opts.delegationTool) return;
          const args = out.args ?? event.args ?? {};
          const task = String(args.prompt ?? args.description ?? args.task ?? '');
          const jevMode = await readJevMode();
          if (jevMode === 'off' || !task) return;
          const quota = await readQuotaView();

          const activeCandidates = await getAvailableCandidates(opts.candidates);
          if (activeCandidates.length) {
            const sel = await selectModel(task, activeCandidates, quota.strategy);
            if (sel.recommendation === 'ask_user') {
              throw new Error(
                `[jev] The cheapest sufficient option may be expensive for this delegation. ` +
                `Options: ${formatOptions(sel)}. Ask the user for approval before proceeding ` +
                `(cheapest suitable = ${sel.recommendedOptionId}, upgrade = ${sel.upgradeOptionId ?? 'n/a'}).`
              );
            }
            return;
          }

          const rec = await compute(String(event.sessionID ?? 'unknown'), task, quota.strategy);
          if (rec?.recommendedTier === 'pro') {
            throw new Error(
              `[jev] The Jev dispatcher recommends the pro tier for this delegation. ` +
              `Ask the user for approval before proceeding (or set allowPro: true). Task: "${task.slice(0, 120)}"`
            );
          }
          if (rec?.recommendedTier === 'openrouter_free' && args && typeof args === 'object') {
            args.agent = args.agent ?? args.subagent ?? rec.recommendedSubagent;
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('[jev]')) throw e; // propagate the guard
          // otherwise swallow
        }
      });
    } catch {
      log('tool.hook("execute.before") unavailable; enforcement disabled');
    }
  }

  log(`jev plugin ready (mode=${opts.mode}, sessionHook=${hasSessionHook}, toolHook=${hasToolHook}, aisdkHook=${hasAisdkHook}, swap=${opts.swap}, candidates=${opts.candidates.length})`);
  await logDecision(opts.decisionsLogPath, {
    hook: 'setup',
    mode: opts.mode,
    sessionHook: hasSessionHook,
    toolHook: hasToolHook,
    aisdkHook: hasAisdkHook,
    swap: opts.swap,
    candidates: opts.candidates.map((c) => c.id),
    subagents: opts.availableSubagents,
    detectedSubagents,
    delegationTool: opts.delegationTool
  });

  return () => {
    cache.clear();
    pendingTarget = null;
  };
}

/**
 * Non-fatal entry point: if setup throws for any reason, the plugin loads as a
 * no-op instead of taking OpenCode down. A broken/slow Jev must never break the
 * host. Every hook is additionally wrapped so a runtime failure no-ops.
 */
export async function setup(ctx: any, rawOptions?: any): Promise<() => void> {
  try {
    return await setupInner(ctx, rawOptions);
  } catch (e: any) {
    try {
      void ctx?.app?.log?.({ body: { service: 'jev', level: 'error', message: `jev plugin setup failed (non-fatal): ${e?.message || e}` } });
    } catch {
      // ignore
    }
    return () => {};
  }
}

const plugin = { id: 'jev', setup };
export default plugin;
export { plugin };
