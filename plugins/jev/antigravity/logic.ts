import { createHash } from 'node:crypto';
import { modelTierRank, rankToTierName } from '../src/core/governance.js';
import type { ApprovalStore, ApprovalScope } from './approvals.js';

export type AntigravityHookInput = {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  lastUserInput?: string;
  hookEventName?: string;
  stepIdx?: number;
  cwd?: string;
  toolCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
  content?: string;
};

export type AntigravityHookDecision = {
  decision: 'allow' | 'deny' | 'ask' | 'force_ask';
  reason?: string;
  permissionOverrides?: string[];
  overwrite?: Record<string, unknown>;
  elevation?: 'approved' | 'instructed' | 'denied' | 'asked' | 'clamped';
  approvalScope?: ApprovalScope;
  attemptCount?: number;
  clampedTo?: string;
};

export type AntigravityLogicDeps = {
  approvals?: ApprovalStore;
  sessionModelOverride?: string;
  elevationMode?: 'choice' | 'dialog' | 'clamp';
  now?: () => number;
};

export const ELEVATE_MARKER_PREFIX = '[jev-elevate:';

export const CHOICE_OPTIONS = {
  once: 'Yes, once',
  fiveMin: 'Yes, for the next 5 minutes',
  session: 'Yes, for this session',
  no: (ceiling: string) => `No, proceed on ${ceiling}`
};

export function isExplicitProOverride(promptText?: string): boolean {
  const text = (promptText || '').toLowerCase();
  return (
    text.includes('manual pro approval') ||
    text.includes('gemini pro') ||
    text.includes('gemini argon') ||
    text.includes('argon') ||
    text.includes('claude opus') ||
    text.includes('deep reasoning') ||
    text.includes('cross-system architecture')
  );
}

export function extractSubagentModel(args?: Record<string, unknown>): { requestedModel: string | null; isExplicit: boolean } {
  if (!args || typeof args !== 'object') {
    return { requestedModel: null, isExplicit: false };
  }

  // 1. Flat args.Model (current real Antigravity schema)
  if (typeof args.Model === 'string' && args.Model.trim().length > 0) {
    const m = args.Model.trim().toLowerCase();
    if (m === 'inherit') {
      return { requestedModel: null, isExplicit: false };
    }
    return { requestedModel: m, isExplicit: true };
  }

  // 2. Backward compatibility with older args.Subagents[] shape
  if (Array.isArray(args.Subagents) && args.Subagents.length > 0) {
    for (const sub of args.Subagents) {
      if (sub && typeof sub === 'object' && typeof (sub as Record<string, unknown>).Model === 'string') {
        const m = ((sub as Record<string, unknown>).Model as string).trim().toLowerCase();
        if (m && m !== 'inherit') {
          return { requestedModel: m, isExplicit: true };
        }
      }
    }
  }

  return { requestedModel: null, isExplicit: false };
}

export function buildElevationQuestion(opts: {
  typeName: string;
  requestedModel: string;
  ceilingTier: string;
  taskSummary?: string;
}): { question: string; options: string[] } {
  const summaryPart = opts.taskSummary ? ` for ${opts.taskSummary}` : '';
  const question = `${ELEVATE_MARKER_PREFIX}${opts.requestedModel}] Allow subagent '${opts.typeName}' to run on ${opts.requestedModel}${summaryPart} (session ceiling: ${opts.ceilingTier})?`;
  const options = [
    CHOICE_OPTIONS.once,
    CHOICE_OPTIONS.fiveMin,
    CHOICE_OPTIONS.session,
    CHOICE_OPTIONS.no(opts.ceilingTier)
  ];
  return { question, options };
}

export function buildElevationReason(opts: {
  typeName: string;
  requestedModel: string;
  sessionCeilingTier: string;
  taskSummary?: string;
}): string {
  const q = buildElevationQuestion({
    typeName: opts.typeName,
    requestedModel: opts.requestedModel,
    ceilingTier: opts.sessionCeilingTier,
    taskSummary: opts.taskSummary
  });

  return (
    `[jev] Subagent '${opts.typeName}' requested Model '${opts.requestedModel}', which exceeds session ceiling '${opts.sessionCeilingTier}', ` +
    `and no approval covers it. Ask the user with ask_question: one question whose text starts with ` +
    `'${ELEVATE_MARKER_PREFIX}${opts.requestedModel}]', with four options in this order: ` +
    `'${q.options[0]}', '${q.options[1]}', '${q.options[2]}', '${q.options[3]}'. ` +
    `If the user approves, re-invoke with '${opts.requestedModel}'; if No, re-invoke with '${opts.sessionCeilingTier}' (or inherit); ` +
    `do not ask in any other form.`
  );
}

