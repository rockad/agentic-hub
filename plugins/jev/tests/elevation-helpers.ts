/** An in-memory stand-in for the hook's clamp claim: true for the first caller of a session and prompt key, false after. */
export function memoryClaim(): (sessionId: string, promptKey: string) => boolean {
  const seen = new Set<string>();
  return (sessionId, promptKey) => {
    const key = `${sessionId}\u0000${promptKey}`;
    if (seen.has(key)) return false;
    // One slot per session, like the live store: a new prompt forgets the old one.
    for (const k of [...seen]) if (k.startsWith(`${sessionId}\u0000`)) seen.delete(k);
    seen.add(key);
    return true;
  };
}
