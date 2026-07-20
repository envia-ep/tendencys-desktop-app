import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Package, Plane, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { numberLocaleFor } from "@/lib/locale";

type Metric = {
  key: string;
  icon: LucideIcon;
  base: number;
  step: number;
  prefix?: string;
  suffix?: string;
};

// Scripted/mock figures — no data layer. They drift upward to feel live.
const METRICS: Metric[] = [
  { key: "inTransit", icon: Plane, base: 1284, step: 3 },
  { key: "packed", icon: Package, base: 3157, step: 7 },
  { key: "settled", icon: Wallet, base: 92, step: 1, prefix: "$", suffix: "k" },
];

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Lightweight floating KPI ticker (scripted) — the "command center" pulse. */
export function HudStats() {
  const { t, i18n } = useTranslation();
  const locale = numberLocaleFor(i18n.language);
  const [values, setValues] = useState<number[]>(METRICS.map((m) => m.base));

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const id = window.setInterval(() => {
      setValues((prev) =>
        prev.map((v, i) => v + Math.round(Math.random() * METRICS[i].step)),
      );
    }, 2600);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="hud-glass hud-fade-in pointer-events-auto absolute right-5 top-5 flex items-center gap-1 rounded-2xl px-2 py-1.5">
      {METRICS.map((m, i) => {
        const Icon = m.icon;
        return (
          <div
            key={m.key}
            className="flex items-center gap-2 rounded-xl px-2.5 py-1.5"
          >
            <Icon className="h-4 w-4 text-[var(--color-primary-glow)]" />
            <div className="leading-tight">
              <p className="text-sm font-semibold tabular-nums text-white">
                {m.prefix ?? ""}
                {values[i].toLocaleString(locale)}
                {m.suffix ?? ""}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-white/60">
                {t(`home.stats.${m.key}`)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
