import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";

/** Surfaces a failed post-login device-key register (silent remint will not work). */
export function DeviceKeyWarningBanner() {
  const { t } = useTranslation();
  const warning = useAuthStore((s) => s.deviceKeyWarning);
  const clearDeviceKeyWarning = useAuthStore((s) => s.clearDeviceKeyWarning);

  if (!warning) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-4 border-b border-amber-500/40 bg-amber-950 px-4 py-3 text-sm text-amber-50">
      <div className="flex min-w-0 items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">{t("deviceKeyWarning.title")}</p>
          <p className="mt-0.5 text-amber-50/85">{warning}</p>
        </div>
      </div>
      <Button
        className="shrink-0 bg-amber-50 text-amber-950 hover:bg-amber-100"
        onClick={() => clearDeviceKeyWarning()}
        size="sm"
        type="button"
      >
        {t("deviceKeyWarning.dismiss")}
      </Button>
    </div>
  );
}
