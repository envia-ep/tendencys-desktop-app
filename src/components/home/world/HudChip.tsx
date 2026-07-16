import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";

/** Compact floating greeting over the world — replaces the old header block. */
export function HudChip() {
  const { t } = useTranslation();
  const account = useAuthStore((s) => s.getAccount());

  const firstName = account?.firstName?.trim() ?? "";
  const initial = (firstName || account?.email || "?").charAt(0).toUpperCase();
  const greeting = firstName
    ? t("home.greeting", { name: firstName })
    : t("home.greetingFallback");

  return (
    <div className="hud-glass hud-fade-in pointer-events-auto absolute left-5 top-5 flex items-center gap-3 rounded-2xl px-3.5 py-2.5">
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
        style={{
          background:
            "linear-gradient(135deg, var(--color-primary-glow), var(--color-primary))",
        }}
      >
        {initial}
      </div>
      <div className="pr-1">
        <p className="text-sm font-semibold leading-tight text-white">
          {greeting}
        </p>
        <p className="text-[11px] leading-tight text-white/70">
          {t("home.chipTagline")}
        </p>
      </div>
    </div>
  );
}
