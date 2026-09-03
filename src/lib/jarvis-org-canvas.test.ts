import assert from "node:assert/strict";
import {
  clampZoom,
  clientToWorld,
  dropTarget,
  hitNode,
  zoomAtPoint,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./jarvis-org-canvas.ts";

assert.equal(clampZoom(0.1), ZOOM_MIN);
assert.equal(clampZoom(9), ZOOM_MAX);
assert.equal(clampZoom(1.2), 1.2);

assert.deepEqual(
  clientToWorld({ x: 130, y: 80 }, { left: 10, top: 20 }, { x: 20, y: 10 }, 2),
  { x: 50, y: 25 },
);

const zoomed = zoomAtPoint(1, 2, { x: 100, y: 50 }, { x: 0, y: 0 });
assert.equal(zoomed.zoom, 2);
assert.deepEqual(zoomed.pan, { x: -100, y: -50 });

const nodes = [
  { id: "me", kind: "human", x: 0, y: 0, width: 180, height: 78 },
  { id: "sales", kind: "unit", x: 200, y: 0, width: 180, height: 78 },
  { id: "cx", kind: "agent", x: 0, y: 120, width: 180, height: 78 },
];
const regions = [{ unitId: "sales", x: 180, y: 100, width: 240, height: 160 }];

assert.equal(hitNode(nodes, { x: 10, y: 10 })?.id, "me");
assert.deepEqual(dropTarget({ x: 10, y: 10 }, nodes, regions, "cx"), { kind: "person", id: "me" });
assert.deepEqual(dropTarget({ x: 220, y: 20 }, nodes, regions, "cx"), { kind: "unit", id: "sales" });
assert.deepEqual(dropTarget({ x: 200, y: 140 }, nodes, regions, "cx"), { kind: "unit", id: "sales" });
assert.equal(dropTarget({ x: 10, y: 10 }, nodes, regions, "me"), null);
assert.equal(dropTarget({ x: 900, y: 900 }, nodes, regions, "cx"), null);

console.log("jarvis-org-canvas.test.ts OK");
