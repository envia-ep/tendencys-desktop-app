import type { JarvisEnv } from "./env.ts";
import { inferIntegrationNeeds, normalizePurpose, type IntegrationPurpose } from "./providers.ts";
import type { RequiredCapability } from "./capability-resolver.ts";

/**
 * Representative canonical capability id per purpose. The offline compiler is
 * coarse (regex-based), so one canonical id per matched purpose is enough to
 * drive resolution + connect. The AI Integration Engineer (Phase 3) mints
 * precise ids like `commerce.order.refund` against real API operations.
 */
const CANONICAL_BY_PURPOSE: Record<IntegrationPurpose, string> = {
  commerce: "commerce.customer.search",
  email: "email.message.send",
  messaging: "messaging.message.send",
  calendar: "calendar.event.create",
  custom: "custom.request",
};

/**
 * Compile a user prompt into the capabilities Jarvis needs, using only
 * deterministic regex inference. Safe to call in the worker with no model key.
 */
export function compileCapabilitiesOffline(prompt: string): RequiredCapability[] {
  const needs = inferIntegrationNeeds(prompt);
  return needs.purposes.map((purpose) => ({
    id: CANONICAL_BY_PURPOSE[purpose] ?? `${purpose}.access`,
    purpose,
    product: needs.product,
  }));
}

type CompilerModel = Pick<JarvisEnv, "modelApiKey" | "modelBaseUrl" | "modelName">;

const SYSTEM_PROMPT = [
  "You map a user request to the external capabilities an assistant needs.",
  "Reply with JSON: {\"capabilities\":[{\"id\":\"namespaced.capability.id\",\"purpose\":\"commerce|email|messaging|calendar|custom\"}]}.",
  "Use lowercase dotted ids (e.g. commerce.customer.search). Only include capabilities that require an external system.",
].join(" ");

function parseCapabilityManifest(raw: string): RequiredCapability[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return [];
  }
  let parsed: { capabilities?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { capabilities?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.capabilities)) {
    return [];
  }
  const out: RequiredCapability[] = [];
  for (const row of parsed.capabilities) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const entry = row as { id?: unknown; purpose?: unknown };
    const id = typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
    const purpose = normalizePurpose(typeof entry.purpose === "string" ? entry.purpose : undefined);
    if (!id || !purpose) {
      continue;
    }
    out.push({ id, purpose });
  }
  return out;
}

/**
 * Compile a prompt into required capabilities. Uses the model when a key is
 * configured (richer, more precise ids); otherwise falls back to the offline
 * regex compiler. Any model failure falls back rather than throwing.
 *
 * @returns The required capabilities, de-duplicated by id.
 */
export async function compileCapabilities(
  prompt: string,
  model?: CompilerModel,
): Promise<RequiredCapability[]> {
  const offline = compileCapabilitiesOffline(prompt);
  if (!model?.modelApiKey) {
    return offline;
  }
  try {
    const response = await fetch(`${model.modelBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${model.modelApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.modelName,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      return offline;
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const manifest = parseCapabilityManifest(body.choices?.[0]?.message?.content ?? "");
    const merged = manifest.length > 0 ? manifest : offline;
    const seen = new Set<string>();
    return merged.filter((row) => (seen.has(row.id) ? false : seen.add(row.id)));
  } catch {
    return offline;
  }
}
