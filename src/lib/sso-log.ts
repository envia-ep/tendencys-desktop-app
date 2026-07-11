import { readAccountsSession } from "./native-webviews";
import { TENDENCYS_BASE_URL } from "./tendencys-auth";

/** Dev-only so packaged release consoles stay clean (mirrors Rust debug gating). */
const DEBUG = import.meta.env.DEV;

/** Verbose `[sso]` diagnostics. No-op in production builds. */
export function ssoLog(message: string, ...args: unknown[]): void {
  if (DEBUG) {
    console.info(`[sso] ${message}`, ...args);
  }
}

type TokenShape = {
  hasId: boolean;
  aud: string | null;
  exp: number | null;
  expiresInSeconds: number | null;
};

/** Decode a JWT payload WITHOUT verifying it — claim shape only, never the value. */
export function decodeTokenShape(token: string): TokenShape | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { id?: unknown; aud?: unknown; exp?: unknown };
    const exp = typeof payload.exp === "number" ? payload.exp : null;
    return {
      hasId: payload.id != null && payload.id !== "",
      aud: typeof payload.aud === "string" ? payload.aud : null,
      exp,
      expiresInSeconds: exp ? Math.round(exp - Date.now() / 1000) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Dev diagnostic: report the live shared-jar `_atid` claim shape + expiry.
 * Exposed as `window.__ssoDiagnose()` in dev builds. Never prints the token.
 */
export async function diagnoseAccountsSession(): Promise<{
  present: boolean;
  shape: TokenShape | null;
}> {
  const atid = await readAccountsSession(TENDENCYS_BASE_URL).catch(() => null);
  const shape = atid ? decodeTokenShape(atid) : null;
  console.info("[sso] diagnose _atid present=%s shape=%o", Boolean(atid), shape);
  return { present: Boolean(atid), shape };
}
