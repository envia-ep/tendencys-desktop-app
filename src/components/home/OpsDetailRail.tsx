import { ArrowRight, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
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
    title = serviceName ?? t(`home.nodes.${selection.nodeId}.label`);
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
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: 28, y: 8 }}
          animate={{ opacity: 1, x: 0, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, x: 20 }}
          transition={{ duration: 0.28, ease: "easeOut" }}
          className="hud-glass pointer-events-auto absolute bottom-20 right-5 w-[300px] rounded-2xl px-5 py-4"
          aria-live="polite"
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-primary-glow)]">
                {hint}
              </p>
              <h2 className="mt-1 text-lg font-semibold text-white">{title}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/15 hover:text-white"
              aria-label={t("home.closeDetail")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="text-sm leading-relaxed text-white/80">{pitch}</p>
          {selection?.type === "building" && canOpen && serviceName && (
            <button
              type="button"
              onClick={onOpen}
              className="mt-4 flex w-full items-center justify-center rounded-lg bg-[var(--color-primary-glow)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-primary)]"
            >
              {t("home.open", { service: serviceName })}
              <ArrowRight className="ml-2 h-4 w-4" />
            </button>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
