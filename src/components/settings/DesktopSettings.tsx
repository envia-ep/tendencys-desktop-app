import { useEffect, useState } from "react";
import { Loader2, Printer, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SERVICES } from "@/config/services";
import { ServiceIcon } from "@/components/ServiceIcon";
import { Button } from "@/components/ui/button";
import { listPrinters, type PrinterInfo } from "@/lib/desktop-print";
import {
  DEFAULT_SERVICE_PREFERENCES,
  type LabelPrintMode,
} from "@/lib/preferences";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences-store";

const PRINT_MODES: LabelPrintMode[] = ["instant", "system", "save"];

export function DesktopSettings() {
  const { t } = useTranslation();
  const [selectedServiceId, setSelectedServiceId] = useState(SERVICES[0]?.id ?? "");
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printersLoading, setPrintersLoading] = useState(true);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const loaded = usePreferencesStore((s) => s.loaded);
  const loadPreferences = usePreferencesStore((s) => s.loadPreferences);
  const setLabelPrintMode = usePreferencesStore((s) => s.setLabelPrintMode);
  const setLabelPrinter = usePreferencesStore((s) => s.setLabelPrinter);
  const storedPrefs = usePreferencesStore(
    (s) => s.servicePrefs[selectedServiceId],
  );
  const prefs = storedPrefs ?? DEFAULT_SERVICE_PREFERENCES;

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  useEffect(() => {
    let cancelled = false;
    setPrintersLoading(true);
    setPrintersError(null);
    void listPrinters()
      .then((list) => {
        if (!cancelled) {
          setPrinters(list);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPrintersError(
            err instanceof Error ? err.message : t("settings.printersError"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPrintersLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const selectedService = SERVICES.find((s) => s.id === selectedServiceId);

  const handleTestPrint = async () => {
    setTestBusy(true);
    setTestMessage(null);
    try {
      const { printTestPage } = await import("@/lib/desktop-print");
      await printTestPage(selectedServiceId);
      setTestMessage(t("settings.testPrintSuccess"));
    } catch (err) {
      setTestMessage(
        err instanceof Error ? err.message : t("settings.testPrintError"),
      );
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="hero-aurora opacity-30" />
        <div className="hero-grid opacity-10" />
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-8 sm:px-10">
        <header className="mb-6 max-w-2xl shrink-0">
          <div className="mb-2 flex items-center gap-2 text-primary">
            <Settings2 className="h-5 w-5" aria-hidden />
            <span className="text-xs font-medium uppercase tracking-wide">
              {t("settings.badge")}
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t("settings.title")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("settings.subtitle")}
          </p>
        </header>

        <div className="flex min-h-0 flex-1 gap-6 overflow-hidden">
          <aside className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/60 pr-4">
            <p className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("settings.products")}
            </p>
            {SERVICES.map((service) => {
              const active = service.id === selectedServiceId;
              return (
                <button
                  key={service.id}
                  type="button"
                  onClick={() => {
                    setSelectedServiceId(service.id);
                    setTestMessage(null);
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-foreground/80 hover:bg-muted",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  <ServiceIcon icon={service.icon} className="h-4 w-4 shrink-0" />
                  <span className="truncate font-medium">{service.name}</span>
                </button>
              );
            })}
          </aside>

          <section className="min-w-0 flex-1 overflow-y-auto pb-8">
            {!loaded || !selectedService ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("settings.loading")}
              </div>
            ) : (
              <div className="max-w-xl space-y-8">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">
                    {selectedService.name}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("settings.productHint")}
                  </p>
                </div>

                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium text-foreground">
                    {t("settings.labelPrintMode")}
                  </legend>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.labelPrintModeHelp")}
                  </p>
                  <div className="space-y-2">
                    {PRINT_MODES.map((mode) => (
                      <label
                        key={mode}
                        className={cn(
                          "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                          prefs.labelPrintMode === mode
                            ? "border-primary/40 bg-primary/5"
                            : "border-border hover:bg-muted/50",
                        )}
                      >
                        <input
                          type="radio"
                          name={`print-mode-${selectedServiceId}`}
                          className="mt-1"
                          checked={prefs.labelPrintMode === mode}
                          onChange={() => {
                            void setLabelPrintMode(selectedServiceId, mode);
                            setTestMessage(null);
                          }}
                        />
                        <span>
                          <span className="block text-sm font-medium">
                            {t(`settings.modes.${mode}.label`)}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {t(`settings.modes.${mode}.description`)}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="space-y-3">
                  <label
                    htmlFor="label-printer"
                    className="text-sm font-medium text-foreground"
                  >
                    {t("settings.labelPrinter")}
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.labelPrinterHelp")}
                  </p>
                  {printersLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t("settings.loadingPrinters")}
                    </div>
                  ) : printersError ? (
                    <p className="text-sm text-destructive">{printersError}</p>
                  ) : (
                    <select
                      id="label-printer"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
                      disabled={prefs.labelPrintMode !== "instant"}
                      value={prefs.labelPrinter}
                      onChange={(e) => {
                        void setLabelPrinter(selectedServiceId, e.target.value);
                        setTestMessage(null);
                      }}
                    >
                      <option value="">{t("settings.systemDefaultPrinter")}</option>
                      {printers.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                          {p.isDefault ? ` (${t("settings.defaultBadge")})` : ""}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      testBusy ||
                      prefs.labelPrintMode === "save" ||
                      printersLoading
                    }
                    onClick={() => void handleTestPrint()}
                  >
                    {testBusy ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Printer className="mr-2 h-4 w-4" />
                    )}
                    {t("settings.testPrint")}
                  </Button>
                  {testMessage && (
                    <p className="text-sm text-muted-foreground">{testMessage}</p>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
