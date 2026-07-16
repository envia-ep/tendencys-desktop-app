import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getServiceById, type ServiceDefinition } from "@/config/services";
import { getBuilding } from "@/config/ops-world";
import { useAuthStore } from "@/stores/auth-store";
import { useOpsWorldStore } from "@/stores/ops-world-store";
import { OpsWorld } from "./world/OpsWorld";
import { OpsControls } from "./world/OpsControls";
import { OpsDetailRail } from "./OpsDetailRail";

type HomeHubProps = {
  onOpenService: (service: ServiceDefinition) => void;
};

export function HomeHub({ onOpenService }: HomeHubProps) {
  const { t } = useTranslation();
  const account = useAuthStore((s) => s.getAccount());
  const selection = useOpsWorldStore((s) => s.selection);
  const clearSelection = useOpsWorldStore((s) => s.clearSelection);

  const firstName = account?.firstName?.trim() ?? "";
  const greeting = firstName
    ? t("home.greeting", { name: firstName })
    : t("home.greetingFallback");

  const building =
    selection?.type === "building" ? getBuilding(selection.nodeId) : null;
  const selectedService = building?.serviceId
    ? getServiceById(building.serviceId) ?? null
    : null;

  const handleOpen = useCallback(() => {
    if (selectedService) onOpenService(selectedService);
  }, [onOpenService, selectedService]);

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="hero-surface absolute inset-0 opacity-[0.08]" aria-hidden />
      <div className="pointer-events-none absolute inset-0 opacity-40" aria-hidden>
        <div className="hero-aurora opacity-50" />
        <div className="hero-grid opacity-30" />
      </div>

      <header className="relative z-10 shrink-0 px-8 pb-2 pt-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {greeting}
        </h1>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          {t("home.tagline")}
        </p>
        {!selection && (
          <p className="mt-3 text-xs text-muted-foreground/80">
            {t("home.exploreHint")}
          </p>
        )}
      </header>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-h-0 min-w-0 flex-1 px-2 pb-2 md:px-4">
          <OpsControls />
          <OpsWorld />
        </div>
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
