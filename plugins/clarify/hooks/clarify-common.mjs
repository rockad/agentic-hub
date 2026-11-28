#!/usr/bin/env node
/**
 * clarify-common.mjs - Shared Antigravity transcript parser, Stop hook evaluator,
 * and transcript checker for the `clarify` skill.
 *
 * Zero external dependencies (Node 18+ / 26 built-ins only).
 */

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CLARIFY_CMD_RE =
  /(?:^|(?<=[\s>\[('"`]))\/(clarify|grill-me|cplain|celi5)(?:$|(?=[\s.,;:!?<)\]'`"]))/i;

const HEADING_RE =
  /^##[ \t]*Question[ \t]+(\d+)(?:[ \t]*\(of[ \t]*(\d+)\)|[ \t]*([—–\-(]))/;

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

const TRIGGER_RE = /Target resolved:|(Decomposing into|Identified) \d+ orthogonal/;

const DECISION_TABLE_RE =
  /^(>[ \t]*)?(#{1,4}|\*\*)[^A-Za-z]*(final[ \t]+)?decisions?[ \t]+table/i;

const REVISED_TOTAL_RE = /Fork map revised:\s*\d+\s*(?:→|->)\s*(\d+)/;

const ASK_TAG_RE = /\[\s*(?:Question|Fork)\s+(\d+)\s+of\s+(\d+)\s*\]/i;
const QTAG_RE = /^\s*\[\s*(Question|Fork)\s+(\d+)\s+of\s+(\d+)\s*\]/i;

const USER_REQ_RE =
  /<USER_REQUEST>\s*([\s\S]*?)(?:\s*<\/USER_REQUEST>|\n<truncated )/;

const ANSWER_LINE_RE = /^A\d+:[ \t]*([^\n]*)/;
const HAS_ANSWER_RE = /(?:^|\n)A\d+:[ \t]*/;

const ABANDON_PHRASE_RE =
  /^(?:(?:ok|okay|no|hmm|actually|wait|sorry|please|hey)[,.!:]?\s+)*(?:forget (?:that|it|this|about it|all that)|never ?mind|cancel(?: (?:that|it|this|clarify|the (?:clarify|interview|questions)))?|abort(?: (?:that|it|this|clarify|the (?:clarify|interview|questions)))?|stop(?: (?:asking|this|it|clarify|the (?:clarify|interview|questions)))?|let.?s stop(?: (?:here|this|now))?|i.?m done(?: (?:here|with this))?|that.?s enough|no more questions|(?:skip|exit|quit|leave|abandon) (?:clarify|the (?:clarify|interview|questions)|this))(?:\s*$|\s*[.!;]|\s*,\s*(?:and |then |please |let.?s |now |instead |just |write |give |show |tell |make |can you |could you |i want |i.?d )|\s+(?:and|then|please|now|instead)\b)/;

const SLASH_CMD_RE = /^\/[a-z][a-z0-9:_-]*(?:\s|$)/;

const OPTION_PREFIX_RE = /^\s*(?:\(Recommended\)\s+)?Option\s+[A-Z]\s*:/;

const PROSE_OPTION_RE = /^#{2,6}[ \t]*Option[ \t]+([A-Z])[.:][ \t]+(.*)$/;
const PICKER_OPTION_RE = /^\s*(?:\(Recommended\)\s+)?Option\s+([A-Z])\s*:\s*(.*)$/;

function str(v) {
  return typeof v === "string" ? v : "";
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Case-insensitive match for `/(clarify|grill-me|cplain|celi5)` with boundary rules.
 */
export function clarifyCmd(text) {
  return typeof text === "string" && CLARIFY_CMD_RE.test(text);
}

/**
 * Lines of a reply outside CommonMark fenced code blocks (O(n) single pass).
 */
export function outsideFences(text) {
  if (typeof text !== "string") return [];
  const rawLines = text.split("\n");
  const out = [];
  let open = null;
  for (let i = 0; i < rawLines.length; i++) {
    let l = rawLines[i];
    if (l.endsWith("\r")) l = l.slice(0, -1);
    if (open === null) {
      const m = FENCE_OPEN_RE.exec(l);
      if (m && (m[1][0] === "~" || !m[2].includes("`"))) {
        open = { c: m[1][0], n: m[1].length };
      } else {
        out.push(l);
      }
    } else {
      const m = FENCE_CLOSE_RE.exec(l);
      if (m && m[1][0] === open.c && m[1].length >= open.n) {
        open = null;
      }
    }
  }
  return out;
}

/**
 * Match `## Question N (of M)` or `## Question N — ...` headings.
 */
export function headingMatch(line) {
  if (typeof line !== "string") return null;
  const l = line.endsWith("\r") ? line.slice(0, -1) : line;
  const m = HEADING_RE.exec(l);
  if (!m) return null;
  if (m[2] === undefined && m[3] === undefined) return null;
  return {
    n: Number(m[1]),
    m: m[2] !== undefined ? Number(m[2]) : null,
  };
}

/**
 * Detect Turn-1 target resolution or orthogonal fork-map trigger lines.
 */
export function hasTrigger(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if ((l.includes("Target resolved:") || l.includes("orthogonal")) && TRIGGER_RE.test(l)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract all `## Question N ...` headings from prefiltered lines.
 */
export function allHeadings(lines) {
  const res = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("##") && l.includes("Question")) {
      const h = headingMatch(l);
      if (h !== null) res.push(h);
    }
  }
  return res;
}

/**
 * Detect a Decision Table heading, testing at most 100 prefiltered candidate lines.
 */
export function decisionTable(lines) {
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("#") || l.startsWith("*") || l.startsWith(">")) {
      const lower = l.toLowerCase();
      if (lower.includes("decision") && lower.includes("table")) {
        if (DECISION_TABLE_RE.test(l)) return true;
        count++;
        if (count >= 100) break;
      }
    }
  }
  return false;
}

