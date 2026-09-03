import { argsHash, signBytes, verifyBytes } from "./crypto.ts";
import { id } from "./ids.ts";

export type NativeEnvelope = {
  toolInvocationId: string;
  requestId: string;
  runId: string;
  sessionId: string;
  deviceId: string;
  tool: string;
  toolVersion: number;
  grantId: string | null;
  arguments: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  serverSignature: string;
};

export function envelopeBytes(envelope: Omit<NativeEnvelope, "serverSignature">): Buffer {
  return Buffer.from(
    [
      envelope.toolInvocationId,
      envelope.requestId,
      envelope.runId,
      envelope.sessionId,
      envelope.deviceId,
      envelope.tool,
      String(envelope.toolVersion),
      envelope.grantId ?? "",
      argsHash(envelope.arguments),
      envelope.issuedAt,
      envelope.expiresAt,
      envelope.nonce,
    ].join("|"),
    "utf8",
  );
}

export function signEnvelope(
  serverPrivateKeyB64: string,
  unsigned: Omit<NativeEnvelope, "serverSignature">,
): NativeEnvelope {
  return {
    ...unsigned,
    serverSignature: signBytes(serverPrivateKeyB64, envelopeBytes(unsigned)),
  };
}

export function verifyEnvelope(
  serverPublicKeyB64: string,
  envelope: NativeEnvelope,
): boolean {
  const { serverSignature, ...rest } = envelope;
  return verifyBytes(serverPublicKeyB64, envelopeBytes(rest), serverSignature);
}

export function issueEnvelope(input: {
  serverPrivateKeyB64: string;
  toolInvocationId: string;
  runId: string;
  sessionId: string;
  deviceId: string;
  tool: string;
  arguments: Record<string, unknown>;
  grantId?: string | null;
  ttlMs?: number;
}): NativeEnvelope {
  const issuedAt = new Date().toISOString();
  return signEnvelope(input.serverPrivateKeyB64, {
    toolInvocationId: input.toolInvocationId,
    requestId: id("req"),
    runId: input.runId,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    tool: input.tool,
    toolVersion: 1,
    grantId: input.grantId ?? null,
    arguments: input.arguments,
    issuedAt,
    expiresAt: new Date(Date.now() + (input.ttlMs ?? 5 * 60_000)).toISOString(),
    nonce: id("nce"),
  });
}
