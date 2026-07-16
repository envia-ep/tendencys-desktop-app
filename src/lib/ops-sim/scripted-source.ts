import gsap from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { OPS_VEHICLES, getRoute, type OpsRouteKind } from "@/config/ops-world";
import type { OpsEntityProxy, OpsSource } from "./types";

gsap.registerPlugin(MotionPathPlugin);

const DEG2RAD = Math.PI / 180;

/** Single source of truth for path curvature — used by the sim and road drawing. */
export function routeCurviness(kind: OpsRouteKind): number {
  return kind === "belt" ? 0 : 1.25;
}

/**
 * Scripted logistics simulation: one looping MotionPath tween per vehicle,
 * parented to a master timeline so speed (`timeScale`) and pause propagate to
 * every vehicle at once.
 */
export function createScriptedSource(): OpsSource {
  const master = gsap.timeline({ paused: true });
  const proxies: OpsEntityProxy[] = [];
  let started = false;

  function build(): void {
    for (const v of OPS_VEHICLES) {
      const route = getRoute(v.routeId);
      const first = route.points[0];
      const proxy: OpsEntityProxy = {
        id: v.id,
        kind: v.kind,
        routeId: v.routeId,
        x: first.x,
        y: first.y,
        rotation: 0,
      };
      proxies.push(proxy);

      // Tween a raw object so GSAP's degree-based autoRotate stays isolated;
      // mirror into the proxy each frame converting rotation to radians.
      const raw = { x: first.x, y: first.y, rotation: 0 };
      const autoRotate = v.kind === "truck" || v.kind === "plane";

      const tween = gsap.to(raw, {
        duration: v.duration,
        repeat: -1,
        ease: "none",
        motionPath: {
          path: route.points,
          autoRotate,
          curviness: routeCurviness(route.kind),
        },
        onUpdate: () => {
          proxy.x = raw.x;
          proxy.y = raw.y;
          proxy.rotation = raw.rotation * DEG2RAD;
        },
      });
      // Offset each vehicle's start progress so they spread along the route.
      tween.progress(v.offset ?? 0);
      master.add(tween, 0);
    }
  }

  return {
    mode: "sim",
    start() {
      if (!started) {
        build();
        started = true;
      }
      master.play();
    },
    stop() {
      master.kill();
      proxies.length = 0;
    },
    setTimeScale(scale) {
      master.timeScale(scale);
    },
    setPaused(paused) {
      if (paused) master.pause();
      else master.play();
    },
    getEntities() {
      return proxies;
    },
  };
}
