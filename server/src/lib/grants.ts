const CLIPBOARD_KINDS = new Set(["ONCE", "SESSION", "15_MIN"]);

export function clipboardExpiresAt(kind: string, sessionExpiresAt: string): string {
  if (kind === "ONCE") {
    return new Date(Date.now() + 5 * 60_000).toISOString();
  }
  if (kind === "SESSION") {
    return sessionExpiresAt;
  }
  if (kind === "15_MIN") {
    return new Date(Date.now() + 15 * 60_000).toISOString();
  }
  throw new Error("clipboard grants must be ONCE, SESSION, or 15_MIN");
}

export function isClipboardCapability(capability: string): boolean {
  return capability === "clipboard.read" || capability === "clipboard.write";
}

export function assertGrantKind(capability: string, kind?: string): void {
  if (!isClipboardCapability(capability)) {
    return;
  }
  if (!kind || !CLIPBOARD_KINDS.has(kind)) {
    throw new Error("clipboard grants cannot be always");
  }
}
