import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * ponytail: assert registerFailureUserMessage stays in device-keys.ts and matches
 * the user-visible copy contract (no silent swallow). Avoid importing device-keys.ts
 * (it pulls Vite env via services).
 * Run: npx tsx src/lib/device-keys-register.test.ts
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "device-keys.ts"), "utf8");

assert.match(
  source,
  /export function registerFailureUserMessage/,
  "registerFailureUserMessage must be exported",
);
assert.match(source, /ssoCaptureFailure\(/);
assert.match(source, /device_key\.register/);
assert.match(source, /Could not link this computer for silent sign-in/);
assert.match(source, /maximum number of linked devices/);
assert.match(
  source,
  /Promise<RegisterDeviceKeyResult>/,
  "registerDeviceKey must return a result (not void)",
);

console.log("device-keys-register: ok");
