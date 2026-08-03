import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  Bug,
  ExternalLink,
  ListOrdered,
  Loader2,
  MessageSquareWarning,
  Plus,
  Printer,
  Settings2,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { CATALOG_PRINT_SIZES } from "@/config/catalog-print-sizes";
import type { AppEnvironmentMode } from "@/config/environment";
import { SERVICES, type ServiceDefinition } from "@/config/services";
import { ServiceIcon } from "@/components/ServiceIcon";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";
import { MenuLayoutSettings } from "@/components/settings/MenuLayoutSettings";
import { Button } from "@/components/ui/button";
import { listPrinters, type PrinterInfo } from "@/lib/desktop-print";
import { assignSizeToPrinter } from "@/lib/label-print-size";
import {
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "@/lib/locale";
import {
  DEFAULT_SERVICE_PREFERENCES,
  type LabelPrintMode,
} from "@/lib/preferences";
import {
  clearAccountsSession,
  clearSharedWebData,
  logoutWebviews,
  openActiveServiceDevtools,
} from "@/lib/native-webviews";
import { openUserFeedback } from "@/lib/sentry";
import { getTendencysBaseUrl } from "@/lib/tendencys-auth";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences-store";

const PRINT_MODES: LabelPrintMode[] = ["instant", "system", "save"];
const ENVIRONMENT_MODES: AppEnvironmentMode[] = ["production", "dev"];
const GENERAL_SELECTION = "general" as const;
const MENU_SELECTION = "menu" as const;
/** Instant print prefs only apply to Shipping and WMS. */
const PRINT_SETTINGS_SERVICE_IDS = new Set(["envia-shipping", "envia-wms"]);
const PRINT_SETTINGS_SERVICES = SERVICES.filter((service) =>
  PRINT_SETTINGS_SERVICE_IDS.has(service.id),
);

type SettingsSelection =
  | typeof GENERAL_SELECTION
  | typeof MENU_SELECTION
  | string;

const SHIPPING_CARRIERS_PATH = "/settings/carriers";

function isProductSelection(selection: SettingsSelection): boolean {
  return selection !== GENERAL_SELECTION && selection !== MENU_SELECTION;
}

type DesktopSettingsProps = {
  onOpenServicePath?: (service: ServiceDefinition, path: string) => void;
};

export function DesktopSettings({ onOpenServicePath }: DesktopSettingsProps) {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [selection, setSelection] =
    useState<SettingsSelection>(GENERAL_SELECTION);
  const selectedServiceId = isProductSelection(selection)
    ? selection
    : (PRINT_SETTINGS_SERVICES[0]?.id ?? "");
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [addPrinterName, setAddPrinterName] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [pendingEnvironmentMode, setPendingEnvironmentMode] =
    useState<AppEnvironmentMode | null>(null);
  const [switchingEnvironment, setSwitchingEnvironment] = useState(false);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [devToolsError, setDevToolsError] = useState<string | null>(null);

  const loaded = usePreferencesStore((s) => s.loaded);
  const language = usePreferencesStore((s) => s.language);
  const environmentMode = usePreferencesStore((s) => s.environmentMode);
  const loadPreferences = usePreferencesStore((s) => s.loadPreferences);
  const setLanguage = usePreferencesStore((s) => s.setLanguage);
  const setEnvironmentMode = usePreferencesStore((s) => s.setEnvironmentMode);
  const setLabelPrintMode = usePreferencesStore((s) => s.setLabelPrintMode);
  const setLabelPrinterDefault = usePreferencesStore(
    (s) => s.setLabelPrinterDefault,
  );
  const setLabelPrinterRules = usePreferencesStore(
    (s) => s.setLabelPrinterRules,
  );
  const storedPrefs = usePreferencesStore(
    (s) => s.servicePrefs[selectedServiceId],
  );
  const prefs = storedPrefs ?? DEFAULT_SERVICE_PREFERENCES;
  const configuredPrinterNames = useMemo(
    () => new Set(prefs.labelPrinterRules.map((rule) => rule.printer)),
    [prefs.labelPrinterRules],
  );
  const availableToAdd = useMemo(
    () => printers.filter((p) => !configuredPrinterNames.has(p.name)),
    [printers, configuredPrinterNames],
  );

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((version) => {
        if (!cancelled) {
          setAppVersion(version);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAppVersion(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Printer listing shells out to PowerShell on Windows — only load when a
    // print-settings product tab needs the dropdown.
    if (
      !isProductSelection(selection) ||
      !PRINT_SETTINGS_SERVICE_IDS.has(selection)
    ) {
      return;
    }
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
  }, [selection, t]);

  const selectedService = PRINT_SETTINGS_SERVICES.find(
    (s) => s.id === selectedServiceId,
  );

  const handleTestPrint = async (printer?: string) => {
    setTestBusy(true);
    setTestMessage(null);
    try {
      const { printTestPage } = await import("@/lib/desktop-print");
      await printTestPage(selectedServiceId, printer);
      setTestMessage(t("settings.testPrintSuccess"));
    } catch (err) {
      setTestMessage(
        err instanceof Error ? err.message : t("settings.testPrintError"),
      );
    } finally {
      setTestBusy(false);
    }
  };

  const handleAddPrinter = () => {
    const name = addPrinterName.trim();
    if (!name || configuredPrinterNames.has(name)) {
      return;
    }
    void setLabelPrinterRules(selectedServiceId, [
      ...prefs.labelPrinterRules,
      { printer: name, sizeIds: [] },
    ]);
    setAddPrinterName("");
    setTestMessage(null);
  };

  const handleRemovePrinter = (printer: string) => {
    void setLabelPrinterRules(
      selectedServiceId,
      prefs.labelPrinterRules.filter((rule) => rule.printer !== printer),
    );
    setTestMessage(null);
  };

  const handleToggleSize = (
    printer: string,
    sizeId: string,
    checked: boolean,
  ) => {
    void setLabelPrinterRules(
      selectedServiceId,
      assignSizeToPrinter(prefs.labelPrinterRules, printer, sizeId, checked),
    );
    setTestMessage(null);
  };

  const handleConfigurePrinting = () => {
    const shipping = SERVICES.find((s) => s.id === "envia-shipping");
    if (!shipping || !onOpenServicePath) {
      return;
    }
    onOpenServicePath(shipping, SHIPPING_CARRIERS_PATH);
  };

  const handleConfirmEnvironmentSwitch = async () => {
    if (!pendingEnvironmentMode) return;
    setSwitchingEnvironment(true);
    setEnvironmentError(null);
    try {
      // Capture the still-active Accounts host before switching so its jar
      // entry gets cleared too, not just whichever host we're about to point at.
      const previousAccountsBase = getTendencysBaseUrl();
      await setEnvironmentMode(pendingEnvironmentMode);
      await clearAccountsSession(previousAccountsBase).catch(() => undefined);
      await clearSharedWebData().catch(() => undefined);
      await logoutWebviews().catch(() => undefined);
      if (isTauri()) {
        await relaunch();
        return;
      }
      setSwitchingEnvironment(false);
      setPendingEnvironmentMode(null);
    } catch (err) {
      setSwitchingEnvironment(false);
      setEnvironmentError(
        err instanceof Error ? err.message : t("settings.environment.error"),
      );
    }
  };

  const handleOpenDevTools = async () => {
    setDevToolsError(null);
    try {
      await openActiveServiceDevtools();
    } catch (err) {
      setDevToolsError(
        err instanceof Error
          ? err.message
          : t("settings.environment.devToolsError"),
      );
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
          {appVersion && (
            <p className="mt-2 text-xs text-muted-foreground tabular-nums">
              {t("settings.version", { version: appVersion })}
            </p>
          )}
        </header>

        <div className="flex min-h-0 flex-1 gap-6 overflow-hidden">
          <aside className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/60 pr-4">
            <button
              type="button"
              onClick={() => setSelection(GENERAL_SELECTION)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors",
                selection === GENERAL_SELECTION
                  ? "bg-primary/10 text-primary"
                  : "text-foreground/80 hover:bg-muted",
              )}
              aria-current={
                selection === GENERAL_SELECTION ? "page" : undefined
              }
            >
              <SlidersHorizontal className="h-4 w-4 shrink-0" />
              <span className="truncate font-medium">
                {t("settings.general")}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setSelection(MENU_SELECTION)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors",
                selection === MENU_SELECTION
                  ? "bg-primary/10 text-primary"
                  : "text-foreground/80 hover:bg-muted",
              )}
              aria-current={selection === MENU_SELECTION ? "page" : undefined}
            >
              <ListOrdered className="h-4 w-4 shrink-0" />
              <span className="truncate font-medium">
                {t("settings.menu.title")}
              </span>
            </button>

            <p className="mb-1 mt-3 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("settings.products")}
            </p>
            {PRINT_SETTINGS_SERVICES.map((service) => {
              const active = selection === service.id;
              return (
                <button
                  key={service.id}
                  type="button"
                  onClick={() => {
                    setSelection(service.id);
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
                  <ServiceIcon
                    icon={service.icon}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="truncate font-medium">{service.name}</span>
                </button>
              );
            })}
          </aside>

          <section className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-8">
            {selection === GENERAL_SELECTION ? (
              <div className="max-w-xl space-y-4">
                <h2 className="text-lg font-semibold text-foreground">
                  {t("settings.general")}
                </h2>

                <div className="rounded-lg border border-border bg-card p-4 space-y-2">
                  <h3 className="text-sm font-medium text-foreground">
                    {t("settings.reportProblem.title")}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t("settings.reportProblem.help")}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    onClick={() => {
                      void openUserFeedback();
                    }}
                  >
                    <MessageSquareWarning className="h-4 w-4" />
                    {t("settings.reportProblem.action")}
                  </Button>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="app-language"
                      className="text-sm font-medium text-foreground"
                      title={t("settings.languageHelp")}
                    >
                      {t("settings.language")}
                    </label>
                    <select
                      id="app-language"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={language}
                      disabled={!loaded}
                      title={t("settings.languageHelp")}
                      onChange={(e) => {
                        void setLanguage(e.target.value as SupportedLanguage);
                      }}
                    >
                      {SUPPORTED_LANGUAGES.map((code) => (
                        <option key={code} value={code}>
                          {LANGUAGE_LABELS[code]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <p
                      className="text-sm font-medium text-foreground"
                      title={t("settings.environment.help")}
                    >
                      {t("settings.environment.title")}
                    </p>
                    <div
                      role="radiogroup"
                      aria-label={t("settings.environment.title")}
                      title={t("settings.environment.help")}
                      className="inline-flex h-9 items-center rounded-md border border-input p-0.5"
                    >
                      {ENVIRONMENT_MODES.map((mode) => {
                        const active = environmentMode === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            disabled={!loaded || switchingEnvironment}
                            className={cn(
                              "h-full rounded-[5px] px-3 text-sm font-medium transition-colors disabled:opacity-50",
                              active
                                ? "bg-primary text-primary-foreground"
                                : "text-foreground/70 hover:bg-muted",
                            )}
                            onClick={() => {
                              if (mode === environmentMode) return;
                              setEnvironmentError(null);
                              setPendingEnvironmentMode(mode);
                            }}
                          >
                            {t(`settings.environment.modes.${mode}`)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {pendingEnvironmentMode && (
                  <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
                    <p className="text-sm font-medium text-foreground">
                      {t("settings.environment.confirmTitle", {
                        mode: t(
                          `settings.environment.modes.${pendingEnvironmentMode}`,
                        ),
                      })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.environment.confirmDescription")}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={switchingEnvironment}
                        onClick={() => void handleConfirmEnvironmentSwitch()}
                      >
                        {switchingEnvironment ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : null}
                        {t("settings.environment.restartNow")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={switchingEnvironment}
                        onClick={() => setPendingEnvironmentMode(null)}
                      >
                        {t("settings.environment.cancel")}
                      </Button>
                    </div>
                  </div>
                )}
                {environmentError && (
                  <p className="text-sm text-destructive">{environmentError}</p>
                )}

                {environmentMode === "dev" && (
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void handleOpenDevTools()}
                    >
                      <Bug className="mr-2 h-4 w-4" />
                      {t("settings.environment.openDevTools")}
                    </Button>
                    {devToolsError && (
                      <p className="mt-1 text-sm text-destructive">
                        {devToolsError}
                      </p>
                    )}
                  </div>
                )}

                <AppearanceSettings />
              </div>
            ) : selection === MENU_SELECTION ? (
              <MenuLayoutSettings />
            ) : !loaded || !selectedService ? (
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
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">
                        {t("settings.labelPrinterRules")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.labelPrinterRulesHelp")}
                      </p>
                    </div>
                    {selectedServiceId === "envia-shipping" &&
                      onOpenServicePath && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={handleConfigurePrinting}
                        >
                          <ExternalLink className="mr-2 h-4 w-4" />
                          {t("settings.configurePrinting")}
                        </Button>
                      )}
                  </div>

                  {printersLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t("settings.loadingPrinters")}
                    </div>
                  ) : printersError ? (
                    <p className="text-sm text-destructive">{printersError}</p>
                  ) : (
                    <div className="space-y-4">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="label-printer-default"
                          className="text-xs font-medium text-muted-foreground"
                        >
                          {t("settings.labelPrinterDefault")}
                        </label>
                        <select
                          id="label-printer-default"
                          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
                          disabled={prefs.labelPrintMode !== "instant"}
                          value={prefs.labelPrinterDefault}
                          onChange={(e) => {
                            void setLabelPrinterDefault(
                              selectedServiceId,
                              e.target.value,
                            );
                            setTestMessage(null);
                          }}
                        >
                          <option value="">
                            {t("settings.systemDefaultPrinter")}
                          </option>
                          {printers.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.name}
                              {p.isDefault
                                ? ` (${t("settings.defaultBadge")})`
                                : ""}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-muted-foreground">
                          {t("settings.labelPrinterDefaultHelp")}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-[12rem] flex-1 space-y-1.5">
                          <label
                            htmlFor="add-printer"
                            className="text-xs font-medium text-muted-foreground"
                          >
                            {t("settings.addPrinter")}
                          </label>
                          <select
                            id="add-printer"
                            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
                            disabled={
                              prefs.labelPrintMode !== "instant" ||
                              availableToAdd.length === 0
                            }
                            value={addPrinterName}
                            onChange={(e) => setAddPrinterName(e.target.value)}
                          >
                            <option value="">
                              {availableToAdd.length === 0
                                ? t("settings.noPrintersToAdd")
                                : t("settings.selectPrinter")}
                            </option>
                            {availableToAdd.map((p) => (
                              <option key={p.name} value={p.name}>
                                {p.name}
                                {p.isDefault
                                  ? ` (${t("settings.defaultBadge")})`
                                  : ""}
                              </option>
                            ))}
                          </select>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={
                            prefs.labelPrintMode !== "instant" ||
                            !addPrinterName
                          }
                          onClick={handleAddPrinter}
                        >
                          <Plus className="mr-2 h-4 w-4" />
                          {t("settings.addPrinter")}
                        </Button>
                      </div>

                      {prefs.labelPrinterRules.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          {t("settings.noConfiguredPrinters")}
                        </p>
                      ) : (
                        prefs.labelPrinterRules.map((rule) => (
                          <div
                            key={rule.printer}
                            className="space-y-3 rounded-lg border border-border p-3"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-sm font-medium text-foreground">
                                {rule.printer}
                              </p>
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    testBusy ||
                                    prefs.labelPrintMode === "save" ||
                                    printersLoading
                                  }
                                  onClick={() =>
                                    void handleTestPrint(rule.printer)
                                  }
                                >
                                  {testBusy ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  ) : (
                                    <Printer className="mr-2 h-4 w-4" />
                                  )}
                                  {t("settings.testPrint")}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={prefs.labelPrintMode !== "instant"}
                                  onClick={() =>
                                    handleRemovePrinter(rule.printer)
                                  }
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  {t("settings.removePrinter")}
                                </Button>
                              </div>
                            </div>
                            <div className="grid max-h-56 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
                              {CATALOG_PRINT_SIZES.map((size) => {
                                const checked = rule.sizeIds.includes(size.id);
                                const inputId = `${rule.printer}-${size.id}`;
                                return (
                                  <label
                                    key={size.id}
                                    htmlFor={inputId}
                                    className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-muted/50"
                                  >
                                    <input
                                      id={inputId}
                                      type="checkbox"
                                      className="mt-0.5"
                                      disabled={
                                        prefs.labelPrintMode !== "instant"
                                      }
                                      checked={checked}
                                      onChange={(e) =>
                                        handleToggleSize(
                                          rule.printer,
                                          size.id,
                                          e.target.checked,
                                        )
                                      }
                                    />
                                    <span>
                                      <span className="block font-medium text-foreground">
                                        {size.description}
                                      </span>
                                      <span className="block text-muted-foreground">
                                        {size.id}
                                      </span>
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      testBusy ||
                      prefs.labelPrintMode === "save" ||
                      printersLoading
                    }
                    onClick={() =>
                      void handleTestPrint(prefs.labelPrinterDefault || undefined)
                    }
                  >
                    {testBusy ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Printer className="mr-2 h-4 w-4" />
                    )}
                    {t("settings.testPrintDefault")}
                  </Button>
                  {testMessage && (
                    <p className="text-sm text-muted-foreground">
                      {testMessage}
                    </p>
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