export function parseElevationAnswer(answerText?: string): { approved: boolean; scope?: ApprovalScope; model?: string } {
  if (!answerText || typeof answerText !== 'string') return { approved: false };

  const norm = answerText.toLowerCase();

  // Model marker check if present
  let model: string | undefined;
  const match = answerText.match(/\[jev-elevate:([a-z0-9_-]+)\]/i);
  if (match) {
    model = match[1].toLowerCase();
  }

  if (norm.includes('yes, once') || norm.includes('once')) {
    return { approved: true, scope: 'once', model };
  }
  if (norm.includes('5 minutes') || norm.includes('5min') || norm.includes('five minutes')) {
    return { approved: true, scope: '5min', model };
  }
  if (norm.includes('this session') || norm.includes('session')) {
    return { approved: true, scope: 'session', model };
  }

  return { approved: false, model };
}

export function evaluateAntigravitySubagentCall(
  input: AntigravityHookInput,
  deps: AntigravityLogicDeps = {}
): AntigravityHookDecision {
  const toolName = input?.toolCall?.name || '';
  if (toolName !== 'invoke_subagent') {
    return { decision: 'allow' };
  }

  const sessionId = input.conversationId || 'default-session';
  const nowMs = (deps.now ?? Date.now)();
  const sessionModel = deps.sessionModelOverride || input.modelName || 'gemini-3.8-flash-low';
  const sessionCeilingRank = modelTierRank(sessionModel);
  const sessionCeilingTier = rankToTierName(sessionCeilingRank);

  const { requestedModel, isExplicit } = extractSubagentModel(input.toolCall?.args);

  // If Model is omitted or inherit, it resolves to session model (proved by control) -> allowed
  if (!isExplicit || !requestedModel) {
    return { decision: 'allow' };
  }

  const requestedRank = modelTierRank(requestedModel);
  if (requestedRank <= sessionCeilingRank) {
    return { decision: 'allow' };
  }

  // Requested model exceeds session ceiling: ELEVATION
  const args = input.toolCall?.args || {};
  const typeName = String(args.TypeName || args.Role || 'subagent');

  // Check explicit override in user prompt
  if (isExplicitProOverride(input.lastUserInput)) {
    return { decision: 'allow', elevation: 'instructed' };
  }

  // Check covering approval
  const approval = deps.approvals?.claim(sessionId, requestedModel, nowMs);
  if (approval) {
    return {
      decision: 'allow',
      elevation: 'approved',
      approvalScope: approval.scope
    };
  }

  const elevationMode = deps.elevationMode || (process.env.JEV_ELEVATION === 'dialog' || process.env.JEV_ELEVATION === 'clamp' ? process.env.JEV_ELEVATION : 'choice');

  if (elevationMode === 'dialog') {
    return {
      decision: 'ask',
      reason: `[jev] Subagent '${typeName}' requested Model '${requestedModel}' above session ceiling '${sessionCeilingTier}'. Approve to run on ${requestedModel}, or cancel.`,
      elevation: 'asked'
    };
  }

  const promptHash = input.lastUserInput
    ? createHash('sha256').update(input.lastUserInput).digest('hex').slice(0, 16)
    : 'no-prompt';
  const signature = `${typeName}:${requestedModel}`;

  if (elevationMode === 'clamp') {
    const count = deps.approvals?.attempt(sessionId, promptHash, signature, nowMs) ?? 1;
    if (count === 1) {
      return {
        decision: 'allow',
        overwrite: { Model: sessionCeilingTier },
        elevation: 'clamped',
        clampedTo: sessionCeilingTier
      };
    }
    return {
      decision: 'ask',
      reason: `[jev] Repeated elevation attempt: Subagent '${typeName}' requested Model '${requestedModel}' above session ceiling '${sessionCeilingTier}'.`,
      elevation: 'asked',
      attemptCount: count
    };
  }

  // Choice mode (default):
  const count = deps.approvals?.attempt(sessionId, promptHash, signature, nowMs) ?? 1;
  if (count <= 2) {
    deps.approvals?.deny(sessionId, requestedModel, nowMs);
    const reason = buildElevationReason({
      typeName,
      requestedModel,
      sessionCeilingTier
    });
    return {
      decision: 'deny',
      reason,
      elevation: 'denied',
      attemptCount: count
    };
  }

  // Attempt >= 3: Dialog Backstop
  return {
    decision: 'ask',
    reason: `[jev] Elevation backstop (attempt ${count}): Subagent '${typeName}' requested Model '${requestedModel}' above session ceiling '${sessionCeilingTier}'. Approve to run on ${requestedModel}, or cancel to proceed on ${sessionCeilingTier}.`,
    elevation: 'asked',
    attemptCount: count
  };
}
