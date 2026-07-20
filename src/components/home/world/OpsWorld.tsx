import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Application,
  Container,
  Graphics,
  Rectangle,
  type FederatedPointerEvent,
} from "pixi.js";
import { AdvancedBloomFilter, GlowFilter } from "pixi-filters";
import gsap from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import {
  OPS_BUILDINGS,
  OPS_ROUTES,
  OPS_SCENE_REVISION,
  OPS_VEHICLES,
  OPS_WORLD,
  getBuilding,
} from "@/config/ops-world";
import type { OpsNodeId } from "@/config/ops-scene";
import { createScriptedSource } from "@/lib/ops-sim/scripted-source";
import type { OpsSource } from "@/lib/ops-sim/types";
import { useOpsWorldStore } from "@/stores/ops-world-store";
import {
  drawBuilding,
  drawGround,
  drawIconPad,
  drawPulseDot,
  drawRoute,
  drawSpotlight,
  drawVehicle,
  drawVehicleGlow,
  rawPathFor,
  routePulseColor,
} from "./draw";

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

type Pulse = {
  raw: ReturnType<typeof rawPathFor>;
  sprite: Graphics;
  p: number;
  speed: number;
};

export function OpsWorld() {
  const { t, i18n } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let app: Application | null = null;
    let source: OpsSource | null = null;
    const cleanups: Array<() => void> = [];
    const reduce = prefersReducedMotion();

    void (async () => {
      const host = hostRef.current;
      if (!host) return;

      app = new Application();
      await app.init({
        preference: "webgl",
        antialias: true,
        backgroundAlpha: 0,
        resizeTo: host,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      });
      if (disposed || !hostRef.current) {
        app.destroy(true, { children: true });
        return;
      }
      host.appendChild(app.canvas);
      app.canvas.style.width = "100%";
      app.canvas.style.height = "100%";

      const world = new Container();
      app.stage.addChild(world);

      const ground = new Container();
      const roads = new Container();
      const buildingsLayer = new Container();
      const vehiclesLayer = new Container();
      const emissive = new Container(); // bloomed glow layer (routes/auras/spotlight)
      world.addChild(ground, roads, buildingsLayer, vehiclesLayer, emissive);

      // Premium lighting: soft glow rim on buildings, bloom on the emissive layer.
      if (!reduce) {
        buildingsLayer.filters = [
          new GlowFilter({
            distance: 12,
            outerStrength: 1.1,
            innerStrength: 0,
            color: 0x0074ff,
            alpha: 0.55,
            quality: 0.25,
          }),
        ];
        emissive.filters = [
          new AdvancedBloomFilter({
            threshold: 0.2,
            bloomScale: 1.1,
            brightness: 1,
            blur: 6,
            quality: 4,
          }),
        ];
      }

      ground.addChild(drawGround());
      for (const route of OPS_ROUTES) roads.addChild(drawRoute(route));

      // Route flow pulses (emissive)
      const pulses: Pulse[] = [];
      for (const route of OPS_ROUTES) {
        const raw = rawPathFor(route);
        const color = routePulseColor(route.kind);
        const count = route.kind === "belt" ? 3 : 2;
        const speed = route.kind === "belt" ? 0.16 : 0.06;
        for (let i = 0; i < count; i += 1) {
          const sprite = drawPulseDot(color, route.kind === "air" ? 3 : 4);
          emissive.addChild(sprite);
          pulses.push({ raw, sprite, p: i / count, speed });
        }
      }

      // Company hub (isometric building) + service icon pads
      const buildingSprites = new Map<OpsNodeId, Container>();
      for (const b of OPS_BUILDINGS) {
        const label =
          b.id === "company"
            ? t("home.nodes.company.label")
            : t(`home.nodes.${b.id}.label`);
        const sprite =
          b.id === "company"
            ? drawBuilding(b.accent, b.size, label)
            : drawIconPad(b.metaphor, b.accent, b.size, label);
        sprite.position.set(b.x, b.y);
        sprite.eventMode = "static";
        sprite.cursor = "pointer";
        sprite.on("pointertap", (e: FederatedPointerEvent) => {
          e.stopPropagation();
          useOpsWorldStore.getState().select({ type: "building", nodeId: b.id });
          focusOn(b.x, b.y);
        });
        sprite.on("pointerover", () =>
          gsap.to(sprite.scale, { x: 1.06, y: 1.06, duration: 0.2 }),
        );
        sprite.on("pointerout", () =>
          gsap.to(sprite.scale, { x: 1, y: 1, duration: 0.2 }),
        );
        buildingsLayer.addChild(sprite);
        buildingSprites.set(b.id, sprite);
      }

      // Selection spotlight (emissive, recreated per selection)
      let spotlight: Graphics | null = null;

      // Vehicles + trailing auras
      source = createScriptedSource();
      source.start();
      const proxies = source.getEntities();
      const vehicleSprites = new Map<string, Container>();
      const vehicleGlows = new Map<string, Graphics>();
      for (const proxy of proxies) {
        const cfg = OPS_VEHICLES.find((v) => v.id === proxy.id);
        const accent = cfg?.accent ?? "#2B6CB0";
        const glow = drawVehicleGlow(proxy.kind, accent);
        glow.position.set(proxy.x, proxy.y);
        emissive.addChild(glow);
        vehicleGlows.set(proxy.id, glow);

        const sprite = drawVehicle(proxy.kind, accent);
        sprite.position.set(proxy.x, proxy.y);
        sprite.eventMode = "static";
        sprite.cursor = "pointer";
        sprite.on("pointertap", (e: FederatedPointerEvent) => {
          e.stopPropagation();
          useOpsWorldStore
            .getState()
            .select({ type: "vehicle", vehicleId: proxy.id, kind: proxy.kind });
        });
        vehiclesLayer.addChild(sprite);
        vehicleSprites.set(proxy.id, sprite);
      }

      // Camera fit + focus + intro + idle drift
      let userInteracted = false;
      let idleTl: gsap.core.Timeline | null = null;
      function fitScale(): number {
        if (!app) return 1;
        return (
          Math.min(
            app.screen.width / OPS_WORLD.width,
            app.screen.height / OPS_WORLD.height,
          ) * 0.92
        );
      }
      function fit() {
        if (!app) return;
        const scale = fitScale();
        world.scale.set(scale);
        world.position.set(
          (app.screen.width - OPS_WORLD.width * scale) / 2,
          (app.screen.height - OPS_WORLD.height * scale) / 2,
        );
      }
      function focusOn(x: number, y: number) {
        if (!app) return;
        userInteracted = true;
        const scale = world.scale.x;
        gsap.to(world.position, {
          x: app.screen.width / 2 - x * scale,
          y: app.screen.height / 2 - y * scale,
          duration: 0.6,
          ease: "power2.out",
        });
      }
      fit();

      if (!reduce) {
        // Cinematic intro: fade + ease from slightly wide to framed.
        const target = fitScale();
        world.alpha = 0;
        world.scale.set(target * 0.82);
        gsap.to(world, { alpha: 1, duration: 0.8, ease: "power1.out" });
        gsap.to(world.scale, {
          x: target,
          y: target,
          duration: 1,
          ease: "power2.out",
          onComplete: () => {
            if (userInteracted) return;
            // Very slow ambient sway via pivot (independent of pan).
            idleTl = gsap.timeline({ repeat: -1, yoyo: true });
            idleTl.to(world.pivot, {
              x: 16,
              y: 10,
              duration: 9,
              ease: "sine.inOut",
            });
          },
        });
      }

      // Frame loop: sim proxies -> sprites, plus pulses
      const onTick = () => {
        if (!app) return;
        const st = useOpsWorldStore.getState();
        const dt = app.ticker.deltaMS / 1000;
        for (const proxy of proxies) {
          const sprite = vehicleSprites.get(proxy.id);
          if (sprite) {
            sprite.position.set(proxy.x, proxy.y);
            if (proxy.kind === "truck" || proxy.kind === "plane") {
              sprite.rotation = proxy.rotation;
            }
          }
          const glow = vehicleGlows.get(proxy.id);
          if (glow) glow.position.set(proxy.x, proxy.y);
        }
        if (!st.paused) {
          for (const pulse of pulses) {
            pulse.p = (pulse.p + pulse.speed * dt * st.speed) % 1;
            const pos = MotionPathPlugin.getPositionOnPath(pulse.raw, pulse.p);
            pulse.sprite.position.set(pos.x, pos.y);
          }
        }
      };
      app.ticker.add(onTick);

      // Selection: dim non-selected buildings + show spotlight
      function applySelection(sel: ReturnType<typeof useOpsWorldStore.getState>["selection"]) {
        const selectedId = sel?.type === "building" ? sel.nodeId : null;
        for (const [id, sprite] of buildingSprites) {
          gsap.to(sprite, {
            alpha: selectedId && id !== selectedId ? 0.4 : 1,
            duration: 0.3,
          });
        }
        if (spotlight) {
          spotlight.destroy();
          spotlight = null;
        }
        if (selectedId) {
          const b = getBuilding(selectedId);
          spotlight = drawSpotlight(b.accent, b.size);
          spotlight.position.set(b.x, b.y);
          emissive.addChildAt(spotlight, 0);
          if (!reduce) {
            gsap.fromTo(
              spotlight.scale,
              { x: 0.6, y: 0.6 },
              { x: 1, y: 1, duration: 0.5, ease: "back.out(2)" },
            );
          }
        }
      }

      // React to store: paused / speed / selection
      const applyState = (state: ReturnType<typeof useOpsWorldStore.getState>) => {
        source?.setPaused(state.paused);
        source?.setTimeScale(state.speed);
        applySelection(state.selection);
      };
      applyState(useOpsWorldStore.getState());
      cleanups.push(useOpsWorldStore.subscribe(applyState));

      // Camera: drag to pan
      app.stage.eventMode = "static";
      app.stage.hitArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
      let dragging = false;
      let moved = false;
      let last = { x: 0, y: 0 };
      app.stage.on("pointerdown", (e: FederatedPointerEvent) => {
        dragging = true;
        moved = false;
        last = { x: e.global.x, y: e.global.y };
      });
      app.stage.on("pointermove", (e: FederatedPointerEvent) => {
        if (!dragging) return;
        const dx = e.global.x - last.x;
        const dy = e.global.y - last.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        world.position.x += dx;
        world.position.y += dy;
        last = { x: e.global.x, y: e.global.y };
        if (moved) userInteracted = true;
      });
      const endDrag = () => {
        dragging = false;
      };
      app.stage.on("pointerup", endDrag);
      app.stage.on("pointerupoutside", endDrag);
      app.stage.on("pointertap", () => {
        if (!moved) useOpsWorldStore.getState().clearSelection();
      });

      // Keep hit area in sync on resize; re-fit until the user takes control
      const onResize = () => {
        if (!app) return;
        app.stage.hitArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
        if (!userInteracted) fit();
      };
      window.addEventListener("resize", onResize);
      cleanups.push(() => window.removeEventListener("resize", onResize));

      // Escape clears selection
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") useOpsWorldStore.getState().clearSelection();
      };
      window.addEventListener("keydown", onKey);
      cleanups.push(() => window.removeEventListener("keydown", onKey));

      cleanups.push(() => idleTl?.kill());
    })();

    return () => {
      disposed = true;
      for (const fn of cleanups) fn();
      source?.stop();
    };
    // Rebuild when language or scene revision changes (HMR / world geometry).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n.language, OPS_SCENE_REVISION]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full"
      role="img"
      aria-label={t("home.sceneLabel")}
    />
  );
}