/**
 * Detect the closing Gated Execution section heading.
 */
export function closingSections(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("#") && l.includes("Gated Execution")) return true;
  }
  return false;
}

/**
 * Extract the last `Fork map revised: N -> M` total, or null.
 */
export function revisedTotal(lines) {
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes("Fork map revised")) {
      const m = REVISED_TOTAL_RE.exec(l);
      if (m) last = Number(m[1]);
    }
  }
  return last;
}

/**
 * Extract `[Question N of M]` / `[Fork N of M]` tags from `ask_question` tool_calls.
 */
export function askTags(entry) {
  const tcs = Array.isArray(entry?.tool_calls) ? entry.tool_calls : [];
  const res = [];
  for (let i = 0; i < tcs.length; i++) {
    const tc = tcs[i];
    if (isPlainObject(tc) && tc.name === "ask_question") {
      const args = tc.args ?? {};
      const s = typeof args === "string" ? args : JSON.stringify(args);
      const m = ASK_TAG_RE.exec(s);
      if (m) res.push({ n: Number(m[1]), m: Number(m[2]) });
    }
  }
  return res;
}

/**
 * Resolve the last question asked in a reply (tag wins for N, max M wins).
 */
export function lastQuestion(tags, hs) {
  const t = tags.length > 0 ? tags[tags.length - 1] : null;
  let h = null;
  for (let i = hs.length - 1; i >= 0; i--) {
    if (hs[i].m != null) {
      h = hs[i];
      break;
    }
  }
  if (t !== null) {
    return { n: t.n, m: Math.max(t.m, h?.m ?? 0) };
  }
  if (h !== null) return h;
  return null;
}

/**
 * Extract the `<USER_REQUEST>...</USER_REQUEST>` (or truncated) body when wrapped.
 */
export function userText(content) {
  const s = str(content);
  const m = USER_REQ_RE.exec(s);
  return m ? m[1] : s;
}

/**
 * Extract the first `A1: ...` answer line from a tool result.
 */
export function answerText(content) {
  if (typeof content !== "string") return "";
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = ANSWER_LINE_RE.exec(lines[i]);
    if (m) return m[1];
  }
  return "";
}

/**
 * Whether a tool result carries an `A1:` answer line (including empty `A1: `).
 */
export function hasAnswer(content) {
  return typeof content === "string" && HAS_ANSWER_RE.test(content);
}

/**
 * Whether a user message or write-in answer abandons the clarify series.
 */
export function abandons(text) {
  if (typeof text !== "string") return false;
  const t = text.toLowerCase().replace(/^\s+/, "").replace(/^a\d+:\s*/, "");
  if (ABANDON_PHRASE_RE.test(t)) return true;
  return SLASH_CMD_RE.test(t) && !clarifyCmd(t);
}

/**
 * Whether a reply's Decision Table closes the clarify series.
 */
