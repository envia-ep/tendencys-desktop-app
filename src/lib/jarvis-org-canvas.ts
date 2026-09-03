export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 2.5;

export type Point = { x: number; y: number };

export type CanvasBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DropTarget = { kind: "person" | "unit"; id: string };

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export function clientToWorld(
  client: Point,
  rect: { left: number; top: number },
  pan: Point,
  zoom: number,
): Point {
  return {
    x: (client.x - rect.left - pan.x) / zoom,
    y: (client.y - rect.top - pan.y) / zoom,
  };
}

export function zoomAtPoint(
  currentZoom: number,
  factor: number,
  cursor: Point,
  pan: Point,
): { zoom: number; pan: Point } {
  const next = clampZoom(currentZoom * factor);
  const worldX = (cursor.x - pan.x) / currentZoom;
  const worldY = (cursor.y - pan.y) / currentZoom;
  return {
    zoom: next,
    pan: {
      x: cursor.x - worldX * next,
      y: cursor.y - worldY * next,
    },
  };
}

export function hitBox<T extends { x: number; y: number; width: number; height: number }>(
  boxes: T[],
  point: Point,
): T | null {
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const box = boxes[i];
    if (!box) {
      continue;
    }
    if (
      point.x >= box.x &&
      point.x <= box.x + box.width &&
      point.y >= box.y &&
      point.y <= box.y + box.height
    ) {
      return box;
    }
  }
  return null;
}

export function hitNode<T extends CanvasBox>(nodes: T[], point: Point): T | null {
  return hitBox(nodes, point);
}

export function hitRegion<T extends { unitId: string; x: number; y: number; width: number; height: number }>(
  regions: T[],
  point: Point,
): T | null {
  return hitBox(regions, point);
}

export function dropTarget(
  point: Point,
  nodes: Array<CanvasBox & { kind: string }>,
  regions: Array<{ unitId: string; x: number; y: number; width: number; height: number }>,
  draggingId: string,
): DropTarget | null {
  const node = hitNode(nodes, point);
  if (node && node.id !== draggingId) {
    if (node.kind === "unit") {
      return { kind: "unit", id: node.id };
    }
    if (node.kind === "human" || node.kind === "agent") {
      return { kind: "person", id: node.id };
    }
  }
  const region = hitRegion(regions, point);
  if (region) {
    return { kind: "unit", id: region.unitId };
  }
  return null;
}
