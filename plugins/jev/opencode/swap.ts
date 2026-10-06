#!/usr/bin/env bun
/**
 * True model-swap adapter for the OpenCode V2 plugin.
 *
 * The V2 plugin API is beta; the `ctx.aisdk.hook("language")` event shape is not
 * fully documented. This module (a) describes the event so we can learn its
 * real shape from a live turn, and (b) applies a best-effort swap when a target
 * provider/model is known. Everything is defensive: on any unexpected shape it
 * returns { ok: false } and the caller no-ops.
 */

export interface SwapProbe {
  eventKeys: string[];
  languageType: string;
  sdkType: string;
  modelType: string;
  hasLanguageModel: boolean;
  hasChat: boolean;
  hasResponses: boolean;
  modelId: string | null;
  modelProvider: string | null;
  optionKeys: string[];
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function keysOf(v: unknown): string[] {
  return v && typeof v === 'object' ? Object.keys(v as object).slice(0, 40) : [];
}

/** Inspect a `ctx.aisdk.hook("language")` event without mutating it. */
export function describeLanguageEvent(event: any): SwapProbe {
  const sdk = event?.sdk;
  const model = event?.model;
  return {
    eventKeys: keysOf(event),
    languageType: typeOf(event?.language),
    sdkType: typeOf(sdk),
    modelType: typeOf(model),
    hasLanguageModel: typeof sdk?.languageModel === 'function',
    hasChat: typeof sdk?.chat === 'function',
    hasResponses: typeof sdk?.responses === 'function',
    modelId: typeof model?.id === 'string' ? model.id : typeof model?.modelID === 'string' ? model.modelID : null,
    modelProvider:
      typeof model?.providerID === 'string' ? model.providerID : typeof model?.provider === 'string' ? model.provider : null,
    optionKeys: keysOf(event?.options)
  };
}

/**
 * Target refs are `provider/model`; the model part may itself contain slashes
 * (e.g. `openrouter/openai/gpt-4o` -> `openai/gpt-4o`).
 */
export function modelIdFromRef(ref: string): string {
  const firstSlash = ref.indexOf('/');
  return firstSlash === -1 ? ref : ref.slice(firstSlash + 1);
}

/**
 * Best-effort swap: replace `event.language` with a language model for
 * `targetRef`, using whatever factory the current sdk exposes.
 *
 * NOTE: this can only reach a model the *current* sdk can build. Swapping
 * across providers will need the target provider's sdk (open question P2).
 */
export function applyModelSwap(event: any, targetRef: string): { ok: boolean; reason: string } {
  const modelId = modelIdFromRef(targetRef);
  const sdk = event?.sdk;
  try {
    if (sdk && typeof sdk.languageModel === 'function') {
      event.language = sdk.languageModel(modelId);
      return { ok: true, reason: `sdk.languageModel(${modelId})` };
    }
    if (sdk && typeof sdk.chat === 'function') {
      event.language = sdk.chat(modelId);
      return { ok: true, reason: `sdk.chat(${modelId})` };
    }
    if (sdk && typeof sdk.responses === 'function') {
      event.language = sdk.responses(modelId);
      return { ok: true, reason: `sdk.responses(${modelId})` };
    }
    return { ok: false, reason: 'sdk exposes no language-model factory (languageModel/chat/responses)' };
  } catch (e: any) {
    return { ok: false, reason: `swap threw: ${e?.message || e}` };
  }
}
