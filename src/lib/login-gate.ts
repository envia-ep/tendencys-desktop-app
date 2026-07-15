/**
 * Guards `LoginPage` against firing `startAuth()` more than once per
 * unauthenticated visit (React Strict Mode double-mount). Lives outside
 * `LoginPage` so every path that can produce a real session — the page's own
 * silent device-key attempt, `App.tsx`'s `shell-auth-token` listener, and the
 * `/authentication` deep-link backup route — can reset it. A login that
 * completes while `LoginPage` isn't mounted (e.g. via the backup route) would
 * otherwise leave this stuck `true`, causing the next post-logout mount to
 * skip `startAuth()` entirely and freeze on the initial "checking" phase.
 */
let started = false;

export function isLoginStarted(): boolean {
  return started;
}

export function setLoginStarted(value: boolean): void {
  started = value;
}
