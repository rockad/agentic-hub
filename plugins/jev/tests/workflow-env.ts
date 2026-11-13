/**
 * Environment snapshot helpers for the Workflow guard tests: they set HOME, CLAUDE_* and JEV_* variables and must
 * restore the process environment exactly (assigning `process.env` itself would replace the object other files hold).
 */
export function snapshotEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

export function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
