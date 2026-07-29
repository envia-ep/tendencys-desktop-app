import { useTranslation } from "react-i18next";
import { usePreferencesStore } from "@/stores/preferences-store";

/**
 * Persistent indicator shown whenever the shell is pointed at the Dev/sandbox
 * backend. Mounted at the App root (not inside AppShell) so it's visible on
 * LoginPage too — the Dev/Prod choice determines which Accounts host the
 * login screen points at, so a developer must never lose sight of it.
 */
export function DevModeBanner() {
  const { t } = useTranslation();
  const environmentMode = usePreferencesStore((s) => s.environmentMode);

  if (environmentMode !== "dev") return null;

  return (
    <div className="flex items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-amber-950">
      {t("devModeBanner.label")}
    </div>
  );
}
