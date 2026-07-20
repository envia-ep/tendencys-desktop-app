/**
 * Pure geometry for the 2.5D logistics world (no Pixi/React imports).
 *
 * Coordinates live in a fixed logical world space; the Pixi camera scales it to
 * fit the viewport. Buildings reuse the node ids + service ids + accents from
 * `ops-scene.ts`. Routes are open arcs (hub-and-spoke) consumed by GSAP MotionPath.
 */

import type { OpsNodeId, OpsNodeMetaphor } from "./ops-scene";

export const OPS_WORLD = { width: 1600, height: 1000 } as const;

/** Bump when world geometry/sprites change so OpsWorld remounts the Pixi scene. */
export const OPS_SCENE_REVISION = 3;

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

/**
 * Clusters (breathing room so spokes rarely cross):
 * - Center: company hub
 * - Left: logistics (shipping, cargo, fulfillment)
 * - Bottom-left: returns + supplies
 * - Top: API
 * - Top-right: partners
 * - Right: pay + banking
 */
export const OPS_BUILDINGS: OpsBuilding[] = [
  { id: "company", serviceId: null, x: 800, y: 500, accent: "#0335a4", metaphor: "company", size: 78 },
  { id: "ecart-api", serviceId: "ecart-api", x: 800, y: 180, accent: "#0D9488", metaphor: "api", size: 48 },
  { id: "envia-shipping", serviceId: "envia-shipping", x: 320, y: 280, accent: "#0066CC", metaphor: "plane", size: 52 },
  { id: "envia-cargo", serviceId: "envia-cargo", x: 220, y: 520, accent: "#1A365D", metaphor: "truck", size: 50 },
  { id: "envia-fulfillment", serviceId: "envia-fulfillment", x: 420, y: 620, accent: "#2B6CB0", metaphor: "warehouse", size: 58 },
  { id: "envia-returns", serviceId: "envia-returns", x: 280, y: 820, accent: "#DD6B20", metaphor: "returns", size: 46 },
  { id: "parapaquetes", serviceId: "parapaquetes", x: 520, y: 840, accent: "#805AD5", metaphor: "supply", size: 46 },
  { id: "ecart-pay", serviceId: "ecart-pay", x: 1180, y: 420, accent: "#38A169", metaphor: "pay", size: 52 },
  { id: "ecart-banking", serviceId: "ecart-banking", x: 1380, y: 620, accent: "#1A202C", metaphor: "bank", size: 52 },
  { id: "tendencys-partners", serviceId: "tendencys-partners", x: 1220, y: 220, accent: "#6B46C1", metaphor: "partners", size: 48 },
];

const BUILDING_INDEX = new Map(OPS_BUILDINGS.map((b) => [b.id, b]));

export function getBuilding(id: OpsNodeId): OpsBuilding {
  const b = BUILDING_INDEX.get(id);
  if (!b) throw new Error(`Unknown ops building: ${id}`);
  return b;
}

/**
 * Open arc between two buildings: start → perpendicular bend control → end.
 * Vehicles yoyo along this path (see scripted-source).
 */
function arc(from: OpsNodeId, to: OpsNodeId, bend = 0.12): Point[] {
  const a = getBuilding(from);
  const b = getBuilding(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  return [
    { x: a.x, y: a.y },
    { x: mx - dy * bend, y: my + dx * bend },
    { x: b.x, y: b.y },
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
  ];
}

export const OPS_ROUTES: OpsRoute[] = [
  // Hub spokes
  { id: "spoke-company-shipping", kind: "road", points: arc("company", "envia-shipping", 0.1) },
  { id: "spoke-company-cargo", kind: "road", points: arc("company", "envia-cargo", 0.08) },
  { id: "spoke-company-ff", kind: "road", points: arc("company", "envia-fulfillment", 0.1) },
  { id: "spoke-company-api", kind: "air", points: arc("company", "ecart-api", 0.06) },
  { id: "spoke-company-pay", kind: "road", points: arc("company", "ecart-pay", 0.08) },
  { id: "spoke-company-bank", kind: "road", points: arc("company", "ecart-banking", -0.1) },
  { id: "spoke-company-partners", kind: "air", points: arc("company", "tendencys-partners", 0.1) },
  // Domain satellites
  { id: "link-ff-returns", kind: "road", points: arc("envia-fulfillment", "envia-returns", 0.14) },
  { id: "link-ff-supply", kind: "road", points: arc("envia-fulfillment", "parapaquetes", 0.12) },
  { id: "link-ff-shipping", kind: "air", points: arc("envia-fulfillment", "envia-shipping", 0.16) },
  { id: "link-pay-bank", kind: "road", points: arc("ecart-pay", "ecart-banking", 0.14) },
  // Fulfillment belt
  { id: "belt-ff", kind: "belt", points: belt({ x: 420, y: 620 }, 140, 18) },
];

const ROUTE_INDEX = new Map(OPS_ROUTES.map((r) => [r.id, r]));

export function getRoute(id: string): OpsRoute {
  const r = ROUTE_INDEX.get(id);
  if (!r) throw new Error(`Unknown ops route: ${id}`);
  return r;
}

export const OPS_VEHICLES: OpsVehicle[] = [
  { id: "truck-company-shipping", kind: "truck", routeId: "spoke-company-shipping", duration: 14, offset: 0, accent: "#0066CC" },
  { id: "truck-company-cargo", kind: "truck", routeId: "spoke-company-cargo", duration: 13, offset: 0.35, accent: "#1A365D" },
  { id: "truck-company-ff", kind: "truck", routeId: "spoke-company-ff", duration: 15, offset: 0.2, accent: "#2B6CB0" },
  { id: "truck-ff-returns", kind: "truck", routeId: "link-ff-returns", duration: 12, offset: 0.4, accent: "#DD6B20" },
  { id: "truck-ff-supply", kind: "truck", routeId: "link-ff-supply", duration: 13, offset: 0.15, accent: "#805AD5" },
  { id: "truck-company-pay", kind: "truck", routeId: "spoke-company-pay", duration: 14, offset: 0.1, accent: "#38A169" },
  { id: "truck-company-bank", kind: "truck", routeId: "spoke-company-bank", duration: 15, offset: 0.3, accent: "#1A202C" },
  { id: "truck-pay-bank", kind: "truck", routeId: "link-pay-bank", duration: 11, offset: 0.55, accent: "#1A202C" },
  { id: "plane-ff-shipping", kind: "plane", routeId: "link-ff-shipping", duration: 16, offset: 0, accent: "#0066CC" },
  { id: "plane-company-partners", kind: "plane", routeId: "spoke-company-partners", duration: 18, offset: 0.4, accent: "#6B46C1" },
  { id: "packet-api", kind: "package", routeId: "spoke-company-api", duration: 8, offset: 0, accent: "#0D9488" },
  { id: "packet-api-2", kind: "package", routeId: "spoke-company-api", duration: 8, offset: 0.5, accent: "#0D9488" },
  { id: "packet-belt-1", kind: "package", routeId: "belt-ff", duration: 6, offset: 0, accent: "#F6AD55" },
  { id: "packet-belt-2", kind: "package", routeId: "belt-ff", duration: 6, offset: 0.33, accent: "#F6AD55" },
  { id: "packet-belt-3", kind: "package", routeId: "belt-ff", duration: 6, offset: 0.66, accent: "#F6AD55" },
];
