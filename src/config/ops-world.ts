/**
 * Pure geometry for the 2.5D logistics world (no Pixi/React imports).
 *
 * Coordinates live in a fixed logical world space; the Pixi camera scales it to
 * fit the viewport. Buildings reuse the node ids + service ids + accents from
 * `ops-scene.ts`. Routes are point arrays consumed directly by GSAP MotionPath.
 */

import type { OpsNodeId, OpsNodeMetaphor } from "./ops-scene";

export const OPS_WORLD = { width: 1600, height: 1000 } as const;

export type OpsBuilding = {
  id: OpsNodeId;
  /** Linked SERVICE id when clickable; null for the company hub. */
  serviceId: string | null;
  x: number;
  y: number;
  accent: string;
  metaphor: OpsNodeMetaphor;
  /** Footprint half-width in world units (controls sprite scale). */
  size: number;
};

export type Point = { x: number; y: number };

export type OpsRouteKind = "road" | "air" | "belt";

export type OpsRoute = {
  id: string;
  kind: OpsRouteKind;
  points: Point[];
};

export type OpsVehicleKind = "truck" | "plane" | "package" | "forklift";

export type OpsVehicle = {
  id: string;
  kind: OpsVehicleKind;
  routeId: string;
  /** Seconds for one full loop at 1x. */
  duration: number;
  /** Loop start offset (0..1) so vehicles on the same route are staggered. */
  offset?: number;
  accent?: string;
};

export const OPS_BUILDINGS: OpsBuilding[] = [
  { id: "company", serviceId: null, x: 800, y: 500, accent: "#0335a4", metaphor: "company", size: 78 },
  { id: "ecart-api", serviceId: "ecart-api", x: 800, y: 210, accent: "#0D9488", metaphor: "api", size: 50 },
  { id: "envia-shipping", serviceId: "envia-shipping", x: 360, y: 250, accent: "#0066CC", metaphor: "plane", size: 58 },
  { id: "envia-cargo", serviceId: "envia-cargo", x: 240, y: 470, accent: "#1A365D", metaphor: "truck", size: 52 },
  { id: "envia-fulfillment", serviceId: "envia-fulfillment", x: 470, y: 560, accent: "#2B6CB0", metaphor: "warehouse", size: 66 },
  { id: "envia-returns", serviceId: "envia-returns", x: 330, y: 790, accent: "#DD6B20", metaphor: "returns", size: 48 },
  { id: "parapaquetes", serviceId: "parapaquetes", x: 590, y: 820, accent: "#805AD5", metaphor: "supply", size: 46 },
  { id: "ecart-pay", serviceId: "ecart-pay", x: 1140, y: 470, accent: "#38A169", metaphor: "pay", size: 56 },
  { id: "ecart-banking", serviceId: "ecart-banking", x: 1350, y: 590, accent: "#1A202C", metaphor: "bank", size: 56 },
  { id: "tendencys-partners", serviceId: "tendencys-partners", x: 1230, y: 230, accent: "#6B46C1", metaphor: "partners", size: 48 },
];

const BUILDING_INDEX = new Map(OPS_BUILDINGS.map((b) => [b.id, b]));

export function getBuilding(id: OpsNodeId): OpsBuilding {
  const b = BUILDING_INDEX.get(id);
  if (!b) throw new Error(`Unknown ops building: ${id}`);
  return b;
}

/**
 * Racetrack loop between two buildings: out along one perpendicular offset and
 * back along the other, so a vehicle circulates smoothly instead of snapping.
 */
