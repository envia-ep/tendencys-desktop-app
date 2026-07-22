import assert from "node:assert/strict";
import {
  OPEN_DEEP_LINKS,
  OPEN_SERVICE_IDS,
  OPEN_SHELL_SECTION_IDS,
  extractOpenTarget,
  setPendingOpenTarget,
  takePendingOpenTarget,
} from "./pending-open-target.ts";

for (const serviceId of OPEN_SERVICE_IDS) {
  const link = OPEN_DEEP_LINKS[serviceId];
  assert.equal(link, `tendencys://open/${serviceId}`);
  assert.deepEqual(extractOpenTarget(link), { kind: "service", id: serviceId });
}

for (const sectionId of OPEN_SHELL_SECTION_IDS) {
  const link = OPEN_DEEP_LINKS[sectionId];
  assert.equal(link, `tendencys://open/${sectionId}`);
  assert.deepEqual(extractOpenTarget(link), { kind: "section", id: sectionId });
}

assert.equal(extractOpenTarget("tendencys://open/"), null);
assert.equal(extractOpenTarget("tendencys://open"), null);
assert.equal(extractOpenTarget("tendencys://open/not-a-real-target"), null);
assert.equal(extractOpenTarget("tendencys://authentication?authorization=x"), null);
assert.equal(extractOpenTarget("tendencys://open/envia-shipping/extra"), null);

setPendingOpenTarget({ kind: "section", id: "settings" });
assert.deepEqual(takePendingOpenTarget(), { kind: "section", id: "settings" });
assert.equal(takePendingOpenTarget(), null);

console.log(
  `pending-open-target.test.ts OK (${OPEN_SERVICE_IDS.length} products + ${OPEN_SHELL_SECTION_IDS.length} sections)`,
);
