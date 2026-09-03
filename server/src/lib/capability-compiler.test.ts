import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileCapabilities, compileCapabilitiesOffline } from "./capability-compiler.ts";

describe("compileCapabilitiesOffline", () => {
  it("maps a commerce + email prompt to canonical capabilities", () => {
    const caps = compileCapabilitiesOffline(
      "find customers who bought last month and send them an email",
    );
    const ids = caps.map((row) => row.id).sort();
    assert.deepEqual(ids, ["commerce.customer.search", "email.message.send"]);
    assert.deepEqual(
      caps.map((row) => row.purpose).sort(),
      ["commerce", "email"],
    );
  });

  it("returns nothing for a prompt with no external capability", () => {
    assert.deepEqual(compileCapabilitiesOffline("remember that I like tea"), []);
  });
});

describe("compileCapabilities", () => {
  it("falls back to offline compilation when no model key is set", async () => {
    const caps = await compileCapabilities("send them an email");
    assert.deepEqual(caps.map((row) => row.id), ["email.message.send"]);
  });
});
