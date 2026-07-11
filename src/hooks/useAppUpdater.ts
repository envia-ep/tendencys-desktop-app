import { useCallback, useEffect, useState } from "react";
import {
  restartToApplyUpdate,
  silentUpdateOnLaunch,
  type InstalledUpdate,
} from "@/lib/updater";
import { isTauri } from "@/lib/tauri";

export function useAppUpdater() {
  const [installed, setInstalled] = useState<InstalledUpdate | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;

    void silentUpdateOnLaunch().then((result) => {
      if (!cancelled && result) {
        setInstalled(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const restart = useCallback(async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      await restartToApplyUpdate();
    } catch (err) {
      console.warn("[updater] restart failed", err);
      setRestarting(false);
    }
  }, [restarting]);

  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  return {
    installed: installed && !dismissed ? installed : null,
    restarting,
    restart,
    dismiss,
  };
}
