export type SearchItem = {
  title: string;
  url: string;
  snippet: string;
};

export type SearchResult = {
  items: SearchItem[];
  error?: string;
};

export type SearchWebDeps = {
  fetch?: typeof fetch;
  apiKey?: string | null;
  baseUrl?: string;
  model?: string;
};

type Annotation = {
  type?: string;
  title?: string;
  url?: string;
  start_index?: number;
  end_index?: number;
};

type OutputContent = {
  type?: string;
  text?: string;
  annotations?: Annotation[];
};

type OutputItem = {
  type?: string;
  content?: OutputContent[];
};

function itemsFromResponse(body: { output?: OutputItem[] }): SearchItem[] {
  const found: SearchItem[] = [];
  const seen = new Set<string>();
  for (const item of body.output ?? []) {
    for (const content of item.content ?? []) {
      const text = typeof content.text === "string" ? content.text : "";
      for (const annotation of content.annotations ?? []) {
        if (annotation.type !== "url_citation" || !annotation.url) {
          continue;
        }
        if (seen.has(annotation.url)) {
          continue;
        }
        seen.add(annotation.url);
        const start = annotation.start_index ?? 0;
        const end = annotation.end_index ?? start;
        const snippet = text.slice(start, end).trim() || text.slice(0, 160).trim();
        found.push({
          title: annotation.title?.trim() || annotation.url,
          url: annotation.url,
          snippet,
        });
        if (found.length === 5) {
          return found;
        }
      }
    }
  }
  return found;
}

export async function searchWeb(query: string, deps: SearchWebDeps = {}): Promise<SearchResult> {
  const apiKey = deps.apiKey ?? null;
  if (!apiKey) {
    return { items: [], error: "search_unavailable" };
  }
  const fetchFn = deps.fetch ?? fetch;
  const baseUrl = (deps.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  try {
    const response = await fetchFn(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: deps.model ?? "gpt-4.1-mini",
        tools: [{ type: "web_search" }],
        input: query,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      return { items: [], error: "search_failed" };
    }
    const body = (await response.json()) as { output?: OutputItem[] };
    return { items: itemsFromResponse(body) };
  } catch {
    return { items: [], error: "search_failed" };
  }
}
