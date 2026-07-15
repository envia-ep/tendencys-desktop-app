import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useServiceStore } from "@/stores/service-store";
import { MENU_COLLAPSED_WIDTH, MENU_EXPANDED_WIDTH } from "@/config/layout";
import {
  listenAuthRequired,
  listenServiceLoaded,
  listenServiceNavigated,
  navigateService,
  prewarmService,
  reloadService,
  selectService,
  setContentLeftInset,
  setServiceVisible,
} from "@/lib/native-webviews";
import {
  buildServiceSsoUrl,
  buildServiceViewUrl,
  openInBrowser,
} from "@/lib/tendencys-auth";
import {
  createShellHistory,
  isAuthNoiseUrl,
  pathFromServiceUrl,
  type ShellHistoryEntry,
} from "@/lib/shell-history";
import { ssoCaptureFailure, ssoLog } from "@/lib/sso-log";
import { ensureAtidSeeded } from "@/lib/atid-jar";
import { getServiceById, SERVICES, type ServiceDefinition } from "@/config/services";

/** If a product webview never fires its first-load event, surface a retry. */
const LOAD_TIMEOUT_MS = 20000;
/** Minimum gap between _atid reseeds for the same service — prevents auth-required loops. */
const SEED_COOLDOWN_MS = 30_000;
/** Wait for first service paint before pre-warm. */
const PREWARM_DELAY_MS = 2500;
/**
 * Gap between each service pre-warm. Without it, every product's `/login-sites`
 * handoff fires within a couple seconds of login — a burst from one IP that can
 * trip the Accounts edge rate limit.
 */
const PREWARM_STAGGER_MS = 1200;

/**
 * Product SSO + native webview orchestration (seed gate, select, prewarm,
 * auth-required reseed, shell history). AppShell stays layout-only.
 */
