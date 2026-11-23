#!/usr/bin/env node
/**
 * clarify-stop-check.mjs - Antigravity Stop hook for the `clarify` skill.
 *
 * Prevents premature end-of-turn when a reply emits clarify "## Question N"
 * prose without calling `ask_question` in the same reply window.
 *
 * Stays silent once the user abandons the series (an explicit cancel or a
 * different slash command after the last question), and stands down after
 * 2 consecutive interventions with no ask_question call in between.
 *
 * Always fails open ({} + exit 0); the only exception is the test-only
 * CLARIFY_HOOK_STRICT switch on internal evaluation errors.
 */

import { readFileSync } from "node:fs";
import { evaluateStopHook } from "./clarify-common.mjs";

function failOpen() {
  process.stdout.write("{}\n");
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  let rawPayload;
  try {
    rawPayload = await readStdin();
  } catch {
    failOpen();
    return;
  }

  if (!rawPayload || !rawPayload.trim()) {
    failOpen();
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    failOpen();
    return;
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload.terminationReason ?? "") !== "NO_TOOL_CALL" ||
    payload.continuationActive === true ||
    typeof payload.transcriptPath !== "string" ||
    payload.transcriptPath === ""
  ) {
    failOpen();
    return;
  }

  let transcriptText;
  try {
    transcriptText = readFileSync(payload.transcriptPath, "utf8");
  } catch {
    failOpen();
    return;
  }

  let result;
  try {
    result = evaluateStopHook(transcriptText);
  } catch {
    if (process.env.CLARIFY_HOOK_STRICT) {
      process.exit(3);
    }
    failOpen();
    return;
  }

  if (result && typeof result.standdown === "string") {
    process.stderr.write(`clarify-stop-check: ${result.standdown}\n`);
    process.stdout.write("{}\n");
    process.exit(0);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

main();
