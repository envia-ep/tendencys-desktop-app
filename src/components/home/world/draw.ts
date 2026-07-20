/**
 * Programmatic Pixi sprite builders (Graphics only — no external art).
 * Company hub is an isometric building; service nodes are icon pads with a
 * unique metaphor silhouette. Vehicles face +x so GSAP MotionPath `autoRotate`
 * aligns them to the travel direction. A separate emissive layer (route pulses,
 * auras, spotlight) is bloomed in OpsWorld, so glow helpers stay plain shapes.
 */
import { Container, Graphics, Text } from "pixi.js";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { OPS_WORLD, type OpsRoute, type OpsVehicleKind } from "@/config/ops-world";
import type { OpsNodeMetaphor } from "@/config/ops-scene";
import { routeCurviness } from "@/lib/ops-sim/scripted-source";

export function hexToNum(hex: string): number {
  return Number.parseInt(hex.replace("#", ""), 16);
}

function shade(hex: string, amount: number): number {
  const n = hexToNum(hex);
  let r = (n >> 16) & 0xff;
  let g = (n >> 8) & 0xff;
  let b = n & 0xff;
  const t = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  r = Math.round((t - r) * p) + r;
  g = Math.round((t - g) * p) + g;
  b = Math.round((t - b) * p) + b;
  return (r << 16) | (g << 8) | b;
}

/** Soft additive radial blob built from stacked translucent circles. */
function radialGlow(
  g: Graphics,
  cx: number,
  cy: number,
  radius: number,
  color: number,
  steps = 5,
  alpha = 0.12,
): void {
  for (let i = steps; i >= 1; i -= 1) {
    g.circle(cx, cy, (radius * i) / steps).fill({ color, alpha });
  }
}

// --- Ground -------------------------------------------------------------

/** Dark, depth-rich floor: hub glow + faint tech grid (CSS supplies vignette). */
export function drawGround(): Container {
  const c = new Container();
  const { width, height } = OPS_WORLD;

  const floor = new Graphics();
  radialGlow(floor, 800, 520, 560, 0x0a56c0, 6, 0.05);
  c.addChild(floor);

  const grid = new Graphics();
  const step = 80;
  for (let x = 0; x <= width; x += step) grid.moveTo(x, 0).lineTo(x, height);
  for (let y = 0; y <= height; y += step) grid.moveTo(0, y).lineTo(width, y);
  grid.stroke({ width: 1, color: 0x1c3f77, alpha: 0.4 });
  c.addChild(grid);

  return c;
}

// --- Routes -------------------------------------------------------------

const ROUTE_STYLE: Record<
  OpsRoute["kind"],
  { core: number; glow: number; center: number; width: number }
> = {
  road: { core: 0x2b6cb0, glow: 0x0074ff, center: 0xbfe0ff, width: 6 },
  air: { core: 0x3aa0ff, glow: 0x0074ff, center: 0xd6ecff, width: 3 },
  belt: { core: 0xdd6b20, glow: 0xf6ad55, center: 0xffe4c2, width: 12 },
};

export function rawPathFor(route: OpsRoute) {
  return MotionPathPlugin.arrayToRawPath(
    route.points.map((p) => ({ x: p.x, y: p.y })),
    { curviness: routeCurviness(route.kind) },
  );
}

function traceRaw(g: Graphics, raw: ReturnType<typeof rawPathFor>, steps = 90): void {
  for (let i = 0; i <= steps; i += 1) {
    const pos = MotionPathPlugin.getPositionOnPath(raw, i / steps);
    if (i === 0) g.moveTo(pos.x, pos.y);
    else g.lineTo(pos.x, pos.y);
  }
}

/** Glowing energy lane: wide soft halo + solid core + bright centerline. */
export function drawRoute(route: OpsRoute): Container {
  const s = ROUTE_STYLE[route.kind];
  const raw = rawPathFor(route);
  const c = new Container();

  const halo = new Graphics();
  traceRaw(halo, raw);
  halo.stroke({ width: s.width + 12, color: s.glow, alpha: 0.1, cap: "round" });

  const core = new Graphics();
  traceRaw(core, raw);
  core.stroke({ width: s.width, color: s.core, alpha: 0.85, cap: "round" });

  const center = new Graphics();
  traceRaw(center, raw);
  center.stroke({ width: 2, color: s.center, alpha: 0.5, cap: "round" });

  c.addChild(halo, core, center);
  return c;
}