export function closesSeries(lines, hs, last) {
  return (
    decisionTable(lines) &&
    hs.length === 0 &&
    (last === null || last.m == null || last.n >= last.m || closingSections(lines))
  );
}

function parseJsonLines(transcriptText) {
  const out = [];
  if (typeof transcriptText !== "string" || transcriptText === "") return out;
  const rawLines = transcriptText.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (isPlainObject(obj)) out.push(obj);
  }
  return out;
}

function hasAskQuestion(entry) {
  const tcs = Array.isArray(entry?.tool_calls) ? entry.tool_calls : [];
  for (let i = 0; i < tcs.length; i++) {
    const tc = tcs[i];
    if (isPlainObject(tc) && tc.name === "ask_question") return true;
  }
  return false;
}

/**
 * Evaluate the Antigravity Stop hook over a JSONL transcript string.
 * Returns `{ decision: "continue", reason }`, `{ standdown }`, or `{}`.
 */
export function evaluateStopHook(transcriptText) {
  const events = parseJsonLines(transcriptText);
  let clarifySeen = false;
  let last = null;
  let pending = [];
  let blocks = 0;
  let awaiting = false;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === "USER_INPUT") {
      const ucontent = str(e.content);
      pending = [];
      blocks = 0;
      awaiting = false;
      if (abandons(userText(ucontent))) {
        clarifySeen = false;
        last = null;
      } else if (clarifyCmd(ucontent)) {
        clarifySeen = true;
        last = null;
      }
    } else if (e.type === "GENERIC" && awaiting && hasAnswer(e.content)) {
      awaiting = false;
      const ans = answerText(e.content);
      if (ans === "" || abandons(ans)) {
        clarifySeen = false;
        last = null;
      }
    } else if (e.type === "SYSTEM_MESSAGE") {
      const scontent = str(e.content);
      if (scontent.includes("Stop hook blocked") && scontent.includes("You emitted ## Question")) {
        blocks += 1;
      }
    } else if (e.type === "PLANNER_RESPONSE") {
      const lines = outsideFences(str(e.content));
      const tags = askTags(e);
      const cseen = clarifySeen || hasTrigger(lines) || tags.length > 0;
      const hs = cseen ? allHeadings(lines) : [];
      const asked = lastQuestion(tags, hs);
      const rev = cseen ? revisedTotal(lines) : null;
      let nextLast = asked !== null ? asked : last;
      if (nextLast !== null && rev !== null) {
        nextLast = { n: nextLast.n, m: rev };
      }
      const asks = hasAskQuestion(e);
      const closes = cseen && !asks ? closesSeries(lines, hs, nextLast) : false;
      if (hs.length > 0) pending.push(...hs);
      last = cseen && !closes ? nextLast : null;
      clarifySeen = cseen && !closes;
      awaiting = asks;
      if (asks) {
        pending = [];
        blocks = 0;
      }
    }
  }

  if (pending.length > 0) {
    const h = pending[pending.length - 1];
    const mstr = h.m !== null ? String(h.m) : "Total";
    if (blocks >= 2) {
      return {
        standdown: `standing down after ${blocks} consecutive interventions without an ask_question call (last heading: Question ${h.n}); the series looks abandoned`,
      };
    }
    return {
      decision: "continue",
      reason: `You emitted ## Question ${h.n} prose without calling ask_question in this reply. Call ask_question now for Question ${h.n} (with [Question ${h.n} of ${mstr}] and matching Option A/B/C labels) before ending the turn.`,
    };
  }
  return {};
}

function optstr(v) {
  if (typeof v === "string") return v;
  if (isPlainObject(v)) {
    const lbl = v.label ?? "";
    return typeof lbl === "string" ? lbl : JSON.stringify(lbl);
  }
  return "";
}

/**
 * An option name reduced to its words: no `(Recommended)` marker, case or punctuation.
 */
