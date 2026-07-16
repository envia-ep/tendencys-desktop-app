import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getServiceById, type ServiceDefinition } from "@/config/services";
import { getBuilding } from "@/config/ops-world";
import { useOpsWorldStore } from "@/stores/ops-world-store";
import { OpsWorld } from "./world/OpsWorld";
import { OpsControls } from "./world/OpsControls";
import { HudChip } from "./world/HudChip";
import { HudStats } from "./world/HudStats";
import { OpsDetailRail } from "./OpsDetailRail";

type HomeHubProps = {
  onOpenService: (service: ServiceDefinition) => void;
};

export function HomeHub({ onOpenService }: HomeHubProps) {
  const { t } = useTranslation();
  const selection = useOpsWorldStore((s) => s.selection);
  const clearSelection = useOpsWorldStore((s) => s.clearSelection);

  const building =
    selection?.type === "building" ? getBuilding(selection.nodeId) : null;
  const selectedService = building?.serviceId
    ? getServiceById(building.serviceId) ?? null
    : null;

  const handleOpen = useCallback(() => {
    if (selectedService) onOpenService(selectedService);
  }, [onOpenService, selectedService]);

  return (
    <div className="world-stage relative h-full min-w-0 flex-1 overflow-hidden">
      {/* Animated brand backdrop behind the transparent Pixi canvas */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="hero-aurora opacity-60" />
        <div className="hero-grid opacity-20" />
      </div>

      {/* Full-bleed world */}
      <div className="absolute inset-0">
        <OpsWorld />
      </div>
      <div className="world-vignette" aria-hidden />

      {/* Floating HUD (transparent to pointer events except its own controls) */}
      <div className="pointer-events-none absolute inset-0 z-10">
        <HudChip />
        <HudStats />
        {!selection && (
          <p className="hud-fade-in absolute left-5 top-[74px] max-w-xs text-xs text-white/70">
            {t("home.exploreHint")}
          </p>
        )}
        <OpsControls />
        <OpsDetailRail
          selection={selection}
          serviceName={selectedService?.name ?? null}
          canOpen={Boolean(selectedService)}
          onOpen={handleOpen}
          onClose={clearSelection}
        />
      </div>
    </div>
  );
}
