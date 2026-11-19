/**
 * Strict input schemas for the Jev MCP tools.
 *
 * Every tool declares its input once, as a zod schema built with `strictObject` (next to the tool definition).
 * Two things are derived from it, so they cannot drift:
 *   - the JSON schema advertised to clients (`inputJsonSchema`, below), and
 *   - the check the CallTool handler runs before a handler sees the arguments (`validateToolInput`, validate.ts).
 *
 * Strict means unknown keys are an error. Plain `z.object` (and the SDK's raw-shape `registerTool` path) drops
 * unknown keys silently, so a misspelled field becomes "not provided" and the call succeeds with defaults. Use
 * `strictObject` for every nested object too.
 */
import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

/** An object schema that rejects unknown keys. Use it for every nested object too. */
export function strictObject<S extends z.ZodRawShape>(shape: S) {
  return z.object(shape).strict();
}

export type StrictInputSchema = z.ZodObject<z.ZodRawShape, 'strict'>;

/**
 * The JSON schema a client sees for a tool: converted from the zod schema by the SDK's own converter
 * (no extra dependency), without the `$schema` header. A strict object comes out with `additionalProperties: false`.
 */
export function inputJsonSchema(schema: StrictInputSchema): Tool['inputSchema'] {
  const { $schema: _header, ...rest } = toJsonSchemaCompat(schema) as Record<string, unknown>;
  return rest as Tool['inputSchema'];
}

/**
 * The optional `conversationId` argument of jev_dispatch, jev_batch_dispatch, jev_quota and jev_select_model.
 * It is a free string at the schema level (a non-string is rejected); the handlers sanitize it with
 * `safeSessionId` before it reaches the telemetry file as `sessionId`.
 */
export const conversationIdSchema = z
  .string()
  .optional()
  .describe(
    "Optional: the id of the calling conversation. It is sanitized to letters, digits, '_' and '-' and recorded as `sessionId` in the tool's telemetry line, so a caller's own calls can be told apart from another conversation's. Omitted, the line records a null sessionId."
  );
