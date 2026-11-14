/**
 * Zero-Network Local Complexity Heuristic Pre-Filter
 * Evaluated before remote decision calls to instantly resolve trivial mechanical tasks (<40 tokens)
 * or establish code density floors.
 */
export function evaluateLocalHeuristic(text: string): { route?: string; tier?: string; effort?: string } | null {
  const trimmed = text.trim();
  const tokenEst = Math.ceil(trimmed.length / 4);

  // Very short mechanical tasks (<40 tokens) matching routine transformation patterns
  if (tokenEst < 40) {
    // Bare "format" is not enough ("dump format"); isFormattingTask lists the forms that count.
    const isFormatting =
      /\b(indent|organize imports|sort|prettier|clean whitespace|tabs to spaces)\b/i.test(trimmed) ||
      isFormattingTask(trimmed);
    const isBoilerplate = /\b(scaffold boilerplate|empty template|stub function|skeleton)\b/i.test(trimmed);
    if (isFormatting || isBoilerplate) {
      return {
        route: 'openrouter_free',
        tier: 'openrouter_free',
        effort: 'low'
      };
    }
  }
  return null;
}

/**
 * Local Deterministic Quality Gate (Tier 3 Fallback for jev_judge).
 * Evaluates syntax, git conflict markers, compilation exit codes, and non-empty assertions
 * locally without calling remote LLM endpoints when OpenRouter is unreachable or returns 404.
 */
export function evaluateLocalQualityJudge(context: string, condition?: string): { passed: boolean; reason: string } {
  const ctx = context || '';

  // 1. Conflict marker validation
  if (ctx.includes('<<<<<<<') || ctx.includes('=======') || ctx.includes('>>>>>>>')) {
    return { passed: false, reason: 'Detected unresolved merge conflict markers in diff/output.' };
  }

  // 2. Non-empty check
  if (ctx.trim().length === 0) {
    return { passed: false, reason: 'Context is empty.' };
  }

  // 3. Test/Process exit code check
  if (ctx.includes('exit code: 1') || ctx.includes('exited with code 1') || ctx.includes('FAILED') || ctx.includes('FAIL:')) {
    if (!condition?.toLowerCase().includes('fail')) {
      return { passed: false, reason: 'Detected non-zero exit code or failure in test execution output.' };
    }
  }

  // 4. Broken JSON / syntax check if condition mentions JSON or valid format
  if (condition?.toLowerCase().includes('valid json')) {
    try {
      JSON.parse(ctx);
    } catch (e: any) {
      return { passed: false, reason: `Invalid JSON syntax: ${e.message}` };
    }
  }

  return { passed: true, reason: 'Local deterministic sanity checks passed.' };
}

/**
 * Scaffolding Detection Heuristic.
 * Detects whether a task involves new package/crate/component generation,
 * signaling that mechanical boilerplate (Cargo.toml, package.json, CLI clap structs)
 * should be offloaded to Tier 0 ($0.00 via jev_execute_free) before spawning paid workers.
 */
export function detectScaffoldingTask(taskText: string): { scaffoldFirst: boolean; boilerplateType: string | null } {
  const text = (taskText || '').toLowerCase();
  if (
    text.includes('cargo.toml') ||
    text.includes('package.json') ||
    /\bscaffold(?:s|ed|ing)?\b/.test(text) ||
    text.includes('create crate') ||
    text.includes('new crate') ||
    /\bboilerplate\b/.test(text) ||
    text.includes('clap struct')
  ) {
    let bpType = 'boilerplate';
    if (text.includes('cargo') || text.includes('rust') || text.includes('crate')) bpType = 'rust_crate';
    else if (text.includes('package.json') || text.includes('bun') || text.includes('node')) bpType = 'node_package';
    return { scaffoldFirst: true, boilerplateType: bpType };
  }
  return { scaffoldFirst: false, boilerplateType: null };
}

/**
 * Free-tier keyword rule for batch dispatch (whole words and a small documented phrase list).
 *
 * The old rule used substring `includes('format')`, which also fired on "information",
 * "transformation" and on "format" used as a noun ("apply a dump format decision").
 * The keyword here means formatting WORK, so the bare word "format" is deliberately not
 * enough: only these forms count.
 *   - scaffold, scaffolds, scaffolded, scaffolding
 *   - boilerplate
 *   - formatting, reformat, reformats, reformatted, reformatting, auto-format
 *   - "format" followed by an object word: the, this, these, those, all, every, each, my, our,
 *     code, file, files, json, yaml, markdown
 */
const FORMATTING_PATTERNS: ReadonlyArray<RegExp> = [
  /\bformatting\b/i,
  /\b(?:re|auto-)format(?:s|ted|ting)?\b/i,
  /\bformat\s+(?:the|this|these|those|all|every|each|my|our|code|files?|json|yaml|markdown)\b/i
];

