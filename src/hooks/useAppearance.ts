import { useEffect } from "react";
import { applyAppearance } from "@/lib/appearance";
import { usePreferencesStore } from "@/stores/preferences-store";

/** Keeps document theme / density / zoom in sync with persisted preferences. */
export function useAppearance(): void {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const uiDensity = usePreferencesStore((s) => s.uiDensity);
  const shellZoom = usePreferencesStore((s) => s.shellZoom);

  useEffect(() => {
    return applyAppearance({ themeMode, uiDensity, shellZoom });
  }, [themeMode, uiDensity, shellZoom]);
}
