import assert from "node:assert/strict";
import { resolveJarvisOpenService } from "./jarvis-open-service.ts";

assert.deepEqual(resolveJarvisOpenService("clients"), {
  kind: "service",
  id: "tendencys-partners",
});
assert.deepEqual(resolveJarvisOpenService("jarvis"), { kind: "section", id: "jarvis" });
assert.deepEqual(resolveJarvisOpenService("home"), { kind: "section", id: "home" });
assert.deepEqual(resolveJarvisOpenService("envia-shipping"), {
  kind: "service",
  id: "envia-shipping",
});
assert.equal(resolveJarvisOpenService("not-a-real-product"), null);

console.log("jarvis-open-service.test.ts OK");