const SCAFFOLD_PATTERNS: ReadonlyArray<RegExp> = [/\bscaffold(?:s|ed|ing)?\b/i, /\bboilerplate\b/i];

/** Formatting work only (the formatting forms above), for the effort heuristic and the local pre-filter. */
export function isFormattingTask(taskText: string): boolean {
  const text = taskText || '';
  return FORMATTING_PATTERNS.some((p) => p.test(text));
}

export function isFreeTierMechanicalTask(taskText: string): boolean {
  const text = taskText || '';
  return SCAFFOLD_PATTERNS.some((p) => p.test(text)) || isFormattingTask(text);
}

/** Claude Code subagent types that cannot edit files (no Edit or Write tool). */
export const READ_ONLY_SUBAGENTS: ReadonlySet<string> = new Set(['plan', 'explore']);

export function isReadOnlySubagent(name: string): boolean {
  return READ_ONLY_SUBAGENTS.has((name || '').trim().toLowerCase());
}

/**
 * True when the task text asks for a change to files. Deliberately narrow: clear editing verbs only,
 * in their imperative, third-person and gerund forms. Not "review", "check", "find", "explain",
 * "commit" or "port", which are as often about reading as about writing. "remove", "modify", "patch",
 * "amend" and "create" stay edit verbs, safe because a Claude Code batch stage can now override the
 * wording with `needsEdit: false`: "create" only with a file-like object ("Create a picture of the flow" is not an edit), and "patch" only as a verb
 * ("how the patch works" is not).
 */
const EDIT_VERB =
  /\b(?:edit|edits|editing|implement|implements|implementing|fix|fixes|fixing|refactor|refactors|refactoring|write|writes|writing|rewrite|rewrites|rewriting|add|adds|adding|update|updates|updating|rename|renames|renaming|migrate|migrates|migrating|delete|deletes|deleting|apply|applies|applying|remove|removes|removing|modify|modifies|modifying|amend|amends|amending|(?<!\b(?:the|a|an|this|that|these|those|its|my|our)\s+)patch(?:es|ing)?|creat(?:e|es|ing)\s+(?:an?\s+|the\s+|new\s+|another\s+)*(?:new\s+)?(?:files?|modules?|tests?|scripts?|docs?|documents?|directory|folder|class|function|config|component|readme|section|entry|note|tasklist))\b/i;

/**
 * "format", "reformat" and "insert" are edits only when the task also names a file-like object (FILE_LIKE):
 * "Format this paragraph as bullet points" and "Insert a joke into the story" are text work, while
 * "Reformat the table in docs/x.md" and "Format the JSON config" change a file. A noun "format" ("the output
 * format", "dump format", "JSON format") is not the verb.
 */
const FILE_EDIT_VERB =
  /\b(?:(?<!\b(?:the|a|an|this|that|these|those|its|my|our|output|dump|file|data|json|yaml|markdown|new|same|default|which|what)\s+)formats?|formatting|reformat(?:s|ting)?|inserts?|inserting)\b/i;

/**
 * A path, a name with a known extension, or one of the nouns file, files, config. A bare "a/b" is not a path
 * ("and/or"): it needs a leading ./ ../ ~/ or /, two slashes, a well-known top-level directory, or an extension.
 */
const FILE_LIKE =
  /(?:\b[\w-]+\.(?:md|markdown|json|jsonc|ya?ml|toml|ini|txt|csv|tsx?|jsx?|mjs|cjs|py|sh|rs|go|css|html?|xml|sql)\b|(?:^|\s)(?:\.{1,2}|~)?\/[\w.-]+|\b[\w-]+\/[\w.-]+\/[\w.-]+|\b(?:src|docs|lib|plugins|tests|scripts|skills|rules|claude)\/[\w.-]+|\bfiles?\b|\bconfigs?\b|\bconfiguration\b)/i;

/** "no edits", "without writing", "do not update": the verb is named to rule it out. */
const NEGATED_EDIT = /\b(?:no|not|never|without|don'?t|avoid)\s+(?:\w+\s+)?$/i;

export function taskNeedsEdit(taskText: string): boolean {
  // A typographic apostrophe is an apostrophe: "Don’t update the files" is the same negation as "Don't".
  const text = (taskText || '').replace(/[‘’ʼ]/g, "'");
  const verbs = [new RegExp(EDIT_VERB.source, 'gi')];
  if (FILE_LIKE.test(text)) verbs.push(new RegExp(FILE_EDIT_VERB.source, 'gi'));
  for (const verb of verbs) {
    for (const m of text.matchAll(verb)) {
      if (!NEGATED_EDIT.test(text.slice(Math.max(0, m.index! - 20), m.index!))) return true;
    }
  }
  return false;
}

/** Read-only personas never get an editing task: fall back to the named editing-capable agent. */
export function editCapableSubagent(subagent: string, taskText: string, fallback: string): string {
  return isReadOnlySubagent(subagent) && taskNeedsEdit(taskText) ? fallback : subagent;
}
