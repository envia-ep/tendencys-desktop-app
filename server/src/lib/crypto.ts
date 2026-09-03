import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export type Ed25519Keypair = {
  publicKeyB64: string;
  privateKeyB64: string;
};

export function generateEd25519(): Ed25519Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const privDer = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  return {
    publicKeyB64: pubDer.subarray(ED25519_SPKI_PREFIX.length).toString("base64"),
    privateKeyB64: privDer.subarray(ED25519_PKCS8_PREFIX.length).toString("base64"),
  };
}

export function publicKeyFromB64(publicKeyB64: string): KeyObject {
  const raw = Buffer.from(publicKeyB64, "base64");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function privateKeyFromB64(privateKeyB64: string): KeyObject {
  const raw = Buffer.from(privateKeyB64, "base64");
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

export function signBytes(privateKeyB64: string, data: Buffer): string {
  const sig = nodeSign(null, data, privateKeyFromB64(privateKeyB64));
  return sig.toString("base64");
}

export function verifyBytes(
  publicKeyB64: string,
  data: Buffer,
  signatureB64: string,
): boolean {
  try {
    return nodeVerify(
      null,
      data,
      publicKeyFromB64(publicKeyB64),
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function argsHash(args: unknown): string {
  return sha256Hex(canonicalJson(args));
}

export function resultPayloadHash(result: unknown): string {
  return sha256Hex(canonicalJson(result));
}

export function deviceResultSignBytes(input: {
  runId: string;
  toolInvocationId: string;
  requestId: string;
  status: string;
  result: unknown;
  executedAt: string;
}): Buffer {
  const digest = sha256Hex(
    `${input.runId}${input.toolInvocationId}${input.requestId}${input.status}${resultPayloadHash(input.result)}${input.executedAt}`,
  );
  return Buffer.from(digest, "utf8");
}

export function hmacJwt(
  secret: string,
  payload: Record<string, unknown>,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyHmacJwt(
  secret: string,
  token: string,
): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [header, body, sig] = parts;
  const expected = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  if (expected.length !== sig.length) {
    return null;
  }
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  if (mismatch !== 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function embedText(text: string): number[] {
  const dims = 32;
  const vector = new Array<number>(dims).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    const hash = createHash("sha256").update(token).digest();
    const index = hash[0] % dims;
    vector[index] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0)) || 1;
  return vector.map((n) => n / norm);
}

export type SealedEnvelope = {
  v: 1;
  alg: "aes-256-gcm";
  n: string;
  ct: string;
};

const VAULT_ALG = "aes-256-gcm";

export function parseVaultKey(value: string): Buffer {
  const trimmed = value.trim();
  const b64 = Buffer.from(trimmed, "base64");
  if (b64.length === 32) {
    return b64;
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  throw new Error("JARVIS_VAULT_KEY must be 32 bytes (base64 or hex)");
}

export function generateVaultKey(): Buffer {
  return randomBytes(32);
}

export function deriveVaultKey(master: Buffer, keyVersion: number): Buffer {
  return Buffer.from(hkdfSync("sha256", master, "", `jarvis-vault-v${keyVersion}`, 32));
}

export function vaultAad(input: {
  orgId: string;
  recordId: string;
  kind: string;
  keyVersion: number;
}): Buffer {
  return Buffer.from(`${input.orgId}|${input.recordId}|${input.kind}|${input.keyVersion}`, "utf8");
}

export function sealSecret(input: {
  plaintext: string;
  masterKey: Buffer;
  orgId: string;
  recordId: string;
  kind: string;
  keyVersion?: number;
}): string {
  const keyVersion = input.keyVersion ?? 1;
  const key = deriveVaultKey(input.masterKey, keyVersion);
  const nonce = randomBytes(12);
  const cipher = createCipheriv(VAULT_ALG, key, nonce);
  cipher.setAAD(vaultAad({ ...input, keyVersion }));
  const encrypted = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  const ct = Buffer.concat([encrypted, cipher.getAuthTag()]);
  const envelope: SealedEnvelope = {
    v: 1,
    alg: VAULT_ALG,
    n: nonce.toString("base64"),
    ct: ct.toString("base64"),
  };
  return JSON.stringify(envelope);
}

export function openSecret(input: {
  sealed: string;
  masterKey: Buffer;
  previousKey?: Buffer | null;
  orgId: string;
  recordId: string;
  kind: string;
  keyVersion: number;
}): string {
  const tryKey = (master: Buffer): string => {
    const parsed = JSON.parse(input.sealed) as SealedEnvelope;
    if (parsed.v !== 1 || parsed.alg !== VAULT_ALG || !parsed.n || !parsed.ct) {
      throw new Error("vault_open_failed");
    }
    const key = deriveVaultKey(master, input.keyVersion);
    const nonce = Buffer.from(parsed.n, "base64");
    const raw = Buffer.from(parsed.ct, "base64");
    if (nonce.length !== 12 || raw.length < 17) {
      throw new Error("vault_open_failed");
    }
    const data = raw.subarray(0, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);
    const decipher = createDecipheriv(VAULT_ALG, key, nonce);
    decipher.setAAD(vaultAad(input));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  };
  try {
    return tryKey(input.masterKey);
  } catch {
    if (input.previousKey) {
      return tryKey(input.previousKey);
    }
    throw new Error("vault_open_failed");
  }
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function cosine(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}