export function routePulseColor(kind: OpsRoute["kind"]): number {
  return ROUTE_STYLE[kind].center;
}

// --- Buildings ----------------------------------------------------------

/** Lit windows across one sheared wall, from a corner + two basis vectors. */
function addWindows(
  g: Graphics,
  ox: number,
  oy: number,
  ax: number,
  ay: number,
  ux: number,
  uy: number,
  color: number,
): void {
  const cols = 2;
  const rows = 3;
  const wa = 0.24;
  const wu = 0.18;
  for (let ci = 0; ci < cols; ci += 1) {
    for (let ri = 0; ri < rows; ri += 1) {
      const a = 0.22 + ci * 0.36;
      const u = 0.24 + ri * 0.26;
      const px = ox + a * ax + u * ux;
      const py = oy + a * ay + u * uy;
      const p2x = px + wa * ax;
      const p2y = py + wa * ay;
      const p3x = p2x + wu * ux;
      const p3y = p2y + wu * uy;
      const p4x = px + wu * ux;
      const p4y = py + wu * uy;
      g.poly([px, py, p2x, p2y, p3x, p3y, p4x, p4y]).fill({
        color,
        alpha: 0.9,
      });
    }
  }
}

/** Isometric building block centered on its ground point (0,0). */
export function drawBuilding(accent: string, size: number, label: string): Container {
  const c = new Container();
  const hw = size;
  const hh = size / 2;
  const elev = size * 0.95;

  const top = shade(accent, 0.34);
  const left = shade(accent, 0.04);
  const right = shade(accent, -0.34);
  const windowColor = shade(accent, 0.62);

  // contact shadow
  const shadow = new Graphics()
    .ellipse(0, hh * 0.55, hw * 1.25, hh * 1.2)
    .fill({ color: 0x00060f, alpha: 0.35 });
  c.addChild(shadow);

  const body = new Graphics();
  body.poly([-hw, 0, 0, hh, 0, hh - elev, -hw, -elev]).fill({ color: left });
  body.poly([hw, 0, 0, hh, 0, hh - elev, hw, -elev]).fill({ color: right });
  body.poly([0, -hh - elev, hw, -elev, 0, hh - elev, -hw, -elev]).fill({ color: top });
  // vertical gradient feel: lighter band near the roofline of each wall
  body
    .poly([-hw, -elev * 0.55, 0, hh - elev * 0.55, 0, hh - elev, -hw, -elev])
    .fill({ color: shade(accent, 0.18), alpha: 0.5 });
  body
    .poly([hw, -elev * 0.55, 0, hh - elev * 0.55, 0, hh - elev, hw, -elev])
    .fill({ color: shade(accent, -0.12), alpha: 0.5 });
  c.addChild(body);

  // lit windows
  const windows = new Graphics();
  addWindows(windows, -hw, 0, hw, hh, 0, -elev, windowColor); // left wall
  addWindows(windows, hw, 0, -hw, hh, 0, -elev, windowColor); // right wall
  c.addChild(windows);

  // roof ridge accent
  const ridge = new Graphics()
    .poly([0, -hh - elev, hw * 0.5, -elev - hh * 0.5, 0, -elev, -hw * 0.5, -elev - hh * 0.5])
    .fill({ color: shade(accent, 0.6), alpha: 0.7 });
  c.addChild(ridge);

  const text = new Text({
    text: label,
    style: {
      fill: 0xdbeafe,
      fontSize: 15,
      fontFamily: "Inter, system-ui, sans-serif",
      fontWeight: "600",
      dropShadow: {
        color: 0x00060f,
        blur: 4,
        distance: 1,
        alpha: 0.8,
        angle: Math.PI / 2,
      },
    },
  });
  text.anchor.set(0.5, 0);
  text.position.set(0, hh + 10);
  c.addChild(text);

  return c;
}

/** Bright ring placed under a selected building/pad (emissive layer). */
export function drawSpotlight(accent: string, size: number): Graphics {
  const g = new Graphics();
  g.ellipse(0, size * 0.4, size * 1.5, size * 0.75).stroke({
    width: 3,
    color: shade(accent, 0.5),
    alpha: 0.9,
  });
  radialGlow(g, 0, size * 0.4, size * 1.6, hexToNum(accent), 5, 0.05);
  return g;
}

// --- Icon pads (service nodes) ------------------------------------------

