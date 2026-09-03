import { createHash } from "node:crypto";
import { hmacJwt, verifyBytes, verifyHmacJwt } from "./crypto.ts";
import { AppError, unauthorized } from "./errors.ts";
import type { JarvisEnv } from "./env.ts";
import type { RuntimeRepo } from "./runtime-repo.ts";
import type { AuthContext } from "./types.ts";

export type AccountsIdentity = {
  userId: string;
  orgId: string;
};

const IDENTITY_CACHE_TTL_MS = 10 * 60_000;
const identityCache = new Map<string, { identity: AccountsIdentity; until: number }>();

function atidCacheKey(atid: string): string {
  return createHash("sha256").update(atid).digest("hex");
}

function atidExpiryMs(atid: string): number {
  const parts = atid.split(".");
  if (parts.length < 2) {
    return Date.now() + IDENTITY_CACHE_TTL_MS;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    if (typeof payload.exp === "number" && payload.exp * 1000 > Date.now()) {
      return Math.min(payload.exp * 1000, Date.now() + IDENTITY_CACHE_TTL_MS);
    }
  } catch {
    // ponytail: unsigned payload peek for cache TTL only
  }
  return Date.now() + IDENTITY_CACHE_TTL_MS;
}

export function clearAccountsIdentityCache(): void {
  identityCache.clear();
}

function asId(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object" && "$oid" in value) {
    return String((value as { $oid: unknown }).$oid);
  }
  return "";
}

function firstCompanyId(user: Record<string, unknown>): string {
  const company = user.company as Record<string, unknown> | undefined;
  const companies = user.companies;
  const first = Array.isArray(companies)
    ? (companies[0] as Record<string, unknown> | undefined)
    : undefined;
  return asId(
    user.company_id ??
      user.companyId ??
      company?.id ??
      company?._id ??
      first?.id ??
      first?._id,
  );
}

/** Accounts `/authorization` returns `_id` and no company — personal org is the account. */
export function identityFromAccountsBody(body: Record<string, unknown>): AccountsIdentity {
  const user =
    (body.user as Record<string, unknown> | undefined) ??
    (body.account as Record<string, unknown> | undefined) ??
    body;
  const userId = asId(user.id ?? user._id ?? user.user_id ?? user.userId);
  if (!userId) {
    throw unauthorized("Accounts identity missing account");
  }
  return { userId, orgId: firstCompanyId(user) || userId };
}

export function parseTestAtid(atid: string): AccountsIdentity | null {
  const match = /^test:([^:]+):([^:]+)$/.exec(atid.trim());
  if (!match) {
    return null;
  }
  return { userId: match[1], orgId: match[2] };
}

const ALLOWED_ACCOUNTS_ORIGINS = new Set([
  "https://accounts.envia.com",
  "https://accounts-sandbox.envia.com",
]);

/** Unverified JWT `aud` — Accounts requires Referer to contain this value. */
export function extractJwtAudience(token: string): string | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      aud?: unknown;
    };
    return typeof payload.aud === "string" && payload.aud.trim() ? payload.aud.trim() : null;
  } catch {
    return null;
  }
}

export function resolveAccountsBaseUrl(env: JarvisEnv, requested?: string): string {
  const fallback = env.accountsBaseUrl.replace(/\/$/, "");
  const origin = (requested ?? fallback).replace(/\/$/, "");
  if (origin === fallback || ALLOWED_ACCOUNTS_ORIGINS.has(origin)) {
    return origin;
  }
  throw unauthorized("Accounts host not allowed");
}

export async function resolveAccountsIdentity(
  env: JarvisEnv,
  atid: string,
  options: { accountsBaseUrl?: string } = {},
): Promise<AccountsIdentity> {
  const test = parseTestAtid(atid);
  if (test) {
    return test;
  }
  const cacheKey = atidCacheKey(atid);
  const cached = identityCache.get(cacheKey);
  if (cached && cached.until > Date.now()) {
    return cached.identity;
  }
  const base = resolveAccountsBaseUrl(env, options.accountsBaseUrl);
  const url = `${base}/api/accounts/authorization`;
  const referer = extractJwtAudience(atid) || base;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: atid,
      "X-Client-ID": env.accountsSiteId,
      Referer: referer,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    console.warn(`[jarvis/session] Accounts authorization failed status=${response.status}`);
    throw unauthorized("Accounts authorization failed");
  }
  const identity = identityFromAccountsBody((await response.json()) as Record<string, unknown>);
  identityCache.set(cacheKey, { identity, until: atidExpiryMs(atid) });
  return identity;
}

export function verifyAttestation(input: {
  devicePublicKey: string;
  deviceId: string;
  attestation: string;
}): boolean {
  const payload = Buffer.from(`${input.deviceId}|${input.devicePublicKey}`, "utf8");
  return verifyBytes(input.devicePublicKey, payload, input.attestation);
}

export function issueAccessToken(
  env: JarvisEnv,
  claims: AuthContext,
): { token: string; expiresAt: string } {
  const exp = Math.floor((Date.now() + env.jwtTtlMs) / 1000);
  const token = hmacJwt(env.jwtSecret, {
    aud: "jarvis",
    userId: claims.userId,
    orgId: claims.orgId,
    deviceId: claims.deviceId,
    sessionId: claims.sessionId,
    exp,
  });
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

export function readBearer(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function requireAuth(
  runtime: RuntimeRepo,
  env: JarvisEnv,
  header?: string,
): Promise<AuthContext> {
  const token = readBearer(header);
  if (!token) {
    throw unauthorized();
  }
  const payload = verifyHmacJwt(env.jwtSecret, token);
  if (!payload || payload.aud !== "jarvis") {
    throw unauthorized("invalid token");
  }
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    throw unauthorized("token expired");
  }
  const sessionId = String(payload.sessionId ?? "");
  const session = await runtime.getSession(sessionId);
  if (!session || session.revokedAt) {
    throw unauthorized("session revoked");
  }
  if (Date.parse(session.expiresAt) < Date.now()) {
    throw unauthorized("session expired");
  }
  if (
    String(payload.userId ?? "") !== session.userId ||
    String(payload.orgId ?? "") !== session.orgId ||
    String(payload.deviceId ?? "") !== session.deviceId
  ) {
    throw unauthorized("tenant mismatch");
  }
  const device = await runtime.getDevice(session.deviceId);
  if (!device || device.revokedAt) {
    throw unauthorized("device revoked");
  }
  await runtime.touchSession(sessionId);
  return {
    userId: session.userId,
    orgId: session.orgId,
    deviceId: session.deviceId,
    sessionId: session.id,
  };
}

export function assertOrg(auth: AuthContext, orgId: string): void {
  if (auth.orgId !== orgId) {
    throw new AppError("FORBIDDEN", "Wrong organization", 403);
  }
}
