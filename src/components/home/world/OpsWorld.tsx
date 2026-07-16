import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Application, Container, Rectangle, type FederatedPointerEvent } from "pixi.js";
import gsap from "gsap";
import {
  OPS_BUILDINGS,
  OPS_ROUTES,
  OPS_VEHICLES,
  OPS_WORLD,
} from "@/config/ops-world";
import type { OpsNodeId } from "@/config/ops-scene";
import { createScriptedSource } from "@/lib/ops-sim/scripted-source";
import type { OpsSource } from "@/lib/ops-sim/types";
import { useOpsWorldStore } from "@/stores/ops-world-store";
import { drawBuilding, drawGround, drawRoute, drawVehicle } from "./draw";

const MIN_SCALE = 0.35;
const MAX_SCALE = 2.4;

export function OpsWorld() {
  const { t, i18n } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let app: Application | null = null;
    let source: OpsSource | null = null;
    const cleanups: Array<() => void> = [];

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
        // Safe here: app.init() has fully resolved (including ResizePlugin's
        // synchronous plugin-init pass), so `_cancelResize` is guaranteed to
        // exist. This is now the ONLY place that destroys the app — the
        // effect cleanup below just flips `disposed` and lets this branch
        // run once the pending init() settles, instead of racing it.
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
      world.addChild(ground, roads, buildingsLayer, vehiclesLayer);

      ground.addChild(drawGround());
      for (const route of OPS_ROUTES) roads.addChild(drawRoute(route));

      // Buildings
      const buildingSprites = new Map<OpsNodeId, Container>();
      for (const b of OPS_BUILDINGS) {
        const label =
          b.id === "company"
            ? t("home.nodes.company.label")
            : t(`home.nodes.${b.id}.label`);
        const sprite = drawBuilding(b.accent, b.size, label);
        sprite.position.set(b.x, b.y);
        sprite.eventMode = "static";
        sprite.cursor = "pointer";
        sprite.on("pointertap", (e: FederatedPointerEvent) => {
          e.stopPropagation();
          useOpsWorldStore.getState().select({ type: "building", nodeId: b.id });
          focusOn(b.x, b.y, 1.6);
        });
        sprite.on("pointerover", () => gsap.to(sprite.scale, { x: 1.06, y: 1.06, duration: 0.2 }));
        sprite.on("pointerout", () => gsap.to(sprite.scale, { x: 1, y: 1, duration: 0.2 }));
        buildingsLayer.addChild(sprite);
        buildingSprites.set(b.id, sprite);
      }

      // Vehicles
      source = createScriptedSource();
      source.start();
      const proxies = source.getEntities();
      const vehicleSprites = new Map<string, Container>();
      for (const proxy of proxies) {
        const cfg = OPS_VEHICLES.find((v) => v.id === proxy.id);
        const sprite = drawVehicle(proxy.kind, cfg?.accent ?? "#2B6CB0");
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

      // Camera fit + focus
      let userInteracted = false;
      function fit() {
        if (!app) return;
        const sw = app.screen.width;
        const sh = app.screen.height;
        const scale = Math.min(sw / OPS_WORLD.width, sh / OPS_WORLD.height) * 0.92;
        world.scale.set(scale);
        world.position.set(
          (sw - OPS_WORLD.width * scale) / 2,
          (sh - OPS_WORLD.height * scale) / 2,
        );
      }
      function focusOn(x: number, y: number, targetScale: number) {
        if (!app) return;
        userInteracted = true;
        const sw = app.screen.width;
        const sh = app.screen.height;
        const scale = Math.min(Math.max(targetScale, MIN_SCALE), MAX_SCALE);
        gsap.to(world.scale, { x: scale, y: scale, duration: 0.6, ease: "power2.out" });
        gsap.to(world.position, {
          x: sw / 2 - x * scale,
          y: sh / 2 - y * scale,
          duration: 0.6,
          ease: "power2.out",
        });
      }
      fit();

      // Frame loop: copy sim proxies into sprites
      const onTick = () => {
        for (const proxy of proxies) {
          const sprite = vehicleSprites.get(proxy.id);
          if (!sprite) continue;
          sprite.position.set(proxy.x, proxy.y);
          if (proxy.kind === "truck" || proxy.kind === "plane") {
            sprite.rotation = proxy.rotation;
          }
        }
      };
      app.ticker.add(onTick);

      // Selection highlight (dim non-selected buildings)
      function applySelectionHighlight(selectedId: OpsNodeId | null) {
        for (const [id, sprite] of buildingSprites) {
          sprite.alpha = selectedId && id !== selectedId ? 0.45 : 1;
        }
      }

      // React to store: paused / speed / selection
      const applyState = (state: ReturnType<typeof useOpsWorldStore.getState>) => {
        source?.setPaused(state.paused);
        source?.setTimeScale(state.speed);
        const sel = state.selection;
        applySelectionHighlight(sel?.type === "building" ? sel.nodeId : null);
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
      // Click on empty space clears selection
      app.stage.on("pointertap", () => {
        if (!moved) useOpsWorldStore.getState().clearSelection();
      });

      // Camera: wheel zoom around cursor
      const onWheel = (ev: WheelEvent) => {
        if (!app) return;
        ev.preventDefault();
        userInteracted = true;
        const rect = app.canvas.getBoundingClientRect();
        const px = ev.clientX - rect.left;
        const py = ev.clientY - rect.top;
        const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        const next = Math.min(Math.max(world.scale.x * factor, MIN_SCALE), MAX_SCALE);
        const applied = next / world.scale.x;
        world.position.x = px - (px - world.position.x) * applied;
        world.position.y = py - (py - world.position.y) * applied;
        world.scale.set(next);
      };
      app.canvas.addEventListener("wheel", onWheel, { passive: false });
      cleanups.push(() => app?.canvas.removeEventListener("wheel", onWheel));

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
    })();

    return () => {
      disposed = true;
      for (const fn of cleanups) fn();
      source?.stop();
      // Do NOT call app.destroy() here: app.init() may still be pending (the
      // renderer is created asynchronously), and ResizePlugin only wires up
      // `_cancelResize` after init() resolves. Destroying mid-init crashes
      // with "this._cancelResize is not a function". Setting `disposed` is
      // enough — the async setup above checks it once init() settles and
      // destroys the app itself, when it's guaranteed to be fully wired up.
    };
    // Rebuild on language change so building labels re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n.language]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full"
      role="img"
      aria-label={t("home.sceneLabel")}
    />
  );
}
