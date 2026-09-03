import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleFromName, parseHandlePrefix } from "./handles.ts";

describe("handles", () => {
  it("slugs the first word of a specialist name", () => {
    assert.equal(handleFromName("CX Specialist"), "cx");
    assert.equal(handleFromName("Jarvis"), "jarvis");
    assert.equal(handleFromName("Sales"), "sales");
  });

  it("parses @handle at the start of a prompt", () => {
    assert.deepEqual(parseHandlePrefix("@cx remember that I prefer DHL"), {
      handle: "cx",
      body: "remember that I prefer DHL",
    });
    assert.equal(parseHandlePrefix("remember that I prefer DHL"), null);
  });
});
