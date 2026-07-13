import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ExternalLink, Loader2, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ServiceMenu } from "./ServiceMenu";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { useServiceStore } from "@/stores/service-store";
import { MENU_COLLAPSED_WIDTH, MENU_EXPANDED_WIDTH } from "@/config/layout";
import {
  listenAuthRequired,
  listenServiceLoaded,
  listenServiceNavigated,
  navigateService,
  prewarmService,
  readAccountsSession,
  reloadService,
  selectService,
  seedAccountsSession,
  setContentLeftInset,
  setServiceVisible,
} from "@/lib/native-webviews";
import {
  buildServiceSsoUrl,
  buildServiceViewUrl,
  openInBrowser,
  TENDENCYS_BASE_URL,
} from "@/lib/tendencys-auth";
import {
  createShellHistory,
  isAuthNoiseUrl,
  pathFromServiceUrl,
  type ShellHistoryEntry,
} from "@/lib/shell-history";
import { ssoLog } from "@/lib/sso-log";
import { getServiceById, SERVICES, type ServiceDefinition } from "@/config/services";

/** If a product webview never fires its first-load event, surface a retry. */
const LOAD_TIMEOUT_MS = 20000;
/** Wait for auth webview `_atid` settle (500ms) + first service paint before pre-warm. */
const PREWARM_DELAY_MS = 2500;
/** Brief gate so the first `/login-sites` does not race auth webview teardown. */
const SSO_SETTLE_MS = 600;

