/**
 * The Antigravity 1.5.14 Orchestrator marker. From 1.5.14 an Orchestrator turn reports the model the user chose (a planner
 * or an executor id), the same ids a plain `/model` choice reports, so the model id alone cannot tell an Orchestrator
 * conversation from a plain one. Antigravity writes the file `annotations/<conversationId>.pbtxt`, beside the
 * `artifactDirectoryPath` the hooks receive, about 70 ms before the first PreInvocation of every Orchestrator conversation,
 * and the file holds `plan_execute:true`. A plain conversation never has it.
 *
 * The read is small, bounded and fail-soft (src/core/safe-read.ts: a regular file only, never blocks on a FIFO, size cap):
 * any problem (no such file, not a regular file, over the cap, unreadable, a malformed path or id) means "not detected", and
 * the caller falls back to the legacy id rules.
 */
import * as path from 'node:path';
import { readRegularFile } from './safe-read.js';

/** The largest annotation file that is read. Anything bigger is treated as "not detected". */
export const ORCHESTRATOR_ANNOTATION_MAX_BYTES = 256 * 1024;

const PLAN_EXECUTE_RE = /\bplan_execute:\s*true\b/;
const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PATH_CHARS = 4096;

/** `<artifactDirectoryPath>/../../annotations/<conversationId>.pbtxt`, or null when either input is not usable. */
export function orchestratorAnnotationPath(artifactDirectoryPath: unknown, conversationId: unknown): string | null {
  if (typeof artifactDirectoryPath !== 'string' || typeof conversationId !== 'string') return null;
  if (artifactDirectoryPath.length === 0 || artifactDirectoryPath.length > MAX_PATH_CHARS) return null;
  if (artifactDirectoryPath.includes('\0') || !path.isAbsolute(artifactDirectoryPath)) return null;
  if (!SAFE_CONVERSATION_ID_RE.test(conversationId) || conversationId.includes('..')) return null;
  return path.resolve(artifactDirectoryPath, '..', '..', 'annotations', `${conversationId}.pbtxt`);
}

/** Does the conversation's annotation file say `plan_execute:true`? Never throws. */
export function hasOrchestratorMarker(artifactDirectoryPath: unknown, conversationId: unknown): boolean {
  try {
    const file = orchestratorAnnotationPath(artifactDirectoryPath, conversationId);
    if (!file) return false;
    const read = readRegularFile(file, ORCHESTRATOR_ANNOTATION_MAX_BYTES);
    return read.kind === 'ok' && PLAN_EXECUTE_RE.test(read.text);
  } catch {
    return false;
  }
}