function nodeLabel(label: string, y: number, fontSize = 14): Text {
  const text = new Text({
    text: label,
    style: {
      fill: 0xdbeafe,
      fontSize,
      fontFamily: "Inter, system-ui, sans-serif",
      fontWeight: "600",
      dropShadow: {
        color: 0x00060f,
        blur: 4,
        distance: 1,
        alpha: 0.8,
        angle: Math.PI / 2,
      },
    },
  });
  text.anchor.set(0.5, 0);
  text.position.set(0, y);
  return text;
}

/** Distinct silhouette per ops metaphor, centered at (0,0). Scale is ~pad radius. */
export function drawMetaphorIcon(metaphor: OpsNodeMetaphor, accent: string, size: number): Container {
  const c = new Container();
  const g = new Graphics();
  const col = hexToNum(accent);
  const light = shade(accent, 0.45);
  const dark = shade(accent, -0.3);
  // Large glyphs so pads never read as “another building”.
  const s = size * 0.72;

  if (metaphor === "plane") {
    g.poly([s * 0.95, 0, -s * 0.45, -s * 0.32, -s * 0.18, 0, -s * 0.45, s * 0.32]).fill({
      color: col,
    });
    g.poly([s * 0.1, -s * 0.08, -s * 0.55, -s * 0.75, -s * 0.25, -s * 0.08]).fill({ color: light });
    g.poly([s * 0.1, s * 0.08, -s * 0.55, s * 0.75, -s * 0.25, s * 0.08]).fill({ color: light });
    g.poly([-s * 0.35, -s * 0.05, -s * 0.8, -s * 0.35, -s * 0.55, -s * 0.05]).fill({ color: dark });
    g.circle(s * 0.45, 0, s * 0.1).fill({ color: 0xcbe6ff });
  } else if (metaphor === "truck") {
    g.roundRect(-s * 0.85, -s * 0.35, s * 1.0, s * 0.7, 3).fill({ color: dark });
    g.roundRect(-s * 0.85, -s * 0.35, s * 1.0, s * 0.18, 3).fill({ color: light, alpha: 0.7 });
    g.roundRect(s * 0.15, -s * 0.4, s * 0.65, s * 0.8, 3).fill({ color: col });
    g.roundRect(s * 0.55, -s * 0.22, s * 0.2, s * 0.28, 1).fill({ color: 0xcbe6ff });
    g.circle(-s * 0.45, s * 0.42, s * 0.16).fill({ color: 0x0b1220 });
    g.circle(s * 0.45, s * 0.42, s * 0.16).fill({ color: 0x0b1220 });
  } else if (metaphor === "warehouse") {
    g.poly([
      -s * 0.95,
      s * 0.15,
      -s * 0.95,
      -s * 0.25,
      0,
      -s * 0.75,
      s * 0.95,
      -s * 0.25,
      s * 0.95,
      s * 0.15,
    ]).fill({ color: col });
    g.poly([-s * 0.95, -s * 0.25, 0, -s * 0.75, s * 0.95, -s * 0.25, 0, -s * 0.05]).fill({
      color: light,
    });
    g.roundRect(-s * 0.35, -s * 0.05, s * 0.7, s * 0.55, 2).fill({ color: dark });
    g.rect(-s * 0.2, s * 0.15, s * 0.4, s * 0.35).fill({ color: 0x0b1220, alpha: 0.55 });
  } else if (metaphor === "returns") {
    // U-turn arrow (no stroke arc — poly only for Pixi reliability)
    g.roundRect(-s * 0.28, -s * 0.35, s * 0.56, s * 0.56, 3).fill({ color: dark });
    g.rect(-s * 0.28, -s * 0.05, s * 0.56, s * 0.12).fill({ color: light, alpha: 0.9 });
    g.rect(-s * 0.06, -s * 0.35, s * 0.12, s * 0.56).fill({ color: light, alpha: 0.9 });
    g.poly([
      s * 0.2,
      -s * 0.7,
      s * 0.75,
      -s * 0.35,
      s * 0.45,
      -s * 0.35,
      s * 0.45,
      s * 0.15,
      -s * 0.15,
      s * 0.15,
      -s * 0.15,
      s * 0.4,
      -s * 0.55,
      s * 0.4,
      -s * 0.55,
      -s * 0.15,
      s * 0.2,
      -s * 0.15,
    ]).fill({ color: col });
    g.poly([s * 0.2, -s * 0.7, s * 0.75, -s * 0.35, s * 0.35, -s * 0.25]).fill({ color: light });
  } else if (metaphor === "pay") {
    g.roundRect(-s * 0.75, -s * 0.5, s * 1.5, s * 1.0, 5).fill({ color: col });
    g.roundRect(-s * 0.75, -s * 0.2, s * 1.5, s * 0.28, 0).fill({ color: dark });
    g.roundRect(-s * 0.55, s * 0.2, s * 0.45, s * 0.16, 2).fill({ color: light });
    g.circle(s * 0.4, s * 0.28, s * 0.12).fill({ color: light, alpha: 0.85 });
  } else if (metaphor === "bank") {
    g.poly([-s * 0.9, -s * 0.15, 0, -s * 0.75, s * 0.9, -s * 0.15]).fill({ color: light });
    g.rect(-s * 0.85, -s * 0.15, s * 1.7, s * 0.12).fill({ color: col });
    for (const x of [-s * 0.55, -s * 0.15, s * 0.25]) {
      g.rect(x, -s * 0.03, s * 0.22, s * 0.55).fill({ color: col });
    }
    g.rect(-s * 0.95, s * 0.5, s * 1.9, s * 0.18).fill({ color: dark });
  } else if (metaphor === "api") {
    g.circle(-s * 0.55, 0, s * 0.28).fill({ color: col });
    g.circle(s * 0.55, -s * 0.35, s * 0.22).fill({ color: light });
    g.circle(s * 0.45, s * 0.4, s * 0.22).fill({ color: light });
    g.moveTo(-s * 0.3, -s * 0.1)
      .lineTo(s * 0.35, -s * 0.3)
      .stroke({ width: s * 0.12, color: dark, cap: "round" });
    g.moveTo(-s * 0.3, s * 0.12)
      .lineTo(s * 0.28, s * 0.32)
      .stroke({ width: s * 0.12, color: dark, cap: "round" });
    g.roundRect(-s * 0.2, -s * 0.55, s * 0.18, s * 0.18, 2).fill({ color: 0xcbe6ff, alpha: 0.9 });
    g.roundRect(s * 0.02, -s * 0.55, s * 0.18, s * 0.18, 2).fill({ color: 0xcbe6ff, alpha: 0.9 });
  } else if (metaphor === "supply") {
    g.roundRect(-s * 0.7, s * 0.05, s * 0.7, s * 0.55, 2).fill({ color: dark });
    g.roundRect(-s * 0.05, s * 0.05, s * 0.7, s * 0.55, 2).fill({ color: col });
    g.roundRect(-s * 0.35, -s * 0.55, s * 0.7, s * 0.55, 2).fill({ color: light });
    g.rect(-s * 0.35, -s * 0.3, s * 0.7, s * 0.1).fill({ color: col, alpha: 0.7 });
    g.rect(-s * 0.7, s * 0.28, s * 0.7, s * 0.1).fill({ color: light, alpha: 0.6 });
    g.rect(-s * 0.05, s * 0.28, s * 0.7, s * 0.1).fill({ color: light, alpha: 0.6 });
  } else if (metaphor === "partners") {
    g.circle(-s * 0.35, -s * 0.25, s * 0.28).fill({ color: col });
    g.ellipse(-s * 0.35, s * 0.35, s * 0.42, s * 0.32).fill({ color: col });
    g.circle(s * 0.35, -s * 0.25, s * 0.28).fill({ color: light });
    g.ellipse(s * 0.35, s * 0.35, s * 0.42, s * 0.32).fill({ color: light });
    g.circle(0, s * 0.05, s * 0.18).fill({ color: dark });
  } else {
    // company / fallback: small diamond mark (company uses drawBuilding)
    g.poly([0, -s * 0.7, s * 0.55, 0, 0, s * 0.7, -s * 0.55, 0]).fill({ color: col });
  }

  c.addChild(g);
  return c;
}

