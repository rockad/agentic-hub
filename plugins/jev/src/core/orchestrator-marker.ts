/**
 * The Antigravity 1.5.14 Orchestrator marker. From 1.5.14 an Orchestrator turn reports the model the user chose (a planner
 * or an executor id), the same ids a plain `/model` choice reports, so the model id alone cannot tell an Orchestrator
 * conversation from a plain one. Antigravity writes the file `annotations/<conversationId>.pbtxt`, beside the
 * `artifactDirectoryPath` the hooks receive, about 70 ms before the first PreInvocation of every Orchestrator conversation,
 * and the file holds the field `plan_execute:true` (outside any quoted string, so a title that mentions it does not count).
 * A plain conversation never has it.
 *
 * The read is small, bounded and fail-soft (src/core/safe-read.ts: a regular file only, never blocks on a FIFO, size cap):
 * any problem (no such file, not a regular file, over the cap, unreadable, a malformed path or id) means "not detected", and
 * the caller falls back to the legacy id rules.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { readRegularFile } from './safe-read.js';

/** The largest annotation file that is read. Anything bigger is treated as "not detected". */
export const ORCHESTRATOR_ANNOTATION_MAX_BYTES = 256 * 1024;

/** A quoted string (double or single, with backslash escapes) or a `#` comment: text that is never a field. */
const QUOTED_OR_COMMENT_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|#[^\n]*/g;
/** The field `plan_execute: true` itself: preceded by the start, whitespace, `{`, `,` or `;`, and not a prefix of a longer word. */
const PLAN_EXECUTE_FIELD_RE = /(^|[\s{,;])plan_execute:\s*true(?=\s|$|[},;])/m;
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

/**
 * Does this pbtxt text carry the field `plan_execute: true`? Quoted strings and comments are blanked out first, so a title
 * that merely mentions `plan_execute:true` does not count; the field may sit anywhere on a line (a real file can be the
 * single line `title:"..." plan_execute:true`).
 */
export function hasPlanExecuteField(text: string): boolean {
  return PLAN_EXECUTE_FIELD_RE.test(text.replace(QUOTED_OR_COMMENT_RE, '""'));
}

export type OrchestratorMarkerResult =
  | { kind: 'found' }
  | { kind: 'missing' }
  | { kind: 'unreadable'; message?: string }
  | { kind: 'oversized'; size: number }
  | { kind: 'invalid-path' };

/**
 * Inspect the Antigravity 1.5.14 annotation marker. Returns a detailed result indicating whether the marker
 * was found or why it was unavailable:
 * - `found`: the file exists and holds `plan_execute:true`.
 * - `missing`: the file does not exist (or has no `plan_execute:true`).
 * - `unreadable`: the file exists but cannot be read (directory, FIFO, EACCES, read error).
 * - `oversized`: the file exceeds ORCHESTRATOR_ANNOTATION_MAX_BYTES.
 * - `invalid-path`: the path or conversation id is null or malformed.
 */
export function readOrchestratorMarker(artifactDirectoryPath: unknown, conversationId: unknown): OrchestratorMarkerResult {
  const file = orchestratorAnnotationPath(artifactDirectoryPath, conversationId);
  if (!file) return { kind: 'invalid-path' };
  const read = readRegularFile(file, ORCHESTRATOR_ANNOTATION_MAX_BYTES);
  if (read.kind === 'too-large') {
    return { kind: 'oversized', size: read.size };
  }
  if (read.kind === 'not-regular') {
    try {
      if (!fs.existsSync(file)) return { kind: 'missing' };
    } catch {
      // ignore
    }
    return { kind: 'unreadable', message: 'not a regular file' };
  }
  if (read.kind === 'error') {
    try {
      if (!fs.existsSync(file) || read.message.includes('ENOENT')) {
        return { kind: 'missing' };
      }
    } catch {
      // ignore
    }
    return { kind: 'unreadable', message: read.message };
  }
  return hasPlanExecuteField(read.text) ? { kind: 'found' } : { kind: 'missing' };
}

/** Does the conversation's annotation file say `plan_execute:true`? Never throws. */
export function hasOrchestratorMarker(artifactDirectoryPath: unknown, conversationId: unknown): boolean {
  try {
    return readOrchestratorMarker(artifactDirectoryPath, conversationId).kind === 'found';
  } catch {
    return false;
  }
}
