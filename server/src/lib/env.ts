import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateEd25519, generateVaultKey, parseVaultKey } from "./crypto.ts";

function loadDotenv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export type JarvisEnv = {
  port: number;
  jwtSecret: string;
  serverPrivateKeyB64: string;
  serverPublicKeyB64: string;
  accountsBaseUrl: string;
  accountsSiteId: string;
  sessionTtlMs: number;
  jwtTtlMs: number;
  leaseMs: number;
  inlineWorker: boolean;
  modelApiKey: string | null;
  modelBaseUrl: string;
  modelName: string;
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  vaultKey: Buffer;
  vaultKeyPrevious: Buffer | null;
};

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`missing env ${name}`);
  }
  return value;
}

export function loadEnv(overrides: Partial<JarvisEnv> = {}): JarvisEnv {
  loadDotenv();
  const supabaseUrl =
    overrides.supabaseUrl !== undefined
      ? overrides.supabaseUrl
      : process.env.SUPABASE_URL?.trim() || null;
  const supabaseServiceRoleKey =
    overrides.supabaseServiceRoleKey !== undefined
      ? overrides.supabaseServiceRoleKey
      : process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
  const pinned = Boolean(supabaseUrl && supabaseServiceRoleKey);
  if (pinned) {
    if (!process.env.JARVIS_SERVER_PRIVATE_KEY && !overrides.serverPrivateKeyB64) {
      throw new Error("missing env JARVIS_SERVER_PRIVATE_KEY");
    }
    if (!process.env.JARVIS_SERVER_PUBLIC_KEY && !overrides.serverPublicKeyB64) {
      throw new Error("missing env JARVIS_SERVER_PUBLIC_KEY");
    }
    if (!process.env.JARVIS_JWT_SECRET && !overrides.jwtSecret) {
      throw new Error("missing env JARVIS_JWT_SECRET");
    }
    if (!process.env.JARVIS_VAULT_KEY && !overrides.vaultKey) {
      throw new Error("missing env JARVIS_VAULT_KEY");
    }
  }
  const generated = pinned ? null : generateEd25519();
  const vaultKey =
    overrides.vaultKey ??
    (process.env.JARVIS_VAULT_KEY
      ? parseVaultKey(process.env.JARVIS_VAULT_KEY)
      : generateVaultKey());
  const vaultKeyPrevious =
    overrides.vaultKeyPrevious !== undefined
      ? overrides.vaultKeyPrevious
      : process.env.JARVIS_VAULT_KEY_PREVIOUS
        ? parseVaultKey(process.env.JARVIS_VAULT_KEY_PREVIOUS)
        : null;
  return {
    port: Number(process.env.PORT ?? 8788),
    jwtSecret:
      overrides.jwtSecret ??
      required("JARVIS_JWT_SECRET", pinned ? undefined : "dev-jarvis-jwt-secret-min-32-chars!!"),
    serverPrivateKeyB64:
      overrides.serverPrivateKeyB64 ??
      process.env.JARVIS_SERVER_PRIVATE_KEY ??
      generated!.privateKeyB64,
    serverPublicKeyB64:
      overrides.serverPublicKeyB64 ??
      process.env.JARVIS_SERVER_PUBLIC_KEY ??
      generated!.publicKeyB64,
    accountsBaseUrl: process.env.ACCOUNTS_BASE_URL ?? "https://accounts.envia.com",
    accountsSiteId: process.env.ACCOUNTS_SITE_ID ?? "6a51478d752f0077b7d9b356",
    sessionTtlMs: Number(process.env.JARVIS_SESSION_TTL_MS ?? 24 * 60 * 60_000),
    jwtTtlMs: Number(
      process.env.JARVIS_JWT_TTL_MS ?? process.env.JARVIS_SESSION_TTL_MS ?? 24 * 60 * 60_000,
    ),
    leaseMs: Number(process.env.JARVIS_LEASE_MS ?? 30_000),
    inlineWorker: process.env.JARVIS_INLINE_WORKER === "1",
    modelApiKey: process.env.JARVIS_MODEL_API_KEY?.trim() || null,
    modelBaseUrl: process.env.JARVIS_MODEL_BASE_URL ?? "https://api.openai.com/v1",
    modelName: process.env.JARVIS_MODEL_NAME ?? "gpt-4.1-mini",
    ...overrides,
    supabaseUrl,
    supabaseServiceRoleKey,
    vaultKey,
    vaultKeyPrevious,
  };
}
