/**
 * Programmatic Pixi sprite builders (Graphics only — no external art).
 * Buildings are stylized isometric blocks; vehicles are drawn facing +x so GSAP
 * MotionPath `autoRotate` aligns them to the travel direction.
 */
import { Container, Graphics, Text } from "pixi.js";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { OPS_WORLD, type OpsRoute, type OpsVehicleKind } from "@/config/ops-world";
import { routeCurviness } from "@/lib/ops-sim/scripted-source";

export function hexToNum(hex: string): number {
  return Number.parseInt(hex.replace("#", ""), 16);
}

/** Soft base plate + subtle iso grid so the world reads as a surface. */
export function drawGround(): Container {
  const c = new Container();
  const { width, height } = OPS_WORLD;
  const pad = 120;

  const plate = new Graphics()
    .roundRect(-pad, -pad, width + pad * 2, height + pad * 2, 48)
    .fill({ color: 0xeef3fb });
  c.addChild(plate);

  const grid = new Graphics();
  const step = 80;
  for (let x = 0; x <= width; x += step) {
    grid.moveTo(x, 0).lineTo(x, height);
  }
  for (let y = 0; y <= height; y += step) {
    grid.moveTo(0, y).lineTo(width, y);
  }
  grid.stroke({ width: 1, color: 0xc7d6ee, alpha: 0.5 });
  c.addChild(grid);

  return c;
}

/** Draw a route by sampling the same GSAP RawPath the vehicles travel. */
export function drawRoute(route: OpsRoute): Graphics {
  const raw = MotionPathPlugin.arrayToRawPath(
    route.points.map((p) => ({ x: p.x, y: p.y })),
    { curviness: routeCurviness(route.kind) },
  );
  const steps = 90;
  const g = new Graphics();
  for (let i = 0; i <= steps; i += 1) {
    const pos = MotionPathPlugin.getPositionOnPath(raw, i / steps);
    if (i === 0) g.moveTo(pos.x, pos.y);
    else g.lineTo(pos.x, pos.y);
  }

  if (route.kind === "air") {
    g.stroke({ width: 3, color: 0x93b4e6, alpha: 0.55, cap: "round" });
  } else if (route.kind === "belt") {
    g.stroke({ width: 16, color: 0x9aa7bd, alpha: 0.7, cap: "round" });
  } else {
    g.stroke({ width: 12, color: 0xbcc8dc, alpha: 0.9, cap: "round" });
  }
  return g;
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

/** Isometric building block centered on its ground point (0,0). */
export function drawBuilding(accent: string, size: number, label: string): Container {
  const c = new Container();
  const hw = size;
  const hh = size / 2;
  const elev = size * 0.95;

  const top = shade(accent, 0.28);
  const left = hexToNum(accent);
  const right = shade(accent, -0.3);

  const shadow = new Graphics()
    .ellipse(0, hh * 0.6, hw * 1.15, hh * 1.1)
    .fill({ color: 0x0a1f44, alpha: 0.18 });
  c.addChild(shadow);

  const body = new Graphics();
  // left wall
  body.poly([-hw, 0, 0, hh, 0, hh - elev, -hw, -elev]).fill({ color: left });
  // right wall
  body.poly([hw, 0, 0, hh, 0, hh - elev, hw, -elev]).fill({ color: right });
  // top face
  body
    .poly([0, -hh - elev, hw, -elev, 0, hh - elev, -hw, -elev])
    .fill({ color: top });
  c.addChild(body);

  // roof accent ridge
  const ridge = new Graphics()
    .poly([0, -hh - elev, hw * 0.5, -elev - hh * 0.5, 0, -elev, -hw * 0.5, -elev - hh * 0.5])
    .fill({ color: shade(accent, 0.5), alpha: 0.55 });
  c.addChild(ridge);

  const text = new Text({
    text: label,
    style: {
      fill: 0x33415c,
      fontSize: 15,
      fontFamily: "Inter, system-ui, sans-serif",
      fontWeight: "600",
    },
  });
  text.anchor.set(0.5, 0);
  text.position.set(0, hh + 8);
  c.addChild(text);

  return c;
}

function wheels(g: Graphics, xs: number[], y: number, r: number): void {
  for (const x of xs) g.circle(x, y, r).fill({ color: 0x1a202c });
}

/** Vehicle sprite centered at (0,0), nose pointing +x. */
export function drawVehicle(kind: OpsVehicleKind, accent: string): Container {
  const c = new Container();
  const col = hexToNum(accent);
  const g = new Graphics();

  if (kind === "truck") {
    g.roundRect(-22, -9, 26, 18, 3).fill({ color: shade(accent, -0.15) }); // trailer
    g.roundRect(4, -10, 16, 20, 3).fill({ color: col }); // cab
    g.roundRect(16, -6, 5, 7, 1).fill({ color: 0xbfdbfe }); // windshield
    wheels(g, [-14, 12], 11, 4);
  } else if (kind === "plane") {
    g.poly([22, 0, -10, -7, -4, 0, -10, 7]).fill({ color: col }); // fuselage
    g.poly([2, -2, -14, -18, -6, -2]).fill({ color: shade(accent, 0.3) }); // wing up
    g.poly([2, 2, -14, 18, -6, 2]).fill({ color: shade(accent, 0.3) }); // wing down
    g.poly([-8, -1, -18, -8, -12, -1]).fill({ color: shade(accent, -0.2) }); // tail
  } else if (kind === "package") {
    g.roundRect(-8, -8, 16, 16, 2).fill({ color: col });
    g.rect(-8, -1.5, 16, 3).fill({ color: shade(accent, 0.4), alpha: 0.9 });
    g.rect(-1.5, -8, 3, 16).fill({ color: shade(accent, 0.4), alpha: 0.9 });
  } else {
    // forklift
    g.roundRect(-10, -8, 16, 16, 2).fill({ color: col });
    g.rect(6, -7, 10, 2).fill({ color: 0x1a202c });
    g.rect(6, 5, 10, 2).fill({ color: 0x1a202c });
    wheels(g, [-6, 4], 9, 3);
  }

  c.addChild(g);
  return c;
}
