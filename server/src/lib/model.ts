import type { JarvisEnv } from "./env.ts";

export type ModelReply = {
  text: string;
  tool?: string;
  arguments?: Record<string, unknown>;
};

export async function completeModel(
  env: Pick<JarvisEnv, "modelApiKey" | "modelBaseUrl" | "modelName">,
  input: { system: string; user: string; presentedTools: string[] },
): Promise<ModelReply | null> {
  if (!env.modelApiKey) {
    return null;
  }
  const response = await fetch(`${env.modelBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.modelApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.modelName,
      temperature: 0.2,
      messages: [
        { role: "system", content: input.system },
        {
          role: "user",
          content: `${input.user}\n\nRequestable tools: ${input.presentedTools.join(", ") || "none"}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`model ${response.status}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = body.choices?.[0]?.message?.content?.trim() ?? "";
  return parseModelReply(raw);
}

export function parseModelReply(raw: string): ModelReply {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as {
        text?: unknown;
        tool?: unknown;
        arguments?: unknown;
      };
      return {
        text: typeof parsed.text === "string" ? parsed.text : raw,
        tool: typeof parsed.tool === "string" ? parsed.tool : undefined,
        arguments:
          parsed.arguments && typeof parsed.arguments === "object"
            ? (parsed.arguments as Record<string, unknown>)
            : {},
      };
    } catch {
      return { text: raw };
    }
  }
  return { text: raw };
}
