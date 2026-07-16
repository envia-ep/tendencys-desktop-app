import { invoke } from "@tauri-apps/api/core";
import { TENDENCYS_BASE_URL, SHELL_SITE_ID } from "./tendencys-auth";

export type TendencysAccount = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
};

type AccountsAuthorizationResponse = {
  id?: string;
  _id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  token?: string;
  account?: {
    id?: string;
    _id?: string;
    email?: string;
    first_name?: string;
    last_name?: string;
  };
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

/** Decode JWT payload without verifying signature (Accounts already verified the token). */
export function extractAudience(token: string): string | null {
  const payload = decodeJwtPayload(token);
  return typeof payload?.aud === "string" ? (payload.aud as string) : null;
}

/** The Accounts session JWT's `id` claim is the account id (see createToken). */
export function extractAccountId(token: string): string | null {
  const payload = decodeJwtPayload(token);
  return typeof payload?.id === "string" ? (payload.id as string) : null;
}

function parseAuthorizationResponse(
  data: AccountsAuthorizationResponse,
):
  | { account: TendencysAccount; sessionToken: string }
  | { error: string } {
  const rawAccount = data.account ?? data;

  const id =
    rawAccount.id ??
    ("_id" in rawAccount ? rawAccount._id : undefined) ??
    data._id;
  const email = rawAccount.email ?? data.email;

  if (!id || !email) {
    return { error: "Invalid account data received from accounts service." };
  }

  return {
    account: {
      id: String(id),
      email,
      firstName: rawAccount.first_name ?? data.first_name ?? "",
      lastName: rawAccount.last_name ?? data.last_name ?? "",
    },
    sessionToken: data.token || "",
  };
}

/**
 * Validate via a Rust command that sets Referer = JWT aud (required for
 * tendencys:// deep-link tokens). Browser fetch cannot set Referer (forbidden
 * header) and is blocked by Accounts CORS/CORP, so this is Tauri-only.
 */
export async function validateAuthorizationToken(
  token: string,
): Promise<
  | { account: TendencysAccount; sessionToken: string }
  | { error: string }
> {
  const audience = extractAudience(token) || "tendencys://authentication";

  try {
    const data = await invoke<AccountsAuthorizationResponse>(
      "validate_accounts_token",
      {
        accountsBaseUrl: TENDENCYS_BASE_URL,
        siteId: SHELL_SITE_ID,
        token,
        referer: audience,
      },
    );

    const parsed = parseAuthorizationResponse(data);
    if ("error" in parsed) return parsed;
    // Never seed the one-time handoff JWT as `_atid` — use data.token (7d
    // createToken with id) from this response for jar seed / device-key register.
    if (!parsed.sessionToken) {
      return {
        error:
          "Accounts did not return a session token. Please sign in again.",
      };
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[AccountsAPI] Authorization error:", error);
    return {
      error: `Unable to reach the accounts service: ${message}`,
    };
  }
}
