/**
 * Framework-free geometry self-check (no test runner in this repo).
 * Run with: `npx tsx src/config/ops-world.test.ts` — exits non-zero on failure.
 */
import assert from "node:assert/strict";
import {
  OPS_BUILDINGS,
  OPS_ROUTES,
  OPS_VEHICLES,
  OPS_WORLD,
  getRoute,
} from "./ops-world";

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x <= OPS_WORLD.width && y >= 0 && y <= OPS_WORLD.height;
}

export function checkOpsWorld(): void {
  for (const b of OPS_BUILDINGS) {
    assert.ok(inBounds(b.x, b.y), `building ${b.id} out of bounds`);
    assert.ok(b.size > 0, `building ${b.id} needs positive size`);
  }

  for (const r of OPS_ROUTES) {
    assert.ok(r.points.length >= 2, `route ${r.id} needs >= 2 points`);
    for (const p of r.points) {
      assert.ok(inBounds(p.x, p.y), `route ${r.id} point out of bounds`);
    }
  }

  for (const v of OPS_VEHICLES) {
    assert.doesNotThrow(() => getRoute(v.routeId), `vehicle ${v.id} route`);
    assert.ok(v.duration > 0, `vehicle ${v.id} needs positive duration`);
  }
}

// Execute when run directly (tsx/node), stay silent when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  checkOpsWorld();
  console.log("ops-world geometry OK");
}