function optionName(s) {
  return str(s)
    .replace(/\(Recommended\)/gi, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether two reduced option names are the same option. One may continue the other, because a
 * Mode B picker label adds the formal anchor after the prose name.
 */
function sameOption(a, b) {
  if (a === b) return true;
  if (a === "" || b === "") return false;
  return a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

/**
 * `### Option X. <name>` headings of the last question step in a reply, outside fenced blocks.
 */
export function proseOptions(text) {
  const lines = outsideFences(text);
  let res = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith("##")) continue;
    if (headingMatch(l) !== null) {
      res = [];
      continue;
    }
    const m = PROSE_OPTION_RE.exec(l);
    if (m) res.push({ letter: m[1], name: optionName(m[2]) });
  }
  return res;
}

/**
 * Compare the prose option headings of a step with the picker labels of its `ask_question` call.
 * Returns `{ why, warn }`: a different letter sequence, or a picker label that carries the prose
 * name of another letter, is a failure; a label reworded in place is a warning.
 */
export function compareOptions(prose, opts) {
  const why = [];
  const warn = [];
  const picked = [];
  for (let i = 0; i < opts.length; i++) {
    const m = PICKER_OPTION_RE.exec(optstr(opts[i]));
    if (m) picked.push({ letter: m[1], name: optionName(m[2]) });
  }
  if (prose.length === 0 || picked.length === 0) return { why, warn };

  const proseLetters = prose.map((o) => o.letter).join(", ");
  const pickedLetters = picked.map((o) => o.letter).join(", ");
  if (proseLetters !== pickedLetters) {
    why.push(`prose options ${proseLetters} do not match picker options ${pickedLetters}`);
  }
  for (let i = 0; i < picked.length; i++) {
    const p = picked[i];
    const own = prose.find((o) => o.letter === p.letter);
    if (own !== undefined && sameOption(own.name, p.name)) continue;
    const other = prose.find((o) => o.letter !== p.letter && sameOption(o.name, p.name));
    if (other !== undefined) {
      why.push(`picker Option ${p.letter} carries the prose name of Option ${other.letter}`);
    } else if (own !== undefined) {
      warn.push(`Option ${p.letter} is named differently in the prose and in the picker`);
    }
  }
  return { why, warn };
}

function parseQtag(q) {
  if (typeof q !== "string") return null;
  const m = QTAG_RE.exec(q);
  if (!m) return null;
  return { k: m[1], n: Number(m[2]), m: Number(m[3]) };
}

function parseQs(tc) {
  const raw = tc?.args?.questions;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function flushHeadings(st) {
  if (st.headings.length === 0) return;
  for (let i = 0; i < st.headings.length; i++) {
    const h = st.headings[i];
    const lbl = h.m !== null ? `${h.n}/${h.m}` : String(h.n);
    st.checked += 1;
    st.failed += 1;
    st.out.push(`FAIL Question ${lbl}: no ask_question call in same reply (step ${h.step})`);
  }
  st.headings = [];
}

function flushPriorHeadings(st) {
  if (st.headings.length <= 1) return;
  for (let i = 0; i < st.headings.length - 1; i++) {
    const h = st.headings[i];
    const lbl = h.m !== null ? `${h.n}/${h.m}` : String(h.n);
    st.checked += 1;
    st.failed += 1;
    st.out.push(`FAIL Question ${lbl}: no ask_question call in same reply (step ${h.step})`);
  }
  st.headings = [st.headings[st.headings.length - 1]];
}

function checkAsk(step, tc, st) {
  const qs = parseQs(tc);
  const qt = parseQtag(qs[0]?.question);
  if (st.headings.length === 0 && qt === null) {
    st.text = "";
    st.headings = [];
    return;
  }

  flushPriorHeadings(st);
  const hd = st.headings.length > 0 ? st.headings[0] : null;
  const n = qt !== null ? qt.n : hd !== null ? hd.n : null;
  const m = qt !== null ? qt.m : hd !== null ? hd.m : null;
  const name = n !== null && m !== null ? `Question ${n}/${m}` : n !== null ? `Question ${n}` : "Question ?";

  const why = [];
  if (qt === null) {
    why.push("question missing [Question N of M] / [Fork N of M] prefix");
  } else if (hd !== null) {
    if (hd.n !== qt.n) {
      why.push(`heading Question ${hd.n} does not match tag N=${qt.n}`);
    }
    if (hd.m !== null && hd.m !== qt.m) {
      why.push(`heading (of ${hd.m}) does not match tag M=${qt.m}`);
    }
  }

  const opts = Array.isArray(qs[0]?.options) ? qs[0].options : [];
  for (let i = 0; i < opts.length; i++) {
    const opt = optstr(opts[i]);
    if (!OPTION_PREFIX_RE.test(opt)) {
      why.push(`option missing Option X: prefix (${opt.slice(0, 60)})`);
    }
  }

  if (
    st.prev !== null &&
    n !== null &&
    m !== null &&
    n !== 1 &&
    st.prev !== m &&
    !st.rev.includes("Fork map revised")
  ) {
    why.push(`M changed from ${st.prev} to ${m} without "Fork map revised"`);
  }

  const warn = [];
  if (qt !== null) {
    const proseRe = new RegExp(`##\\s*Question\\s+${n}(\\D|$)`);
    if (!proseRe.test(st.text)) {
      warn.push(`WARN ${name}: ask_question without "## Question ${n}" prose in same reply (step ${step})`);
    }
  }

  const labels = compareOptions(proseOptions(st.text), opts);
  why.push(...labels.why);
  for (let i = 0; i < labels.warn.length; i++) {
    warn.push(`WARN ${name}: ${labels.warn[i]} (step ${step})`);
  }

  st.checked += 1;
  if (why.length > 0) {
    st.failed += 1;
    st.out.push(`FAIL ${name}: ${why.join("; ")} (step ${step})`);
  } else {
    st.out.push(`PASS ${name} (step ${step})`);
  }
  st.warned += warn.length;
  for (let i = 0; i < warn.length; i++) st.out.push(warn[i]);

  if (m !== null) st.prev = m;
  st.rev = "";
  st.text = "";
  st.headings = [];
}

/**
 * Run the Antigravity transcript checker over a JSONL transcript string.
 * Returns `{ lines, checked, failed, warned }`.
 */
export function checkAntigravityTranscript(transcriptText) {
  const events = parseJsonLines(transcriptText);
  const st = {
    line: 0,
    text: "",
    rev: "",
    prev: null,
    clarifySeen: false,
    last: null,
    awaiting: false,
    headings: [],
    checked: 0,
    failed: 0,
    warned: 0,
    out: [],
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    st.line += 1;
    const step = e.step_index != null ? e.step_index : st.line;

    if (e.type === "USER_INPUT") {
      const ucontent = str(e.content);
      flushHeadings(st);
      st.text = "";
      st.awaiting = false;
      if (abandons(userText(ucontent))) {
        st.clarifySeen = false;
        st.last = null;
      } else if (clarifyCmd(ucontent)) {
        st.clarifySeen = true;
        st.last = null;
      }
    } else if (e.type === "GENERIC" && st.awaiting && hasAnswer(e.content)) {
      st.awaiting = false;
      const ans = answerText(e.content);
      if (ans === "" || abandons(ans)) {
        st.clarifySeen = false;
        st.last = null;
      }
    } else if (e.type === "PLANNER_RESPONSE") {
      const content = str(e.content);
      const lines = outsideFences(content);
      const tags = askTags(e);
      const cseen = st.clarifySeen || hasTrigger(lines) || tags.length > 0;
      const hs = cseen ? allHeadings(lines) : [];
      const asked = lastQuestion(tags, hs);
      const rev = cseen ? revisedTotal(lines) : null;
      let nextLast = asked !== null ? asked : st.last;
      if (nextLast !== null && rev !== null) {
        nextLast = { n: nextLast.n, m: rev };
      }
      const tcs = Array.isArray(e.tool_calls) ? e.tool_calls : [];
      const asks = hasAskQuestion(e);
      const closes = cseen && !asks ? closesSeries(lines, hs, nextLast) : false;

      if (content !== "") {
        st.text += content + "\n";
        st.rev += content + "\n";
        for (let j = 0; j < hs.length; j++) {
          st.headings.push({ n: hs[j].n, m: hs[j].m, step });
        }
      }
      st.last = cseen && !closes ? nextLast : null;
      st.clarifySeen = cseen && !closes;
      st.awaiting = asks;

      for (let j = 0; j < tcs.length; j++) {
        const tc = tcs[j];
        if (isPlainObject(tc) && tc.name === "ask_question") {
          checkAsk(step, tc, st);
        }
      }
    }
  }

  flushHeadings(st);
  const lines = [...st.out, `checked=${st.checked} failed=${st.failed} warned=${st.warned}`];
  return { lines, checked: st.checked, failed: st.failed, warned: st.warned };
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
  const args = process.argv.slice(2);
  if (args[0] === "--check" && args[1]) {
    try {
      const text = readFileSync(args[1], "utf8");
      const res = checkAntigravityTranscript(text);
      process.stdout.write(res.lines.join("\n") + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(3);
    }
  } else {
    process.stderr.write("Usage: clarify-common.mjs --check <transcript.jsonl>\n");
    process.exit(3);
  }
}
