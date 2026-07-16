import { Pause, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  useOpsWorldStore,
  type OpsSpeed,
} from "@/stores/ops-world-store";
import type { OpsSourceMode } from "@/lib/ops-sim/types";

const SPEEDS: OpsSpeed[] = [1, 2, 5];
const MODES: OpsSourceMode[] = ["sim", "live", "replay"];

export function OpsControls() {
  const { t } = useTranslation();
  const paused = useOpsWorldStore((s) => s.paused);
  const speed = useOpsWorldStore((s) => s.speed);
  const mode = useOpsWorldStore((s) => s.mode);
  const togglePaused = useOpsWorldStore((s) => s.togglePaused);
  const setSpeed = useOpsWorldStore((s) => s.setSpeed);

  return (
    <div className="hud-glass hud-fade-in pointer-events-auto absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-2 py-1.5">
      <button
        type="button"
        onClick={togglePaused}
        aria-label={paused ? t("home.controls.play") : t("home.controls.pause")}
        className="flex h-8 w-8 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
      >
        {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
      </button>

      <div
        className="flex items-center gap-0.5"
        role="group"
        aria-label={t("home.controls.speed")}
      >
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSpeed(s)}
            aria-pressed={speed === s}
            className={cn(
              "h-7 rounded-full px-2 text-xs font-medium tabular-nums transition-colors",
              speed === s
                ? "bg-[var(--color-primary-glow)] text-white shadow"
                : "text-white/70 hover:bg-white/15",
            )}
          >
            {s}x
          </button>
        ))}
      </div>

      <div className="mx-1 h-5 w-px bg-white/20" aria-hidden />

      <div
        className="flex items-center gap-0.5"
        role="group"
        aria-label={t("home.controls.mode")}
      >
        {MODES.map((m) => {
          const active = mode === m;
          const disabled = m !== "sim";
          return (
            <button
              key={m}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              title={disabled ? t("home.controls.comingSoon") : undefined}
              className={cn(
                "h-7 rounded-full px-2.5 text-xs font-medium capitalize transition-colors",
                active ? "bg-white text-[var(--color-primary-deep)]" : "text-white/70",
                disabled && "cursor-not-allowed opacity-40",
              )}
            >
              {t(`home.controls.modes.${m}`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
