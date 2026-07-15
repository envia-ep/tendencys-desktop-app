/**
 * Deduplicates handoff token validation across concurrent listeners.
 *
 * Primary path: Rust deep-link / in-app auth → `shell-auth-token` → App.tsx.
 * Backup path: JS `onOpenUrl` → Authentication.tsx.
 *
 * In React Strict Mode the `listenShellAuthToken` effect mounts twice in dev,
 * and the second async registration completes after the first cleanup — leaving
 * two live listeners for a single `shell-auth-token` event. Both call
 * `validateAndLogin` with the same one-time token; the first wins, the second
 * gets a 403 and breaks the login flow.
 *
 * `claimHandoffToken` lets the FIRST caller proceed and makes every subsequent
 * caller bail out. Tokens expire from the set after 60 s so a genuine retry
 * (user clicking "Try again") is not blocked.
 */
const claimed = new Set<string>();

export function claimHandoffToken(token: string): boolean {
  if (claimed.has(token)) return false;
  claimed.add(token);
  setTimeout(() => claimed.delete(token), 60_000);
  return true;
}
