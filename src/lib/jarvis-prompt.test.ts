import assert from "node:assert/strict";
import { applyAgentHandle } from "./jarvis-prompt.ts";

assert.equal(applyAgentHandle("", "sales"), "@sales ");
assert.equal(applyAgentHandle("hello", "sales"), "@sales hello");
assert.equal(applyAgentHandle("@cx", "sales"), "@sales ");
assert.equal(applyAgentHandle("@cx ", "sales"), "@sales ");
assert.equal(applyAgentHandle("@cx follow up", "sales"), "@sales follow up");
assert.equal(applyAgentHandle("@sales already here", "sales"), "@sales already here");

console.log("jarvis-prompt.test.ts OK");
