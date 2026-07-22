import { AlertCircle, ExternalLink, Loader2, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ServiceMenu } from "./ServiceMenu";
import { Button } from "@/components/ui/button";
import { DockTipBanner } from "@/components/DockTipBanner";
import { HomeHub } from "@/components/home/HomeHub";
import { DevelopersHub } from "@/components/developers/DevelopersHub";
import { DesktopSettings } from "@/components/settings/DesktopSettings";
import { useServiceStore } from "@/stores/service-store";
import { useProductSso } from "@/hooks/useProductSso";
import { openInBrowser } from "@/lib/tendencys-auth";
import type { ServiceDefinition } from "@/config/services";

export function AppShell() {
  const menuCollapsed = useServiceStore((s) => s.menuCollapsed);
  const toggleMenuCollapsed = useServiceStore((s) => s.toggleMenuCollapsed);
  const {
    activeService,
    shellView,
    canGoBack,
    canGoForward,
    loadingServiceId,
    errorServiceId,
    handleSelectService,
    handleOpenServicePath,
    handleShowHome,
    handleShowDevelopers,
    handleShowSettings,
    handleNavigateBack,
    handleNavigateForward,
    handleRefresh,
    handleOpenInBrowser,
    handleUserMenuOpenChange,
    handleNativeRetry,
  } = useProductSso();

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <DockTipBanner />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ServiceMenu
          activeService={activeService}
          shellView={shellView}
          collapsed={menuCollapsed}
          onSelectService={handleSelectService}
          onShowHome={handleShowHome}
          onShowDevelopers={handleShowDevelopers}
          onShowSettings={handleShowSettings}
          onToggleCollapsed={toggleMenuCollapsed}
          onOpenInBrowser={handleOpenInBrowser}
          onNavigateBack={handleNavigateBack}
          onNavigateForward={handleNavigateForward}
          onRefresh={handleRefresh}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onUserMenuOpenChange={handleUserMenuOpenChange}
        />

        {shellView === "home" && (
          <HomeHub onOpenService={handleSelectService} />
        )}
        {shellView === "developers" && (
          <DevelopersHub
            onOpenServicePath={handleOpenServicePath}
            onOpenDocs={(url) => {
              void openInBrowser(url);
            }}
          />
        )}
        {shellView === "settings" && <DesktopSettings />}
        {shellView === "service" && (
          <NativeServiceArea
            service={activeService}
            isLoading={loadingServiceId === activeService.id}
            hasError={errorServiceId === activeService.id}
            onRetry={() => handleNativeRetry(activeService)}
            onOpenInBrowser={handleOpenInBrowser}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Placeholder region the native product webview overlays. While the webview is
 * hidden (first load / error) these overlays are what the user sees; once the
 * webview reveals it paints on top of this element.
 */
function NativeServiceArea({
  service,
  isLoading,
  hasError,
  onRetry,
  onOpenInBrowser,
}: {
  service: ServiceDefinition;
  isLoading: boolean;
  hasError: boolean;
  onRetry: () => void;
  onOpenInBrowser: () => void;
}) {
  const { t } = useTranslation();

  return (
    <main className="relative flex min-w-0 flex-1 flex-col bg-white">
      {isLoading && !hasError && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">
            {t("webView.loading", { service: service.name })}
          </p>
        </div>
      )}
      {hasError && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-white p-8 text-center">
          <AlertCircle className="h-10 w-10 text-red-400" />
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              {t("webView.loadErrorTitle", { service: service.name })}
            </h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              {t("webView.loadErrorDescription")}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={onRetry}>
              <RotateCw className="mr-2 h-4 w-4" />
              {t("webView.retry")}
            </Button>
            <Button variant="outline" onClick={onOpenInBrowser}>
              <ExternalLink className="mr-2 h-4 w-4" />
              {t("webView.openInBrowser")}
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}
