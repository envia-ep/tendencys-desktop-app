import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseModelReply } from "./model.ts";

describe("parseModelReply", () => {
  it("reads tool and text from a JSON object", () => {
    const reply = parseModelReply('{"text":"Saved.","tool":"memory.remember","arguments":{"content":"DHL"}}');
    assert.equal(reply.text, "Saved.");
    assert.equal(reply.tool, "memory.remember");
    assert.equal(reply.arguments?.content, "DHL");
  });

  it("falls back to raw text when JSON is missing", () => {
    assert.equal(parseModelReply("Hello from CX.").text, "Hello from CX.");
    assert.equal(parseModelReply("Hello from CX.").tool, undefined);
  });
});