export function AppShell() {
  const session = useAuthStore((s) => s.session);
  const justAuthenticated = useAuthStore((s) => s.justAuthenticated);
  const consumeJustAuthenticated = useAuthStore((s) => s.consumeJustAuthenticated);
  const activeService = useServiceStore((s) => s.activeService);
  const setActiveService = useServiceStore((s) => s.setActiveService);
  const loadServiceData = useServiceStore((s) => s.loadServiceData);
  const menuCollapsed = useServiceStore((s) => s.menuCollapsed);
  const toggleMenuCollapsed = useServiceStore((s) => s.toggleMenuCollapsed);
  const setLastPath = useServiceStore((s) => s.setLastPath);
  const ssoInitiated = useServiceStore((s) => s.ssoInitiated);
  const markSsoInitiated = useServiceStore((s) => s.markSsoInitiated);
  const clearSsoInitiatedFor = useServiceStore((s) => s.clearSsoInitiatedFor);
  const lastPaths = useServiceStore((s) => s.lastPaths);

  const isAuthenticated = Boolean(session);

  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  /** After fresh shell login, hold product SSO until shared `_atid` can settle. */
  const [ssoReadyGate, setSsoReadyGate] = useState(!justAuthenticated);
  /** Cold restore: shell JWT exists but WKWebView `_atid` may not — seed first. */
  const [atidSeeded, setAtidSeeded] = useState(false);
  /** Bumps once per fresh login to start pre-warm without canceling on flag consume. */
  const [prewarmToken, setPrewarmToken] = useState(0);

  const currentPath = lastPaths[activeService.id] ?? "/";
  const shellHistoryRef = useRef(createShellHistory());
  /** Last known product URL per service (from navigation events). */
  const knownUrlsRef = useRef<Record<string, string>>({});
  const traverseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const syncHistoryButtons = useCallback(() => {
    const history = shellHistoryRef.current;
    setCanGoBack(history.canGoBack());
    setCanGoForward(history.canGoForward());
  }, []);

  const recordNavigation = useCallback(
    (serviceId: string, url: string, replace = false) => {
      if (isAuthNoiseUrl(url)) return;
      const service = getServiceById(serviceId);
      if (!service) return;
      try {
        if (new URL(url).origin !== new URL(service.url).origin) return;
      } catch {
        return;
      }

      knownUrlsRef.current[serviceId] = url;
      void setLastPath(serviceId, pathFromServiceUrl(service.url, url));

      if (serviceId !== useServiceStore.getState().activeService.id) return;

      if (replace) {
        shellHistoryRef.current.replace({ serviceId, url });
      } else {
        shellHistoryRef.current.push({ serviceId, url });
      }
      syncHistoryButtons();
    },
    [setLastPath, syncHistoryButtons],
  );

  useEffect(() => {
    loadServiceData(activeService.id);
  }, [activeService.id, loadServiceData]);

  useEffect(() => {
    if (isAuthenticated) return;
    shellHistoryRef.current.clear();
    knownUrlsRef.current = {};
    syncHistoryButtons();
  }, [isAuthenticated, syncHistoryButtons]);

  // ---------------------------- Native webviews ----------------------------
  const [loadingServiceId, setLoadingServiceId] = useState<string | null>(null);
  const [errorServiceId, setErrorServiceId] = useState<string | null>(null);
  const nativeMountedRef = useRef<Set<string>>(new Set());
  /** Services whose last SSO attempt bounced to Accounts `/login`. */
  const ssoFailedRef = useRef<Set<string>>(new Set());
  /** Services we already re-seeded + retried once after an auth-required bounce. */
  const ssoReseedTriedRef = useRef<Set<string>>(new Set());
  const lastUrlRef = useRef<Record<string, string>>({});
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Coalesce React Strict Mode double-invoke for the same service id. */
  const selectInFlightRef = useRef<string | null>(null);

  const openServiceInBrowser = useCallback(
    async (service: ServiceDefinition, path?: string) => {
      const needsSso =
        service.authMode !== "unsupported" && !ssoInitiated[service.id];
      if (needsSso) {
        const sso = buildServiceSsoUrl(service);
        if (sso) {
          markSsoInitiated(service.id);
          await openInBrowser(sso);
          return;
        }
      }
      await openInBrowser(
        buildServiceViewUrl(service, path ?? lastPaths[service.id] ?? "/"),
      );
    },
    [ssoInitiated, markSsoInitiated, lastPaths],
  );

  useEffect(() => {
    if (!justAuthenticated) {
      setSsoReadyGate(true);
      return;
    }
    setSsoReadyGate(false);
    const timer = setTimeout(() => setSsoReadyGate(true), SSO_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [justAuthenticated]);

  // Ensure a valid `_atid` lives in the shared product cookie jar before SSO.
  // Read first and NEVER clobber a good cookie the /login page or device-key
  // re-mint already set — only seed the in-memory real token when the jar is
  // empty (e.g. cold restore, where the session cookie died with the app quit).
  useEffect(() => {
    if (!isAuthenticated) {
      setAtidSeeded(true);
      return;
    }
    let cancelled = false;
    setAtidSeeded(false);
    void (async () => {
      const existing = await readAccountsSession(TENDENCYS_BASE_URL).catch(
        () => null,
      );
      if (cancelled) return;
      if (existing) {
        setAtidSeeded(true);
        return;
      }
      if (session?.token) {
        await seedAccountsSession(TENDENCYS_BASE_URL, session.token).catch(
          () => undefined,
        );
        if (!cancelled) setAtidSeeded(true);
        return;
      }
      // Authenticated but neither cookie nor in-memory token yet (cold start,
      // pre-re-mint). Hold the gate; re-mint sets session.token and re-runs this.
      if (!cancelled) setAtidSeeded(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, session?.token]);

  // Arm pre-warm on a separate token so consuming justAuthenticated does not
  // clearTimeout the scheduled SSO warm-up (effect cleanup race).
  useEffect(() => {
    if (!isAuthenticated) return;
    if (!justAuthenticated || !ssoReadyGate || !atidSeeded) return;
    consumeJustAuthenticated();
    setPrewarmToken((n) => n + 1);
  }, [
    isAuthenticated,
    justAuthenticated,
    ssoReadyGate,
    atidSeeded,
    consumeJustAuthenticated,
  ]);

  const beginLoad = useCallback((serviceId: string) => {
    setErrorServiceId((prev) => (prev === serviceId ? null : prev));
    setLoadingServiceId(serviceId);
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    loadTimerRef.current = setTimeout(() => {
      setLoadingServiceId((prev) => (prev === serviceId ? null : prev));
      setErrorServiceId(serviceId);
    }, LOAD_TIMEOUT_MS);
  }, []);

  /** First open (or failed-SSO retry) uses login-sites; later opens go direct. */
  const resolveServiceUrl = useCallback(
    (service: ServiceDefinition, useSso: boolean) => {
      if (
        useSso &&
        service.authMode !== "unsupported" &&
        service.ssoReady !== false
      ) {
        const sso = buildServiceSsoUrl(service);
        if (sso) {
          markSsoInitiated(service.id);
          return sso;
        }
      }
      return buildServiceViewUrl(service, lastPaths[service.id] ?? "/");
    },
    [lastPaths, markSsoInitiated],
  );

  useEffect(() => {
    if (!isAuthenticated || !ssoReadyGate || !atidSeeded) return;
    const service = activeService;

    // Strict Mode remounts the effect for the same id; the first pass already
    // marked nativeMounted / kicked selectService — a second pass would open
    // the product URL before the SSO webview exists (exists:false race).
    if (selectInFlightRef.current === service.id) return;
    selectInFlightRef.current = service.id;

    const firstTime = !nativeMountedRef.current.has(service.id);
    const needsSsoRetry = ssoFailedRef.current.has(service.id);
    const useSso = firstTime || needsSsoRetry;
    const url = resolveServiceUrl(service, useSso);

    if (needsSsoRetry) {
      ssoFailedRef.current.delete(service.id);
      nativeMountedRef.current.add(service.id);
      lastUrlRef.current[service.id] = url;
      beginLoad(service.id);
      // Must selectService first so Rust updates `active` and hides the previous
      // webview; navigate alone left activeMismatch and the old service visible.
      void selectService(service.id, url).then(() =>
        navigateService(service.id, url),
      );
      return;
    }

    nativeMountedRef.current.add(service.id);
    lastUrlRef.current[service.id] = url;
    beginLoad(service.id);
    void selectService(service.id, url);
    // resolveServiceUrl intentionally omitted: URL is resolved once per switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeService.id, isAuthenticated, ssoReadyGate, atidSeeded, beginLoad]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenServiceLoaded((serviceId) => {
      ssoLog(`service=${serviceId} OK (service-loaded)`);
      // Fresh successful load — allow a future bounce to self-heal once again.
      ssoReseedTriedRef.current.delete(serviceId);
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
      setLoadingServiceId((prev) => (prev === serviceId ? null : prev));
      setErrorServiceId((prev) => (prev === serviceId ? null : prev));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenServiceNavigated((event) => {
      recordNavigation(event.serviceId, event.url, event.replace);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [recordNavigation]);

  // Eager SSO pre-warm after fresh login. Driven by prewarmToken so consuming
  // justAuthenticated cannot cancel the scheduled warm-up via effect cleanup.
  useEffect(() => {
    if (!isAuthenticated || prewarmToken === 0) return;

    let cancelled = false;
    const activeId = activeService.id;
    // ponytail: fixed delay + sequential warm is the simplest scheduler; it
    // lets the visible service paint first. Pre-warming ~4 web apps costs memory —
    // revisit (requestIdleCallback / concurrency cap) if it regresses startup.
    const timer = setTimeout(async () => {
      for (const service of SERVICES) {
        if (cancelled) return;
        if (service.id === activeId) continue;
        if (service.authMode === "unsupported" || service.ssoReady === false) {
          continue;
        }
        if (nativeMountedRef.current.has(service.id)) continue;
        const sso = buildServiceSsoUrl(service);
        if (!sso) continue;
        nativeMountedRef.current.add(service.id);
        lastUrlRef.current[service.id] = sso;
        markSsoInitiated(service.id);
        try {
          await prewarmService(service.id, sso);
        } catch {
          // Non-fatal: a failed pre-warm just means that service loads on click.
          nativeMountedRef.current.delete(service.id);
          clearSsoInitiatedFor(service.id);
        }
      }
    }, PREWARM_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // activeService.id is captured at fresh-login time on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, prewarmToken]);

  // Failed `/login-sites` (missing `_atid`) lands on Accounts `/login`. Product
  // session death lands on product `/login`. Unburn the one-shot SSO flag so a
  // later rail click (or Sign in) can retry once the cookie exists.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenAuthRequired((serviceId) => {
      ssoLog(`service=${serviceId} FAILED (auth-required -> Accounts /login)`);
      const failedService = SERVICES.find((s) => s.id === serviceId);
      // server-entry intentionally redirects to Accounts `/login`; that is not a
      // failed silent SSO — reveal the webview and let the form/session complete.
      if (failedService?.authMode === "server-entry") {
        if (serviceId === activeService.id) {
          if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
          setLoadingServiceId((prev) => (prev === serviceId ? null : prev));
          void setServiceVisible(true);
        }
        return;
      }

      // One-shot self-heal: a login-sites bounce is usually a missing/stale shared
      // `_atid` (the "varies by user" failure). If we still hold the shell token,
      // re-seed it and retry the handoff once before surfacing the product login —
      // this keeps signed-in users (and Shipping's 2FA) from being stranded.
      if (
        failedService?.authMode === "login-sites" &&
        failedService.ssoReady !== false &&
        !ssoReseedTriedRef.current.has(serviceId)
      ) {
        const token = useAuthStore.getState().session?.token;
        const sso = buildServiceSsoUrl(failedService);
        if (token && sso) {
          ssoReseedTriedRef.current.add(serviceId);
          ssoLog(`service=${serviceId} auth-required -> reseed _atid + retry login-sites`);
          if (serviceId === activeService.id) beginLoad(serviceId);
          void (async () => {
            try {
              await seedAccountsSession(TENDENCYS_BASE_URL, token);
              lastUrlRef.current[serviceId] = sso;
              await navigateService(serviceId, sso);
            } catch {
              // Could not even re-navigate; the next auth-required bounce (retry
              // flag now set) falls through to the visible product login.
            }
          })();
          return;
        }
      }

      nativeMountedRef.current.delete(serviceId);
      ssoFailedRef.current.add(serviceId);
      clearSsoInitiatedFor(serviceId);

      if (serviceId !== activeService.id) return;
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
      setLoadingServiceId((prev) => (prev === serviceId ? null : prev));
      setErrorServiceId((prev) => (prev === serviceId ? null : prev));
      void setServiceVisible(true);
      // Do not auto-navigate back to /login-sites here — without `_atid` that
      // page is a white spinner and retrying loops the blank screen. Rail click
      // / Sign in / seed_accounts_session is the recovery path.
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [activeService.id, clearSsoInitiatedFor, beginLoad]);

  const handleNativeRetry = useCallback(
    (service: ServiceDefinition) => {
      const url =
        lastUrlRef.current[service.id] ?? buildServiceViewUrl(service, "/");
      beginLoad(service.id);
      void navigateService(service.id, url);
    },
    [beginLoad],
  );

  const handleUserMenuOpenChange = useCallback((open: boolean) => {
    void setServiceVisible(!open);
  }, []);

  const restoreHistoryEntry = useCallback(
    async (entry: ShellHistoryEntry) => {
      shellHistoryRef.current.setTraversing(true);
      syncHistoryButtons();
      if (traverseTimerRef.current) clearTimeout(traverseTimerRef.current);

      const service = getServiceById(entry.serviceId);
      if (!service) {
        shellHistoryRef.current.setTraversing(false);
        syncHistoryButtons();
        return;
      }

      if (service.id !== useServiceStore.getState().activeService.id) {
        if (selectInFlightRef.current !== service.id) {
          selectInFlightRef.current = null;
        }
        setActiveService(service);
      }

      const current = knownUrlsRef.current[service.id];
      if (current !== entry.url) {
        knownUrlsRef.current[service.id] = entry.url;
        lastUrlRef.current[service.id] = entry.url;
        try {
          await navigateService(service.id, entry.url);
        } catch {
          // Webview may not exist yet; select effect will create/show it.
        }
      }

      traverseTimerRef.current = setTimeout(() => {
        shellHistoryRef.current.setTraversing(false);
        syncHistoryButtons();
      }, 400);
    },
    [setActiveService, syncHistoryButtons],
  );

  const handleSelectService = useCallback(
    (service: ServiceDefinition) => {
      const prev = useServiceStore.getState().activeService;
      if (service.id === prev.id) return;

      // Allow the select effect to run again when switching to a different service
      // (selectInFlightRef may still hold the previous id from Strict Mode coalesce).
      if (selectInFlightRef.current !== service.id) {
        selectInFlightRef.current = null;
      }

      const prevUrl =
        knownUrlsRef.current[prev.id] ??
        buildServiceViewUrl(prev, lastPaths[prev.id] ?? "/");
      if (!shellHistoryRef.current.current()) {
        shellHistoryRef.current.push({ serviceId: prev.id, url: prevUrl });
      }

      const url =
        knownUrlsRef.current[service.id] ??
        buildServiceViewUrl(service, lastPaths[service.id] ?? "/");
      shellHistoryRef.current.push({ serviceId: service.id, url });
      syncHistoryButtons();

      setActiveService(service);
    },
    [lastPaths, setActiveService, syncHistoryButtons],
  );

  // Keep the native product webview glued to the collapsible menu's width.
  useEffect(() => {
    const width = menuCollapsed ? MENU_COLLAPSED_WIDTH : MENU_EXPANDED_WIDTH;
    setContentLeftInset(width).catch((err) => {
      console.error("[AppShell] setContentLeftInset failed", err);
    });
  }, [menuCollapsed]);

  const handleNavigateBack = useCallback(() => {
    const entry = shellHistoryRef.current.back();
    if (!entry) {
      syncHistoryButtons();
      return;
    }
    void restoreHistoryEntry(entry);
  }, [restoreHistoryEntry, syncHistoryButtons]);

  const handleNavigateForward = useCallback(() => {
    const entry = shellHistoryRef.current.forward();
    if (!entry) {
      syncHistoryButtons();
      return;
    }
    void restoreHistoryEntry(entry);
  }, [restoreHistoryEntry, syncHistoryButtons]);

  const handleRefresh = useCallback(() => {
    beginLoad(activeService.id);
    void reloadService();
  }, [activeService.id, beginLoad]);

  const handleOpenInBrowser = useCallback(async () => {
    await openServiceInBrowser(activeService, currentPath);
  }, [activeService, currentPath, openServiceInBrowser]);

  return (
    <div className="flex h-screen overflow-hidden">
      <ServiceMenu
        activeService={activeService}
        collapsed={menuCollapsed}
        onSelectService={handleSelectService}
        onToggleCollapsed={toggleMenuCollapsed}
        onOpenInBrowser={handleOpenInBrowser}
        onNavigateBack={handleNavigateBack}
        onNavigateForward={handleNavigateForward}
        onRefresh={handleRefresh}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onUserMenuOpenChange={handleUserMenuOpenChange}
      />

      <NativeServiceArea
        service={activeService}
        isLoading={loadingServiceId === activeService.id}
        hasError={errorServiceId === activeService.id}
        onRetry={() => handleNativeRetry(activeService)}
        onOpenInBrowser={handleOpenInBrowser}
      />
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