/** Circular glowing pad + large metaphor icon + label — not a building. */
export function drawIconPad(
  metaphor: OpsNodeMetaphor,
  accent: string,
  size: number,
  label: string,
): Container {
  const c = new Container();
  const col = hexToNum(accent);
  const r = size * 0.95;
  const iconLift = -size * 0.55;

  const shadow = new Graphics()
    .ellipse(0, r * 0.55, r * 1.35, r * 0.55)
    .fill({ color: 0x00060f, alpha: 0.45 });
  c.addChild(shadow);

  const glow = new Graphics();
  radialGlow(glow, 0, iconLift * 0.2, r * 1.6, col, 6, 0.08);
  c.addChild(glow);

  // Ground disc
  const pad = new Graphics()
    .ellipse(0, r * 0.15, r * 1.2, r * 0.48)
    .fill({ color: shade(accent, -0.5), alpha: 0.9 });
  pad.ellipse(0, r * 0.15, r * 1.2, r * 0.48).stroke({
    width: 3,
    color: shade(accent, 0.4),
    alpha: 0.9,
  });
  c.addChild(pad);

  // Floating circular badge holding the icon
  const badge = new Graphics()
    .circle(0, iconLift, r * 0.85)
    .fill({ color: shade(accent, -0.25), alpha: 0.95 });
  badge.circle(0, iconLift, r * 0.85).stroke({
    width: 3.5,
    color: shade(accent, 0.55),
    alpha: 1,
  });
  badge.circle(0, iconLift, r * 0.72).fill({ color: shade(accent, -0.05), alpha: 0.35 });
  c.addChild(badge);

  const icon = drawMetaphorIcon(metaphor, accent, size);
  icon.position.set(0, iconLift);
  c.addChild(icon);

  c.addChild(nodeLabel(label, r * 0.75, 15));
  return c;
}