export function useProductSso() {
  const session = useAuthStore((s) => s.session);
  const justAuthenticated = useAuthStore((s) => s.justAuthenticated);
  const consumeJustAuthenticated = useAuthStore((s) => s.consumeJustAuthenticated);
  const activeService = useServiceStore((s) => s.activeService);
  const setActiveService = useServiceStore((s) => s.setActiveService);
  const loadServiceData = useServiceStore((s) => s.loadServiceData);
  const menuCollapsed = useServiceStore((s) => s.menuCollapsed);
  const setLastPath = useServiceStore((s) => s.setLastPath);
  const ssoInitiated = useServiceStore((s) => s.ssoInitiated);
  const markSsoInitiated = useServiceStore((s) => s.markSsoInitiated);
  const clearSsoInitiatedFor = useServiceStore((s) => s.clearSsoInitiatedFor);
  const lastPaths = useServiceStore((s) => s.lastPaths);

  const isAuthenticated = Boolean(session);

  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  /** True once jar has `_atid` (or seeded from session.token). Gates product SSO. */
  const [sessionReady, setSessionReady] = useState(false);
  /** Bumps once per fresh login to start pre-warm without canceling on flag consume. */
  const [prewarmToken, setPrewarmToken] = useState(0);

  const currentPath = lastPaths[activeService.id] ?? "/";
  const shellHistoryRef = useRef(createShellHistory());
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

  const [loadingServiceId, setLoadingServiceId] = useState<string | null>(null);
  const [errorServiceId, setErrorServiceId] = useState<string | null>(null);
  const nativeMountedRef = useRef<Set<string>>(new Set());
  const ssoFailedRef = useRef<Set<string>>(new Set());
  const ssoReseedTriedRef = useRef<Set<string>>(new Set());
  const seedLastAtRef = useRef<Record<string, number>>({});
  const lastUrlRef = useRef<Record<string, string>>({});
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (!isAuthenticated) {
      setSessionReady(false);
      return;
    }
    let cancelled = false;
    setSessionReady(false);
    void (async () => {
      if (!session?.token) return;
      const ready = await ensureAtidSeeded(session.token);
      if (!cancelled) setSessionReady(ready);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, session?.token]);

  useEffect(() => {
    if (!isAuthenticated || !sessionReady) return;
    if (!justAuthenticated) return;
    consumeJustAuthenticated();
    setPrewarmToken((n) => n + 1);
  }, [
    isAuthenticated,
    justAuthenticated,
    sessionReady,
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
    if (!isAuthenticated || !sessionReady) return;
    const service = activeService;

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
      void selectService(service.id, url).then(() =>
        navigateService(service.id, url),
      );
      return;
    }

    nativeMountedRef.current.add(service.id);
    lastUrlRef.current[service.id] = url;
    beginLoad(service.id);
    void selectService(service.id, url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeService.id, isAuthenticated, sessionReady, beginLoad]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenServiceLoaded((serviceId) => {
      ssoLog(`service=${serviceId} OK (service-loaded)`);
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

  useEffect(() => {
    if (!isAuthenticated || prewarmToken === 0) return;

    let cancelled = false;
    const activeId = activeService.id;
    const timer = setTimeout(async () => {
      let warmed = 0;
      for (const service of SERVICES) {
        if (cancelled) return;
        if (service.id === activeId) continue;
        if (service.authMode === "unsupported" || service.ssoReady === false) {
          continue;
        }
        if (nativeMountedRef.current.has(service.id)) continue;
        const sso = buildServiceSsoUrl(service);
        if (!sso) continue;
        if (warmed > 0) {
          await new Promise((resolve) => setTimeout(resolve, PREWARM_STAGGER_MS));
          if (cancelled) return;
        }
        nativeMountedRef.current.add(service.id);
        lastUrlRef.current[service.id] = sso;
        markSsoInitiated(service.id);
        warmed += 1;
        try {
          await prewarmService(service.id, sso);
        } catch {
          nativeMountedRef.current.delete(service.id);
          clearSsoInitiatedFor(service.id);
        }
      }
    }, PREWARM_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, prewarmToken]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenAuthRequired((serviceId) => {
      ssoLog(`service=${serviceId} FAILED (auth-required -> Accounts /login)`);
      const failedService = SERVICES.find((s) => s.id === serviceId);

      if (
        failedService?.authMode === "login-sites" &&
        failedService.ssoReady !== false &&
        !ssoReseedTriedRef.current.has(serviceId)
      ) {
        const token = useAuthStore.getState().session?.token;
        const sso = buildServiceSsoUrl(failedService);
        const lastSeedAt = seedLastAtRef.current[serviceId] ?? 0;
        const sinceLastSeedMs = Date.now() - lastSeedAt;
        if (token && sso) {
          if (sinceLastSeedMs < SEED_COOLDOWN_MS) {
            ssoLog(`service=${serviceId} auth-required -> reseed skipped (cooldown)`);
          } else {
            ssoReseedTriedRef.current.add(serviceId);
            seedLastAtRef.current[serviceId] = Date.now();
            ssoLog(`service=${serviceId} auth-required -> reseed _atid + retry login-sites`);
            if (serviceId === activeService.id) beginLoad(serviceId);
            void (async () => {
              try {
                await ensureAtidSeeded(token);
                lastUrlRef.current[serviceId] = sso;
                await navigateService(serviceId, sso);
              } catch {
                // Fall through on next auth-required.
              }
            })();
            return;
          }
        }
      }

      nativeMountedRef.current.delete(serviceId);
      ssoFailedRef.current.add(serviceId);
      clearSsoInitiatedFor(serviceId);

      ssoCaptureFailure("silent SSO failed; surfacing product login", {
        serviceId,
        authMode: failedService?.authMode ?? "unknown",
        reseedTried: ssoReseedTriedRef.current.has(serviceId),
      });

      if (serviceId !== activeService.id) return;
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
      setLoadingServiceId((prev) => (prev === serviceId ? null : prev));
      setErrorServiceId((prev) => (prev === serviceId ? null : prev));
      void setServiceVisible(true);
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

  useEffect(() => {
    const width = menuCollapsed ? MENU_COLLAPSED_WIDTH : MENU_EXPANDED_WIDTH;
    setContentLeftInset(width).catch((err) => {
      console.error("[useProductSso] setContentLeftInset failed", err);
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

  return {
    activeService,
    canGoBack,
    canGoForward,
    loadingServiceId,
    errorServiceId,
    handleSelectService,
    handleNavigateBack,
    handleNavigateForward,
    handleRefresh,
    handleOpenInBrowser,
    handleUserMenuOpenChange,
    handleNativeRetry,
  };
}
