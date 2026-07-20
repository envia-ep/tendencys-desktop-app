import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useServiceStore } from "@/stores/service-store";
import { MENU_COLLAPSED_WIDTH, MENU_EXPANDED_WIDTH } from "@/config/layout";
import {
  listenAuthRequired,
  listenServiceLoaded,
  listenServiceNavigated,
  listenVerificationRequired,
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
import { hasDeviceKey, tryDeviceKeyLogin } from "@/lib/device-keys";
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
  const shellView = useServiceStore((s) => s.shellView);
  const showHome = useServiceStore((s) => s.showHome);
  const showDevelopers = useServiceStore((s) => s.showDevelopers);
  const showSettings = useServiceStore((s) => s.showSettings);
  const showService = useServiceStore((s) => s.showService);
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
  /**
   * service_ids currently parked on an Accounts step-up page (2FA `/verify`,
   * terms, phone/device verification) via their own `/login-sites` handoff.
   * Completing the step in one service satisfies it account-wide, so once any
   * of these navigates away from Accounts, every *other* pending id gets its
   * SSO handoff retried automatically instead of making the user repeat the
   * same verification once per open product.
   */
  const pendingVerificationRef = useRef<Set<string>>(new Set());
  /**
   * Deep-link path requested from Developers (etc.). `select_service` ignores
   * the URL when the webview already exists, and first-load SSO lands on the
   * product home — so we navigate to this path after show / after SSO settles.
   */
  const pendingDeepLinkRef = useRef<Record<string, string>>({});
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
    // Fresh login or multi-email switch: drop prior product mount/SSO state so
    // webviews re-run /login-sites under the new `_atid` (jar already wiped).
    nativeMountedRef.current.clear();
    ssoFailedRef.current.clear();
    ssoReseedTriedRef.current.clear();
    pendingVerificationRef.current.clear();
    pendingDeepLinkRef.current = {};
    seedLastAtRef.current = {};
    lastUrlRef.current = {};
    shellHistoryRef.current.clear();
    knownUrlsRef.current = {};
    syncHistoryButtons();
    selectInFlightRef.current = null;
    consumeJustAuthenticated();
    setPrewarmToken((n) => n + 1);
    showHome();
    void setServiceVisible(false);
  }, [
    isAuthenticated,
    justAuthenticated,
    sessionReady,
    consumeJustAuthenticated,
    syncHistoryButtons,
    showHome,
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

  const consumePendingDeepLink = useCallback(
    (serviceId: string) => {
      const path = pendingDeepLinkRef.current[serviceId];
      if (!path) return;
      const service = getServiceById(serviceId);
      if (!service) return;
      delete pendingDeepLinkRef.current[serviceId];
      const targetUrl = buildServiceViewUrl(service, path);
      knownUrlsRef.current[serviceId] = targetUrl;
      lastUrlRef.current[serviceId] = targetUrl;
      void setLastPath(serviceId, path);
      if (serviceId === useServiceStore.getState().activeService.id) {
        beginLoad(serviceId);
      }
      void navigateService(serviceId, targetUrl);
    },
    [beginLoad, setLastPath],
  );

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
    if (shellView !== "service") {
      void setServiceVisible(false);
      return;
    }

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
    // Existing webviews ignore `url` in select_service — apply deep links after show.
    void selectService(service.id, url).then(() => {
      if (!useSso && pendingDeepLinkRef.current[service.id]) {
        consumePendingDeepLink(service.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeService.id,
    isAuthenticated,
    sessionReady,
    shellView,
    beginLoad,
    consumePendingDeepLink,
  ]);

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

  /**
   * A service navigating off Accounts after being parked on a step-up page
   * means the account-wide requirement (2FA/terms/phone) is now satisfied —
   * retry every other still-pending service's `/login-sites` handoff so the
   * user isn't asked to repeat the same step once per open product.
   */
  const retryOtherPendingVerifications = useCallback(
    (resolvedServiceId: string) => {
      pendingVerificationRef.current.delete(resolvedServiceId);
      if (pendingVerificationRef.current.size === 0) return;
      const others = Array.from(pendingVerificationRef.current);
      pendingVerificationRef.current.clear();
      for (const serviceId of others) {
        const service = getServiceById(serviceId);
        const sso = service && buildServiceSsoUrl(service);
        if (!sso) continue;
        ssoLog(`service=${serviceId} verification-required resolved elsewhere -> retry login-sites`);
        lastUrlRef.current[serviceId] = sso;
        if (serviceId === activeService.id) beginLoad(serviceId);
        void navigateService(serviceId, sso);
      }
    },
    [activeService.id, beginLoad],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenServiceNavigated((event) => {
      if (pendingVerificationRef.current.has(event.serviceId)) {
        retryOtherPendingVerifications(event.serviceId);
      }

      const pendingPath = pendingDeepLinkRef.current[event.serviceId];
      if (pendingPath && !isAuthNoiseUrl(event.url)) {
        const service = getServiceById(event.serviceId);
        if (service) {
          try {
            const onProduct =
              new URL(event.url).origin === new URL(service.url).origin;
            const currentPath = pathFromServiceUrl(service.url, event.url);
            if (onProduct && currentPath !== pendingPath) {
              consumePendingDeepLink(event.serviceId);
              return;
            }
            if (onProduct && currentPath === pendingPath) {
              delete pendingDeepLinkRef.current[event.serviceId];
            }
          } catch {
            // fall through to recordNavigation
          }
        }
      }

      recordNavigation(event.serviceId, event.url, event.replace);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [
    recordNavigation,
    retryOtherPendingVerifications,
    consumePendingDeepLink,
  ]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenVerificationRequired((serviceId) => {
      ssoLog(`service=${serviceId} verification-required (Accounts step-up page)`);
      pendingVerificationRef.current.add(serviceId);
      if (serviceId !== activeService.id) return;
      if (useServiceStore.getState().shellView !== "service") return;
      // The native webview already shows the Accounts step-up page (2FA
      // code entry, terms, phone/device verification) — clear any loading
      // overlay so it isn't hidden behind a spinner, but do not touch
      // nativeMountedRef/ssoFailedRef: this is not a failure to retry, it's
      // waiting on the user.
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
  }, [activeService.id]);

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
                let seedToken = token;
                // Seed-first may leave a token that /login-sites still rejects —
                // remint via device key once, then seed that session token.
                const accountId =
                  useAuthStore.getState().session?.account.id ??
                  useAuthStore.getState().activeAccountId;
                if (accountId && (await hasDeviceKey(accountId))) {
                  const remint = await tryDeviceKeyLogin(accountId, {
                    force: true,
                  });
                  if (remint.kind === "handoff" && remint.sessionToken) {
                    seedToken = remint.sessionToken;
                    const current = useAuthStore.getState().session;
                    if (current) {
                      useAuthStore.setState({
                        session: { ...current, token: seedToken },
                      });
                    }
                  }
                }
                await ensureAtidSeeded(seedToken);
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
      if (useServiceStore.getState().shellView !== "service") return;
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
    if (useServiceStore.getState().shellView !== "service") {
      void setServiceVisible(false);
      return;
    }
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
      const wasOnService =
        useServiceStore.getState().shellView === "service";

      // Already on this product webview — no-op.
      if (service.id === prev.id && wasOnService) return;

      if (selectInFlightRef.current !== service.id) {
        selectInFlightRef.current = null;
      }

      if (service.id !== prev.id) {
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
      }

      if (!wasOnService && service.id === prev.id) {
        // Same service from Home/Developers: re-run select effect to show webview.
        selectInFlightRef.current = null;
        showService();
        return;
      }

      setActiveService(service);
    },
    [lastPaths, setActiveService, showService, syncHistoryButtons],
  );

  const handleOpenServicePath = useCallback(
    (service: ServiceDefinition, path: string) => {
      const prev = useServiceStore.getState().activeService;
      const currentView = useServiceStore.getState().shellView;
      const targetUrl = buildServiceViewUrl(service, path);

      pendingDeepLinkRef.current[service.id] = path;

      // Optimistic so the select effect sees the path before async persist.
      useServiceStore.setState((state) => ({
        lastPaths: { ...state.lastPaths, [service.id]: path },
      }));
      void setLastPath(service.id, path);
      delete knownUrlsRef.current[service.id];

      if (selectInFlightRef.current !== service.id) {
        selectInFlightRef.current = null;
      }

      if (service.id === prev.id && currentView === "service") {
        shellHistoryRef.current.push({ serviceId: service.id, url: targetUrl });
        syncHistoryButtons();
        consumePendingDeepLink(service.id);
        return;
      }

      if (service.id !== prev.id) {
        const prevUrl =
          knownUrlsRef.current[prev.id] ??
          buildServiceViewUrl(prev, lastPaths[prev.id] ?? "/");
        if (!shellHistoryRef.current.current()) {
          shellHistoryRef.current.push({ serviceId: prev.id, url: prevUrl });
        }
        shellHistoryRef.current.push({
          serviceId: service.id,
          url: targetUrl,
        });
        syncHistoryButtons();
      }

      if (currentView !== "service" && service.id === prev.id) {
        selectInFlightRef.current = null;
        showService();
        return;
      }

      setActiveService(service);
    },
    [
      consumePendingDeepLink,
      lastPaths,
      setActiveService,
      setLastPath,
      showService,
      syncHistoryButtons,
    ],
  );

  const handleShowHome = useCallback(() => {
    showHome();
    void setServiceVisible(false);
  }, [showHome]);

  const handleShowDevelopers = useCallback(() => {
    showDevelopers();
    void setServiceVisible(false);
  }, [showDevelopers]);

  const handleShowSettings = useCallback(() => {
    showSettings();
    void setServiceVisible(false);
  }, [showSettings]);

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
  };
}
