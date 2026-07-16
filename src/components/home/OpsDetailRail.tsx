import { ArrowRight, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { OpsSelection } from "@/stores/ops-world-store";

type OpsDetailRailProps = {
  selection: OpsSelection;
  serviceName: string | null;
  canOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
};

export function OpsDetailRail({
  selection,
  serviceName,
  canOpen,
  onOpen,
  onClose,
}: OpsDetailRailProps) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const open = selection !== null;

  let hint = t("home.detailHint");
  let title = "";
  let pitch = "";
  let key = "";

  if (selection?.type === "building") {
    key = `b:${selection.nodeId}`;
    title =
      serviceName ??
      t(`home.nodes.${selection.nodeId}.label`);
    pitch = t(`home.nodes.${selection.nodeId}.pitch`);
  } else if (selection?.type === "vehicle") {
    key = `v:${selection.vehicleId}`;
    hint = t("home.vehicleHint");
    title = t(`home.vehicles.${selection.kind}.label`);
    pitch = t(`home.vehicles.${selection.kind}.pitch`);
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key={key}
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, x: 16 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="flex w-full shrink-0 flex-col justify-center border-t border-border bg-white/95 px-6 py-5 backdrop-blur-sm md:w-[280px] md:border-l md:border-t-0"
          aria-live="polite"
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {hint}
              </p>
              <h2 className="mt-1 text-lg font-semibold text-foreground">
                {title}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label={t("home.closeDetail")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{pitch}</p>
          {selection?.type === "building" && canOpen && serviceName && (
            <Button className="mt-5 w-full" onClick={onOpen}>
              {t("home.open", { service: serviceName })}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
