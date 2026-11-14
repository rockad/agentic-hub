/**
 * Call-time validation of tool arguments, in one place: `validateToolInput(name, args)`.
 *
 * The CallTool handler (src/server.ts) runs it before any tool handler. The handlers cast `args as {...}`
 * and used to run on whatever arrived: a missing required field and any unknown key were accepted, and the
 * planner defaulted what it did not find. Now a call that does not match the tool's strict zod schema (schema.ts,
 * registered in tools/index.ts), or that fails a tool's meaning checks (empty task, duplicate ids, a cycle),
 * comes back as an MCP tool error:
 *
 *   { isError: true, content: [{ type: 'text', text: 'Invalid arguments for tool <name>: <issue>\n<issue>...' }] }
 *
 * One line per issue. A path is appended as ` at tasks[0].task`. An unknown key also gets a "did you mean" line
 * when the schema has a key close to it at that level.
 */
import { z } from 'zod';
import { toolInputSchemas, toolInputChecks } from './index.js';

export type ToolErrorResult = { isError: true; content: Array<{ type: 'text'; text: string }> };
export type ValidatedInput = { ok: true; data: unknown } | { ok: false; result: ToolErrorResult };

/** Known wrong names for a field. Applied only where the schema has the right name at that level. */
export const KEY_ALIASES: Readonly<Record<string, string>> = {
  description: 'task',
  dependsOn: 'dependencies'
};

const MAX_EDIT_DISTANCE = 2;

export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function formatPath(path: Array<string | number>): string {
  return path.reduce<string>((out, seg) => (typeof seg === 'number' ? `${out}[${seg}]` : out ? `${out}.${seg}` : seg), '');
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema;
  while (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault) s = s._def.innerType;
  return s;
}

/** The schema at a path inside a tool's input, or undefined. */
function schemaAt(root: z.ZodTypeAny, path: Array<string | number>): z.ZodTypeAny | undefined {
  let s: z.ZodTypeAny | undefined = root;
  for (const seg of path) {
    if (!s) return undefined;
    const node: z.ZodTypeAny = unwrap(s);
    if (node instanceof z.ZodObject) s = (node.shape as z.ZodRawShape)[String(seg)];
    else if (node instanceof z.ZodArray) s = node.element;
    else return undefined;
  }
  return s;
}

function valueAt(root: unknown, path: Array<string | number>): Record<string, unknown> {
  let v: any = root;
  for (const seg of path) v = v?.[seg];
  return v && typeof v === 'object' ? v : {};
}

/** The key to suggest for an unknown key: the alias map first, then the nearest schema key (distance <= 2). */
function suggestKey(unknown: string, schemaKeys: string[], present: Record<string, unknown>): string | undefined {
  const free = schemaKeys.filter((k) => !(k in present));
  const alias = Object.hasOwn(KEY_ALIASES, unknown) ? KEY_ALIASES[unknown] : undefined;
  if (alias && free.includes(alias)) return alias;
  let best: { key: string; d: number } | undefined;
  for (const key of free) {
    const d = editDistance(unknown, key);
    // The distance must also stay below the shorter key's length, so `x` never "means" `id`.
    if (d <= MAX_EDIT_DISTANCE && d < Math.min(unknown.length, key.length) && (!best || d < best.d)) best = { key, d };
  }
  return best?.key;
}

function zodIssueLines(schema: z.ZodTypeAny, input: unknown, error: z.ZodError): string[] {
  const lines: string[] = [];
  for (const issue of error.issues) {
    const path = formatPath(issue.path);
    const at = path ? ` at ${path}` : '';
    lines.push(`${issue.message}${at}`);
    if (issue.code !== 'unrecognized_keys') continue;
    const level = schemaAt(schema, issue.path);
    const node = level && unwrap(level);
    if (!(node instanceof z.ZodObject)) continue;
    const present = valueAt(input, issue.path);
    for (const key of issue.keys) {
      const hint = suggestKey(key, Object.keys(node.shape), present);
      if (hint) lines.push(`Unrecognized key '${key}'${at}; did you mean '${hint}'?`);
    }
  }
  return lines;
}

function invalid(name: string, lines: string[]): ValidatedInput {
  return { ok: false, result: { isError: true, content: [{ type: 'text', text: `Invalid arguments for tool ${name}: ${lines.join('\n')}` }] } };
}

/**
 * Check a call's arguments against the tool's strict schema, then against its meaning checks. Absent arguments
 * count as `{}` (the argument-less tools are called that way). `name` must be a registered tool: the caller
 * looks the handler up first, so an unknown tool never reaches here.
 */
export function validateToolInput(name: string, args: unknown): ValidatedInput {
  const schema = toolInputSchemas[name];
  if (!schema) throw new Error(`No input schema registered for tool: ${name}`);
  const input = args === undefined ? {} : args;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return invalid(name, zodIssueLines(schema, input, parsed.error));
  const meaning = toolInputChecks[name]?.(parsed.data) ?? [];
  if (meaning.length > 0) return invalid(name, meaning);
  return { ok: true, data: parsed.data };
}
