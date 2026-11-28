#!/usr/bin/env node
/**
 * clarify-labels.mjs - keep the option letters and names of a clarify question the same in the
 * printed prose (`### Option A. <name>`) and in the question tool's dialog (`Option A: <name>`)
 * (issue #123).
 *
 * The failure: the prose is written first, the recommendation changes while "Your reading" is
 * drafted, and the dialog is relabelled to fit the naming rule (Option A is the recommended one)
 * while the printed headings stay as they were. The user then answers "Option B" in the dialog
 * and means something else than "Option B" in the prose.
 *
 * What can be checked, and where:
 *   - Dialog only (every harness): the labels must be `Option A:`, `Option B:`, ... in order, and
 *     the recommended option must be A. Needs no transcript.
 *   - Dialog against prose (Antigravity): Antigravity writes the reply to the transcript before a
 *     PreToolUse hook runs, so the hook can compare the printed headings with the labels.
 *     Claude Code writes the current turn to the transcript only after PreToolUse hooks finish
 *     (measured), so there it is checked offline by scripts/check-clarify-transcript.sh.
 *
 * Modes (stdin is the hook payload JSON):
 *   claude-pre   Claude Code PreToolUse on AskUserQuestion: dialog rules, deny on a violation.
 *   agy-pre      Antigravity PreToolUse on ask_question: dialog rules plus prose against dialog.
 *
 * Both fail open and deny at most twice per question number and conversation, so a model that
 * ignores the message cannot loop. Antigravity quirk (jev/antigravity/hook.ts): a PreToolUse
 * hook that prints `{}` is treated as a DENIAL; the pass-through is empty stdout and exit 0.
 */

import { readFileSync, appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { outsideFences } from "./clarify-common.mjs";

const MAX_DENIALS = 2;
const QTAG_RE = /^\s*\[\s*(?:Question|Fork)\s+(\d+)\s+of\s+(\d+)\s*\]/i;
const DIALOG_LABEL_RE = /^\s*(?:\d+\.\s*)?(\(Recommended\)\s*)?Option\s+([A-Z])\s*:\s*(.*?)\s*(\(Recommended\))?\s*$/i;
const PROSE_HEADING_RE = /^\s*#{2,4}\s*Option\s+([A-Z])\s*[.:)\-—–]\s*(.*?)\s*$/i;
const RECOMMENDATION_RE = /\*\*\s*Recommendation:?\s*\*\*:?\s*(?:\*\*)?\s*Option\s+([A-Z])\b/i;
const QUESTION_HEADING_RE = /^\s*#{2,}\s*Question\s+\d+/i;
const STOPWORDS = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "with", "by", "is", "as", "at", "it"]);

