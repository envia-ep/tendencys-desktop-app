/**
 * Data abstraction for the logistics world. The scripted source drives sprites
 * with GSAP now; a future `LiveOpsSource` implements the same interface and
 * tweens sprites toward coordinates pushed over a socket/API. The world never
 * knows which one is active.
 */

import type { OpsVehicleKind } from "@/config/ops-world";

export type OpsSourceMode = "sim" | "live" | "replay";

/**
 * Mutable proxy the source updates in place each frame; the world reads it to
 * position sprites. Keeping it a plain object (not a Pixi node) is what lets the
 * sim stay renderer-agnostic and unit-testable.
 */
export type OpsEntityProxy = {
  id: string;
  kind: OpsVehicleKind;
  routeId: string;
  x: number;
  y: number;
  /** Travel direction in radians (already converted from GSAP degrees). */
  rotation: number;
};

export interface OpsSource {
  readonly mode: OpsSourceMode;
  /** Build/start the timelines. */
  start(): void;
  /** Kill all timelines and release GSAP resources. */
  stop(): void;
  setTimeScale(scale: number): void;
  setPaused(paused: boolean): void;
  /** Live entity proxies, mutated in place; read every frame. */
  getEntities(): OpsEntityProxy[];
}
