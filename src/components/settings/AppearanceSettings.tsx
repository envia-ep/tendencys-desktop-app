import { useTranslation } from "react-i18next";
import {
  SHELL_ZOOM_OPTIONS,
  type ShellZoom,
  type ThemeMode,
  type UiDensity,
} from "@/lib/preferences";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences-store";

const THEME_MODES: ThemeMode[] = ["light", "dark", "system"];
const DENSITIES: UiDensity[] = ["comfortable", "compact"];

export function AppearanceSettings() {
  const { t } = useTranslation();
  const loaded = usePreferencesStore((s) => s.loaded);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const uiDensity = usePreferencesStore((s) => s.uiDensity);
  const shellZoom = usePreferencesStore((s) => s.shellZoom);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);
  const setUiDensity = usePreferencesStore((s) => s.setUiDensity);
  const setShellZoom = usePreferencesStore((s) => s.setShellZoom);

  return (
    <section className="space-y-4 border-t border-border/60 pt-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {t("settings.appearance.title")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.appearance.help")}
        </p>
      </div>

      <div className="space-y-1.5">
        <p
          className="text-sm font-medium text-foreground"
          title={t("settings.appearance.themeHelp")}
        >
          {t("settings.appearance.theme")}
        </p>
        <div
          role="radiogroup"
          aria-label={t("settings.appearance.theme")}
          className="inline-flex h-9 flex-wrap items-center rounded-md border border-input p-0.5"
        >
          {THEME_MODES.map((mode) => {
            const active = themeMode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!loaded}
                className={cn(
                  "h-full rounded-[5px] px-3 text-sm font-medium transition-colors disabled:opacity-50",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground/70 hover:bg-muted",
                )}
                onClick={() => {
                  void setThemeMode(mode);
                }}
              >
                {t(`settings.appearance.themeModes.${mode}`)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <p
          className="text-sm font-medium text-foreground"
          title={t("settings.appearance.densityHelp")}
        >
          {t("settings.appearance.density")}
        </p>
        <div
          role="radiogroup"
          aria-label={t("settings.appearance.density")}
          className="inline-flex h-9 items-center rounded-md border border-input p-0.5"
        >
          {DENSITIES.map((density) => {
            const active = uiDensity === density;
            return (
              <button
                key={density}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!loaded}
                className={cn(
                  "h-full rounded-[5px] px-3 text-sm font-medium transition-colors disabled:opacity-50",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground/70 hover:bg-muted",
                )}
                onClick={() => {
                  void setUiDensity(density);
                }}
              >
                {t(`settings.appearance.densities.${density}`)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="max-w-xs space-y-1.5">
        <label
          htmlFor="shell-zoom"
          className="text-sm font-medium text-foreground"
          title={t("settings.appearance.zoomHelp")}
        >
          {t("settings.appearance.zoom")}
        </label>
        <select
          id="shell-zoom"
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={shellZoom}
          disabled={!loaded}
          title={t("settings.appearance.zoomHelp")}
          onChange={(e) => {
            void setShellZoom(Number(e.target.value) as ShellZoom);
          }}
        >
          {SHELL_ZOOM_OPTIONS.map((zoom) => (
            <option key={zoom} value={zoom}>
              {t("settings.appearance.zoomPercent", { percent: zoom })}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