// --- Vehicles -----------------------------------------------------------

function wheels(g: Graphics, xs: number[], y: number, r: number): void {
  for (const x of xs) g.circle(x, y, r).fill({ color: 0x0b1220 });
}

/** Vehicle sprite centered at (0,0), nose pointing +x. */
export function drawVehicle(kind: OpsVehicleKind, accent: string): Container {
  const c = new Container();
  const col = hexToNum(accent);
  const g = new Graphics();

  if (kind === "truck") {
    g.roundRect(-22, -9, 26, 18, 3).fill({ color: shade(accent, -0.1) }); // trailer
    g.roundRect(-22, -9, 26, 4, 3).fill({ color: shade(accent, 0.2), alpha: 0.6 }); // trailer top light
    g.roundRect(4, -10, 16, 20, 3).fill({ color: col }); // cab
    g.roundRect(16, -6, 5, 7, 1).fill({ color: 0xcbe6ff }); // windshield
    wheels(g, [-14, 12], 11, 4);
  } else if (kind === "plane") {
    g.poly([22, 0, -10, -7, -4, 0, -10, 7]).fill({ color: col }); // fuselage
    g.poly([2, -2, -14, -18, -6, -2]).fill({ color: shade(accent, 0.32) }); // wing up
    g.poly([2, 2, -14, 18, -6, 2]).fill({ color: shade(accent, 0.32) }); // wing down
    g.poly([-8, -1, -18, -8, -12, -1]).fill({ color: shade(accent, -0.2) }); // tail
    g.circle(10, 0, 2.4).fill({ color: 0xcbe6ff }); // cockpit
  } else if (kind === "package") {
    g.roundRect(-8, -8, 16, 16, 2).fill({ color: col });
    g.rect(-8, -1.5, 16, 3).fill({ color: shade(accent, 0.45), alpha: 0.95 });
    g.rect(-1.5, -8, 3, 16).fill({ color: shade(accent, 0.45), alpha: 0.95 });
  } else {
    // forklift
    g.roundRect(-10, -8, 16, 16, 2).fill({ color: col });
    g.rect(6, -7, 10, 2).fill({ color: 0x0b1220 });
    g.rect(6, 5, 10, 2).fill({ color: 0x0b1220 });
    wheels(g, [-6, 4], 9, 3);
  }

  c.addChild(g);
  return c;
}

/** Soft aura that trails a moving vehicle (emissive layer). */
export function drawVehicleGlow(kind: OpsVehicleKind, accent: string): Graphics {
  const g = new Graphics();
  const r = kind === "plane" ? 26 : kind === "truck" ? 22 : 14;
  radialGlow(g, 0, 0, r, hexToNum(accent), 4, 0.11);
  return g;
}

/** Small bright travelling dot for the route flow (emissive layer). */
export function drawPulseDot(color: number, radius = 4): Graphics {
  const g = new Graphics();
  radialGlow(g, 0, 0, radius * 3, color, 4, 0.13);
  g.circle(0, 0, radius).fill({ color: 0xffffff, alpha: 0.95 });
  g.circle(0, 0, radius * 1.8).fill({ color, alpha: 0.5 });
  return g;
}
