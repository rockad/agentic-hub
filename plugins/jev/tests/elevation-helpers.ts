/**
 * An in-memory stand-in for the hook's clamp claim: `first` is true for the first caller of a session and
 * prompt key, false after, and a later caller gets the signature of the delegation the first one clamped.
 */
export function memoryClaim(): (sessionId: string, promptKey: string, signature: string) => { first: boolean; signature?: string } {
  const seen = new Map<string, string>();
  return (sessionId, promptKey, signature) => {
    const key = `${sessionId}\u0000${promptKey}`;
    if (seen.has(key)) return { first: false, signature: seen.get(key) };
    // One slot per session, like the live store: a new prompt forgets the old one.
    for (const k of [...seen.keys()]) if (k.startsWith(`${sessionId}\u0000`)) seen.delete(k);
    seen.set(key, signature);
    return { first: true };
  };
}
