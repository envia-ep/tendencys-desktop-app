import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { dismissDockTip, shouldShowDockTip } from "@/lib/dock-tip";

export function DockTipBanner() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(() => shouldShowDockTip());

  if (!visible) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/10 bg-slate-900 px-4 py-3 text-sm text-white">
      <div className="min-w-0">
        <p className="font-medium">{t("dockTip.title")}</p>
        <p className="mt-0.5 text-white/80">{t("dockTip.description")}</p>
      </div>
      <Button
        className="shrink-0 bg-white text-slate-900 hover:bg-white/90"
        onClick={() => {
          dismissDockTip();
          setVisible(false);
        }}
        size="sm"
        type="button"
      >
        {t("dockTip.gotIt")}
      </Button>
    </div>
  );
}