function loop(from: OpsNodeId, to: OpsNodeId, bend: number): Point[] {
  const a = getBuilding(from);
  const b = getBuilding(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const outCtrl: Point = { x: mx - dy * bend, y: my + dx * bend };
  const backCtrl: Point = { x: mx + dy * bend, y: my - dx * bend };
  return [
    { x: a.x, y: a.y },
    outCtrl,
    { x: b.x, y: b.y },
    backCtrl,
    { x: a.x, y: a.y },
  ];
}

/** Straight belt segment near a building for package flow. */
function belt(center: Point, length: number, angleDeg: number): Point[] {
  const rad = (angleDeg * Math.PI) / 180;
  const hx = (Math.cos(rad) * length) / 2;
  const hy = (Math.sin(rad) * length) / 2;
  return [
    { x: center.x - hx, y: center.y - hy },
    { x: center.x + hx, y: center.y + hy },
    { x: center.x - hx, y: center.y - hy },
  ];
}

export const OPS_ROUTES: OpsRoute[] = [
  { id: "road-cargo-ff", kind: "road", points: loop("envia-cargo", "envia-fulfillment", 0.18) },
  { id: "road-ff-company", kind: "road", points: loop("envia-fulfillment", "company", 0.14) },
  { id: "road-company-pay", kind: "road", points: loop("company", "ecart-pay", 0.12) },
  { id: "road-pay-bank", kind: "road", points: loop("ecart-pay", "ecart-banking", 0.2) },
  { id: "road-returns-ff", kind: "road", points: loop("envia-returns", "envia-fulfillment", 0.22) },
  { id: "road-supply-ff", kind: "road", points: loop("parapaquetes", "envia-fulfillment", 0.24) },
  { id: "air-ship-ff", kind: "air", points: loop("envia-shipping", "envia-fulfillment", 0.34) },
  { id: "air-ship-partners", kind: "air", points: loop("envia-shipping", "tendencys-partners", 0.16) },
  { id: "air-api-company", kind: "air", points: loop("ecart-api", "company", 0.28) },
  { id: "belt-ff", kind: "belt", points: belt({ x: 470, y: 560 }, 150, 20) },
];

const ROUTE_INDEX = new Map(OPS_ROUTES.map((r) => [r.id, r]));

export function getRoute(id: string): OpsRoute {
  const r = ROUTE_INDEX.get(id);
  if (!r) throw new Error(`Unknown ops route: ${id}`);
  return r;
}

export const OPS_VEHICLES: OpsVehicle[] = [
  { id: "truck-cargo-1", kind: "truck", routeId: "road-cargo-ff", duration: 14, offset: 0, accent: "#1A365D" },
  { id: "truck-cargo-2", kind: "truck", routeId: "road-cargo-ff", duration: 14, offset: 0.5, accent: "#2B6CB0" },
  { id: "truck-ff-company", kind: "truck", routeId: "road-ff-company", duration: 16, offset: 0.3, accent: "#2B6CB0" },
  { id: "truck-company-pay", kind: "truck", routeId: "road-company-pay", duration: 15, offset: 0.1, accent: "#38A169" },
  { id: "truck-pay-bank", kind: "truck", routeId: "road-pay-bank", duration: 13, offset: 0.6, accent: "#1A202C" },
  { id: "truck-returns", kind: "truck", routeId: "road-returns-ff", duration: 17, offset: 0.4, accent: "#DD6B20" },
  { id: "truck-supply", kind: "truck", routeId: "road-supply-ff", duration: 18, offset: 0.2, accent: "#805AD5" },
  { id: "plane-ship-ff", kind: "plane", routeId: "air-ship-ff", duration: 20, offset: 0, accent: "#0066CC" },
  { id: "plane-ship-partners", kind: "plane", routeId: "air-ship-partners", duration: 24, offset: 0.5, accent: "#6B46C1" },
  { id: "packet-api", kind: "package", routeId: "air-api-company", duration: 9, offset: 0, accent: "#0D9488" },
  { id: "packet-api-2", kind: "package", routeId: "air-api-company", duration: 9, offset: 0.5, accent: "#0D9488" },
  { id: "packet-belt-1", kind: "package", routeId: "belt-ff", duration: 6, offset: 0, accent: "#F6AD55" },
  { id: "packet-belt-2", kind: "package", routeId: "belt-ff", duration: 6, offset: 0.33, accent: "#F6AD55" },
  { id: "packet-belt-3", kind: "package", routeId: "belt-ff", duration: 6, offset: 0.66, accent: "#F6AD55" },
];
