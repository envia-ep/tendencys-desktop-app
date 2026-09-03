import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchWeb } from "./web-search.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function citation(title: string, url: string) {
  return { type: "url_citation", title, url, start_index: 0, end_index: title.length };
}

describe("searchWeb", () => {
  it("returns at most five items from url citations", async () => {
    const titles = ["One", "Two", "Three", "Four", "Five", "Six"];
    const result = await searchWeb("top tennis shoes", {
      apiKey: "sk-test",
      fetch: async () =>
        jsonResponse({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: titles.join(" "),
                  annotations: titles.map((title, index) =>
                    citation(title, `https://example.com/${index + 1}`),
                  ),
                },
              ],
            },
          ],
        }),
    });
    assert.equal(result.items.length, 5);
    assert.equal(result.items[0]?.title, "One");
    assert.equal(result.items[4]?.title, "Five");
    assert.equal(result.error, undefined);
  });

  it("returns an empty list when there are no citations", async () => {
    const result = await searchWeb("nothing", {
      apiKey: "sk-test",
      fetch: async () =>
        jsonResponse({
          output: [{ type: "message", content: [{ type: "output_text", text: "No results", annotations: [] }] }],
        }),
    });
    assert.deepEqual(result.items, []);
    assert.equal(result.error, undefined);
  });

  it("returns an error shape when the provider fails", async () => {
    const result = await searchWeb("tennis", {
      apiKey: "sk-test",
      fetch: async () => jsonResponse({ error: { message: "boom" } }, 500),
    });
    assert.deepEqual(result.items, []);
    assert.equal(result.error, "search_failed");
  });
});
