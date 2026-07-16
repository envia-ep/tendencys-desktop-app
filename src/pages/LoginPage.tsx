import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { AlertCircle, ExternalLink, Loader2, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { WelcomeScreen } from "@/components/auth/WelcomeScreen";
import { useAuthStore } from "@/stores/auth-store";
import { buildShellAuthUrl, openInBrowser } from "@/lib/tendencys-auth";
import { tryDeviceKeyLogin } from "@/lib/device-keys";
import { isLoginStarted, setLoginStarted } from "@/lib/login-gate";

/** Silent device-key API call only — a slow/absent key is normal, not an error. */
const CHECK_TIMEOUT_MS = 10000;

/**
 * Recovery timeout for the "Continue in your browser" screen. If the browser
 * never hands the JWT back (e.g. lost/misdirected deep link — see README's
 * "Only one process should own the tendencys:// scheme" note), this bounds an
 * otherwise-infinite spinner and drops the user onto the retryable timedOut phase.
 */
const BROWSER_TIMEOUT_MS = 120000;

type Phase = "checking" | "welcome" | "awaitingBrowser" | "timedOut";

export function resetLoginGate() {
  setLoginStarted(false);
}

export default function LoginPage() {
  const { t } = useTranslation();
  const session = useAuthStore((s) => s.session);
  const isInitialized = useAuthStore((s) => s.isInitialized);
  const [phase, setPhase] = useState<Phase>("checking");
  const [authPath, setAuthPath] = useState<"login" | "signup">("login");
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const browserTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCheckTimer = useCallback(() => {
    if (checkTimerRef.current) {
      clearTimeout(checkTimerRef.current);
      checkTimerRef.current = null;
    }
  }, []);

  const clearBrowserTimer = useCallback(() => {
    if (browserTimerRef.current) {
      clearTimeout(browserTimerRef.current);
      browserTimerRef.current = null;
    }
  }, []);

  const armBrowserTimer = useCallback(() => {
    clearBrowserTimer();
    browserTimerRef.current = setTimeout(() => {
      if (useAuthStore.getState().session) return;
      setPhase((prev) => (prev === "awaitingBrowser" ? "timedOut" : prev));
    }, BROWSER_TIMEOUT_MS);
  }, [clearBrowserTimer]);

  /** Only path: system browser can complete Cloudflare Managed Challenges. */
  const startInteractiveAuth = useCallback(
    async (path: "login" | "signup") => {
      clearCheckTimer();
      setAuthPath(path);
      setPhase("awaitingBrowser");
      armBrowserTimer();
      try {
        await openInBrowser(buildShellAuthUrl(path));
      } catch {
        clearBrowserTimer();
        setPhase("timedOut");
      }
    },
    [clearCheckTimer, armBrowserTimer, clearBrowserTimer],
  );

  const startAuth = useCallback(
    async (force = false) => {
      setPhase("checking");
      clearCheckTimer();

      // Remint already owned the silent path for this launch (profile restore).
      // Skip a redundant options+login unless the user explicitly retries.
      if (!force && useAuthStore.getState().silentLoginAttempted) {
        setPhase("welcome");
        return;
      }

      checkTimerRef.current = setTimeout(() => {
        if (useAuthStore.getState().session) return;
        // A slow/absent device key is a normal case, not an error — land on Welcome.
        setPhase((prev) => (prev === "checking" ? "welcome" : prev));
      }, CHECK_TIMEOUT_MS);

      const accountId = useAuthStore.getState().activeAccountId;
      const deviceResult = accountId
        ? await tryDeviceKeyLogin(accountId, { force })
        : { kind: "unavailable" as const };
      clearCheckTimer();
      if (useAuthStore.getState().session) return;

      if (deviceResult.kind === "handoff") {
        const ok = await useAuthStore
          .getState()
          .validateAndLogin(deviceResult.authorization, deviceResult.sessionToken);
        if (ok) return;
      }
      if (deviceResult.kind === "intermediate") {
        // Open Accounts intermediate step (terms / phone) in the system browser;
        // deep link still returns to the app with the handoff JWT.
        try {
          await openInBrowser(deviceResult.redirectUrl);
          setPhase("awaitingBrowser");
          armBrowserTimer();
          return;
        } catch {
          // Fall through to Welcome.
        }
      }
      // Everything else (unavailable, error, and a rate_limited backoff) lands on
      // Welcome so the user decides when to retry — no automatic re-fire that would
      // pile more requests onto the same edge that rate-limited us.
      setPhase((prev) => (prev === "timedOut" ? prev : "welcome"));
    },
    [clearCheckTimer, armBrowserTimer],
  );

  const retryLogin = useCallback(async () => {
    clearCheckTimer();
    clearBrowserTimer();
    setLoginStarted(true);
    await startAuth(true);
  }, [clearCheckTimer, clearBrowserTimer, startAuth]);

  useEffect(() => {
    if (session) {
      setLoginStarted(false);
      clearCheckTimer();
      clearBrowserTimer();
      return;
    }
    if (!isInitialized || isLoginStarted()) return;
    setLoginStarted(true);
    void startAuth();
  }, [isInitialized, session, startAuth, clearCheckTimer, clearBrowserTimer]);

  useEffect(() => {
    return () => {
      clearCheckTimer();
      clearBrowserTimer();
    };
  }, [clearCheckTimer, clearBrowserTimer]);

  if (isInitialized && session) {
    return <Navigate to="/" replace />;
  }

  if (phase === "welcome") {
    return (
      <WelcomeScreen
        onSignIn={() => void startInteractiveAuth("login")}
        onCreateAccount={() => void startInteractiveAuth("signup")}
      />
    );
  }

  if (phase === "awaitingBrowser") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-primary p-8 text-white">
        <Loader2 className="h-10 w-10 animate-spin" />
        <h1 className="text-xl font-semibold">{t("login.browserTitle")}</h1>
        <p className="max-w-md text-center text-white/80">
          {t("login.browserDescription")}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="secondary"
            onClick={() => void startInteractiveAuth(authPath)}
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            {t("login.openInBrowser")}
          </Button>
          <Button
            variant="outline"
            className="border-white/30 bg-transparent text-white hover:bg-white/10"
            onClick={() => setPhase("welcome")}
          >
            {t("login.backToWelcome")}
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "timedOut") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-primary p-8 text-white">
        <AlertCircle className="h-10 w-10 text-red-300" />
        <h1 className="text-xl font-semibold">{t("login.timeoutTitle")}</h1>
        <p className="max-w-md text-center text-white/80">
          {t("login.timeoutDescription")}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => void startInteractiveAuth(authPath)}>
            <ExternalLink className="mr-2 h-4 w-4" />
            {t("login.openInBrowser")}
          </Button>
          <Button
            variant="outline"
            className="border-white/30 bg-transparent text-white hover:bg-white/10"
            onClick={() => void retryLogin()}
          >
            <RotateCw className="mr-2 h-4 w-4" />
            {t("auth.tryAgain")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-primary text-white">
      <Loader2 className="h-10 w-10 animate-spin" />
      <p>{t("login.signingIn")}</p>
    </div>
  );
}
