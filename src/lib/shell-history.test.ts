import assert from "node:assert/strict";
import { createShellHistory, isAuthNoiseUrl } from "./shell-history.ts";

const h = createShellHistory();
h.push({ serviceId: "a", url: "https://a.example/" });
h.push({ serviceId: "b", url: "https://b.example/" });
h.push({ serviceId: "b", url: "https://b.example/orders" });
assert.equal(h.canGoBack(), true);
assert.equal(h.canGoForward(), false);

const back1 = h.back();
assert.deepEqual(back1, { serviceId: "b", url: "https://b.example/" });
const back2 = h.back();
assert.deepEqual(back2, { serviceId: "a", url: "https://a.example/" });
assert.equal(h.canGoBack(), false);

const fwd = h.forward();
assert.deepEqual(fwd, { serviceId: "b", url: "https://b.example/" });

h.setTraversing(true);
h.push({ serviceId: "c", url: "https://c.example/" });
assert.deepEqual(h.current(), { serviceId: "b", url: "https://b.example/" });
h.setTraversing(false);

h.push({ serviceId: "c", url: "https://c.example/" });
assert.equal(h.canGoForward(), false);
assert.deepEqual(h.current(), { serviceId: "c", url: "https://c.example/" });

h.replace({ serviceId: "c", url: "https://c.example/dash" });
assert.deepEqual(h.current(), { serviceId: "c", url: "https://c.example/dash" });

assert.equal(isAuthNoiseUrl("https://accounts.envia.com/login-sites"), true);
assert.equal(isAuthNoiseUrl("https://cargo.envia.com/loads"), false);

console.log("shell-history: ok");
