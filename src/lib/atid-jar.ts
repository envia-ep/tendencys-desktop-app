import { TENDENCYS_BASE_URL } from "@/lib/tendencys-auth";
import {
  readAccountsSession,
  seedAccountsSession,
} from "@/lib/native-webviews";

/**
 * Ensure Accounts `_atid` is in the shared product cookie jar.
 * Reads first and never clobbers an existing cookie — only seeds when empty.
 * Returns true when the jar has a session (or seeding succeeded).
 */
export async function ensureAtidSeeded(
  sessionToken: string | null | undefined,
): Promise<boolean> {
  const existing = await readAccountsSession(TENDENCYS_BASE_URL).catch(
    () => null,
  );
  if (existing) {
    return true;
  }
  if (!sessionToken) return false;
  await seedAccountsSession(TENDENCYS_BASE_URL, sessionToken).catch(() => null);
  const after = await readAccountsSession(TENDENCYS_BASE_URL).catch(
    () => null,
  );
  return Boolean(after);
}
