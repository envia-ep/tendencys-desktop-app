import assert from "node:assert/strict";
import { mapJarvisFetchError } from "./jarvis-http.ts";

assert.equal(
  mapJarvisFetchError(new Error("Load failed"), "http://127.0.0.1:8788").message,
  "Cannot reach Jarvis at http://127.0.0.1:8788",
);
assert.equal(
  mapJarvisFetchError(new Error("Failed to fetch"), "http://127.0.0.1:8788").message,
  "Cannot reach Jarvis at http://127.0.0.1:8788",
);
assert.equal(
  mapJarvisFetchError(
    new Error("error sending request for url (http://127.0.0.1:8788/api/v1/health)"),
    "http://127.0.0.1:8788",
  ).message,
  "Cannot reach Jarvis at http://127.0.0.1:8788",
);
assert.equal(
  mapJarvisFetchError(new Error("Accounts authorization failed")).message,
  "Accounts authorization failed",
);

console.log("jarvis-http.test.ts OK");
