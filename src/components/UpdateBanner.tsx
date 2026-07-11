import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useAppUpdater } from "@/hooks/useAppUpdater";

export function UpdateBanner() {
  const { t } = useTranslation();
  const { installed, restarting, restart, dismiss } = useAppUpdater();

  if (!installed) return null;

  return (
    <div className="flex items-center justify-between gap-4 bg-primary px-4 py-3 text-sm text-white shadow-sm">
      <p className="font-medium">
        {t("updater.installed", { version: installed.version })}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          className="bg-white text-primary hover:bg-white/90"
          disabled={restarting}
          onClick={restart}
          size="sm"
          type="button"
        >
          {restarting ? t("updater.restarting") : t("updater.restart")}
        </Button>
        <Button
          className="text-white hover:bg-white/10 hover:text-white"
          disabled={restarting}
          onClick={dismiss}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("updater.dismiss")}
        </Button>
      </div>
    </div>
  );
}