function str(v) {
  return typeof v === "string" ? v : "";
}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Lowercased content words of a name, without the recommended marker. */
function words(name) {
  const cleaned = str(name).replace(/\(\s*recommended\s*\)/gi, " ").toLowerCase();
  const out = new Set();
  for (const w of cleaned.split(/[^a-z0-9]+/)) {
    if (w.length >= 2 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** Jaccard similarity of two word sets: |A and B| / |A or B|. 0 when either is empty. */
export function similarity(a, b) {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / (wa.size + wb.size - shared);
}

/**
 * Parse the option labels of a question tool call. Accepts strings (Antigravity) and objects
 * with a `label` (Claude Code). Returns `{ raw, letter, name, recommended }` per option;
 * `letter` is null when the label has no `Option X:` prefix.
 */
export function parseDialogOptions(options) {
  const list = Array.isArray(options) ? options : [];
  return list.map((o) => {
    const raw = typeof o === "string" ? o : isObj(o) ? str(o.label) : "";
    const m = DIALOG_LABEL_RE.exec(raw);
    if (!m) return { raw, letter: null, name: raw.trim(), recommended: /\(\s*recommended\s*\)/i.test(raw) };
    return { raw, letter: m[2].toUpperCase(), name: m[3].trim(), recommended: Boolean(m[1] || m[4]) };
  });
}

/**
 * Parse the printed step of the current question: the `### Option X. <name>` headings after the
 * last `## Question N` heading (a reprinted step supersedes an earlier one; the last heading for
 * a letter wins), and the letter named by the last `**Recommendation:** **Option X` line.
 * Returns `{ options: [{ letter, name, recommended }], recommendedLetter }`.
 */
export function parseProse(text) {
  const lines = outsideFences(str(text));
  let from = 0;
  for (let i = 0; i < lines.length; i++) if (QUESTION_HEADING_RE.test(lines[i])) from = i + 1;
  const byLetter = new Map();
  let recLetter = null;
  for (let i = from; i < lines.length; i++) {
    const h = PROSE_HEADING_RE.exec(lines[i]);
    if (h) {
      const letter = h[1].toUpperCase();
      const name = h[2].trim();
      byLetter.set(letter, { letter, name, recommended: /\(\s*recommended\s*\)/i.test(name) });
      continue;
    }
    const r = RECOMMENDATION_RE.exec(lines[i]);
    if (r) recLetter = r[1].toUpperCase();
  }
  const options = [...byLetter.values()].sort((a, b) => a.letter.localeCompare(b.letter));
  const headingRec = options.find((o) => o.recommended);
  return { options, recommendedLetter: recLetter ?? (headingRec ? headingRec.letter : null) };
}

/**
 * Problems with the dialog labels alone. Empty array when they follow the naming rule.
 */
export function checkDialog(dialog) {
  const why = [];
  if (dialog.length < 2) return why;
  const letters = dialog.map((d) => d.letter);
  if (letters.some((l) => l === null)) {
    const bad = dialog.find((d) => d.letter === null);
    why.push(`label "${bad.raw.slice(0, 50)}" has no "Option X:" prefix`);
    return why;
  }
  const expected = letters.map((_, i) => String.fromCharCode(65 + i));
  if (letters.join("") !== expected.join("")) {
    why.push(`option letters are ${letters.join(", ")}, expected ${expected.join(", ")} in order`);
  }
  const rec = dialog.filter((d) => d.recommended).map((d) => d.letter);
  // No marker at all is not flagged here (the skill asks for one, but that is not this check).
  if (rec.length > 1) why.push(`options ${rec.join(" and ")} are all marked (Recommended); only Option A may be`);
  else if (rec.length === 1 && rec[0] !== "A") why.push(`Option ${rec[0]} is marked (Recommended); the recommended option must be Option A`);
  return why;
}

/**
 * Problems between the printed step and the dialog. Empty array when they agree or when the prose
 * carries no option headings (nothing to compare).
 */
export function checkAgainstProse(dialog, prose) {
  const why = [];
  const po = prose.options;
  if (po.length === 0 || dialog.some((d) => d.letter === null)) return why;
  const dl = dialog.map((d) => d.letter).join("");
  const pl = po.map((o) => o.letter).join("");
  if (dl !== pl) {
    why.push(`the printed headings list Option ${po.map((o) => o.letter).join(", ")} but the dialog has Option ${dialog.map((d) => d.letter).join(", ")}`);
  }
  const dialogRec = dialog.find((d) => d.recommended)?.letter ?? null;
  if (prose.recommendedLetter !== null && dialogRec !== null && prose.recommendedLetter !== dialogRec) {
    why.push(`the printed step recommends Option ${prose.recommendedLetter} but the dialog marks Option ${dialogRec} (Recommended)`);
  }
  if (prose.recommendedLetter !== null && prose.recommendedLetter !== "A") {
    why.push(`the printed step recommends Option ${prose.recommendedLetter}; the recommended option must be Option A, so reorder and reprint the headings`);
  }
  // Same letter, different option: for each dialog name, a printed heading with another letter
  // fits clearly better than the heading with the same letter.
  for (const d of dialog) {
    const same = po.find((o) => o.letter === d.letter);
    if (!same) continue;
    const own = similarity(d.name, same.name);
    for (const o of po) {
      if (o.letter === d.letter) continue;
      const other = similarity(d.name, o.name);
      if (other >= 0.5 && other >= own + 0.3) {
        why.push(`dialog Option ${d.letter} ("${d.name.slice(0, 40)}") matches the printed Option ${o.letter} ("${o.name.slice(0, 40)}"), not the printed Option ${d.letter}`);
        break;
      }
    }
  }
  return why;
}

/** All problems for one question call. `proseText` may be empty (dialog-only check). */
export function checkQuestion(options, proseText) {
  const dialog = parseDialogOptions(options);
  const why = checkDialog(dialog);
  // A reply cut by the compact transcript form (`<truncated N bytes>`) has lost headings: not judged.
  if (why.length === 0 && proseText && !/\n<truncated \d+ bytes>/.test(proseText)) why.push(...checkAgainstProse(dialog, parseProse(proseText)));
  return why;
}

/** The deny message, naming what is wrong and what to do about it. */
export function denyMessage(n, why) {
  return (
    `clarify: the option labels of Question ${n} need fixing: ${why.join("; ")}. ` +
    "Decide the recommendation first so Option A is the recommended one, then make the printed " +
    "`### Option X.` headings and the dialog labels match letter for letter. If the labels change " +
    "now, reprint the full step with the corrected headings, then call the question tool again " +
    "(the question text stays the same); never relabel only in the dialog."
  );
}

function questionTag(question) {
  const m = QTAG_RE.exec(str(question));
  return m ? { n: Number(m[1]), m: Number(m[2]) } : null;
}

/** Deny at most MAX_DENIALS times per conversation and question number. */
function denialBudgetLeft(id, n) {
  const dir = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || process.env.TMPDIR || tmpdir();
  const safe = String(id || "nosession").replace(/[^A-Za-z0-9_.-]/g, "_");
  const file = join(dir, `clarify-labels-${safe}.deny`);
  let used = 0;
  try {
    used = readFileSync(file, "utf8").split("\n").filter((l) => l === String(n)).length;
  } catch {
    used = 0;
  }
  if (used >= MAX_DENIALS) return false;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${n}\n`);
  } catch {
    return false;
  }
  return true;
}

function parseJsonLines(text) {
  const out = [];
  for (const line of str(text).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (isObj(o)) out.push(o);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Printed prose of the current Antigravity reply: PLANNER_RESPONSE contents since the last user
 * input or answered question (Antigravity flushes the reply before PreToolUse runs).
 */
export function antigravityProse(transcriptText) {
  const events = parseJsonLines(transcriptText);
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "USER_INPUT" || (e.type === "GENERIC" && /(?:^|\n)A\d+:/.test(str(e.content)))) {
      start = i + 1;
      break;
    }
  }
  return events
    .slice(start)
    .filter((e) => e.type === "PLANNER_RESPONSE")
    .map((e) => str(e.content))
    .join("\n");
}

function questionsOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Offline check of a Claude Code transcript: for each AskUserQuestion call tagged
 * `[Question N of M]`, compare the labels with the prose printed since the last user entry.
 * A call that a hook denied is skipped (the retry is judged instead). Returns
 * `{ lines, failed }` with one `FAIL ...` line per call that has a label problem.
 */
export function checkClaudeTranscriptLabels(transcriptText) {
  const lines = [];
  let failed = 0;
  let text = "";
  let pending = null;
  let n = 0;
  const settle = (denied) => {
    if (pending === null) return;
    if (!denied) {
      const why = checkQuestion(pending.options, text);
      if (why.length > 0) {
        failed += 1;
        lines.push(`FAIL Fork ${pending.n}/${pending.m}: option labels: ${why.join("; ")} (line ${pending.line})`);
      }
    }
    pending = null;
  };
  for (const e of parseJsonLines(transcriptText)) {
    n += 1;
    if (e.type === "user") {
      const content = Array.isArray(e.message?.content) ? e.message.content : [];
      const denied = content.some(
        (c) => isObj(c) && c.type === "tool_result" && /hook error: clarify/.test(typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "")),
      );
      settle(denied);
      if (!denied) text = "";
    } else if (e.type === "assistant") {
      const content = Array.isArray(e.message?.content) ? e.message.content : [];
      for (const c of content) {
        if (!isObj(c)) continue;
        if (c.type === "text") text += `${str(c.text)}\n`;
        else if (c.type === "tool_use" && c.name === "AskUserQuestion") {
          const q = questionsOf(c.input?.questions)[0];
          const tag = questionTag(q?.question);
          if (tag) pending = { n: tag.n, m: tag.m, options: q.options, line: n };
        }
      }
    }
  }
  settle(false);
  return { lines, failed };
}

/**
 * Offline check of an Antigravity transcript: for each tagged `ask_question` call, compare the
 * labels with the prose printed since the last user input or answered question.
 * Returns `{ lines, failed }` like checkClaudeTranscriptLabels.
 */
export function checkAntigravityTranscriptLabels(transcriptText) {
  const lines = [];
  let failed = 0;
  let text = "";
  let step = 0;
  for (const e of parseJsonLines(transcriptText)) {
    step += 1;
    if (e.type === "USER_INPUT" || (e.type === "GENERIC" && /(?:^|\n)A\d+:/.test(str(e.content)))) {
      text = "";
    } else if (e.type === "PLANNER_RESPONSE") {
      text += `${str(e.content)}\n`;
      for (const tc of Array.isArray(e.tool_calls) ? e.tool_calls : []) {
        if (!isObj(tc) || tc.name !== "ask_question") continue;
        const q = questionsOf(tc.args?.questions)[0];
        const tag = questionTag(q?.question);
        if (!tag) continue;
        const why = checkQuestion(q.options, text);
        if (why.length > 0) {
          failed += 1;
          lines.push(`FAIL Question ${tag.n}/${tag.m}: option labels: ${why.join("; ")} (step ${step})`);
        }
        text = "";
      }
    }
  }
  return { lines, failed };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function emitDenyClaude(reason) {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n`,
  );
}

async function runHook(mode) {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // fail open: empty stdout, exit 0
  }
  if (!isObj(payload)) return;

  const claude = mode === "claude-pre";
  const q = claude ? questionsOf(payload.tool_input?.questions)[0] : questionsOf(payload.toolCall?.args?.questions)[0];
  const tag = questionTag(q?.question);
  if (!tag) return; // not a clarify question
  const id = claude ? payload.session_id : payload.conversationId;

  let prose = "";
  if (!claude) {
    const tp = str(payload.transcriptPath) || str(payload.transcript_path);
    if (tp) {
      try {
        prose = antigravityProse(readFileSync(tp, "utf8"));
      } catch {
        prose = "";
      }
    }
  }

  const why = checkQuestion(q.options, prose);
  if (why.length === 0) return;
  if (!denialBudgetLeft(id, tag.n)) return;
  const reason = denyMessage(tag.n, why);
  if (claude) emitDenyClaude(reason);
  else process.stdout.write(`${JSON.stringify({ decision: "deny", reason })}\n`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [mode, arg] = process.argv.slice(2);
  if (mode === "claude-pre" || mode === "agy-pre") {
    try {
      await runHook(mode);
    } catch {
      /* fail open */
    }
    process.exit(0);
  } else if ((mode === "--check-claude" || mode === "--check-agy") && arg) {
    try {
      const text = readFileSync(arg, "utf8");
      const res = mode === "--check-agy" ? checkAntigravityTranscriptLabels(text) : checkClaudeTranscriptLabels(text);
      process.stdout.write([...res.lines, `labelfailed=${res.failed}`].join("\n") + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(3);
    }
  } else {
    process.stderr.write("Usage: clarify-labels.mjs claude-pre|agy-pre < payload.json | --check-claude <transcript.jsonl>\n");
    process.exit(3);
  }
}
