import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { AlertCircle, Loader2, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { WelcomeScreen } from "@/components/auth/WelcomeScreen";
import { useAuthStore } from "@/stores/auth-store";
import {
  DEEP_LINK_SCHEME,
  SHELL_SITE_ID,
  TENDENCYS_BASE_URL,
} from "@/lib/tendencys-auth";
import { LOGIN_RAIL_WIDTH } from "@/config/layout";
import {
  closeShellLogin,
  listenShellLoginLoaded,
  openShellLogin,
} from "@/lib/native-webviews";
import { tryDeviceKeyLogin } from "@/lib/device-keys";

/** Survive React Strict Mode remounts — one auth attempt per unauthenticated visit. */
let loginStarted = false;

/** Silent device-key API call only — a slow/absent key is normal, not an error. */
const CHECK_TIMEOUT_MS = 10000;
/**
 * Webview opening only — armed until Accounts' page actually renders. Once
 * `shell-login-loaded` fires the user is looking at a real, interactive form
 * and drives the pace themselves, so no timer runs after that (previously a
 * single 45s clock covered typing time too and could fire mid-keystroke).
 */
const CONNECT_TIMEOUT_MS = 20000;

type Phase = "checking" | "welcome" | "connecting" | "authenticating" | "timedOut";

export function resetLoginGate() {
  loginStarted = false;
}

export default function LoginPage() {
  const { t } = useTranslation();
  const session = useAuthStore((s) => s.session);
  const isInitialized = useAuthStore((s) => s.isInitialized);
  const [phase, setPhase] = useState<Phase>("checking");
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCheckTimer = useCallback(() => {
    if (checkTimerRef.current) {
      clearTimeout(checkTimerRef.current);
      checkTimerRef.current = null;
    }
  }, []);

  const clearConnectTimer = useCallback(() => {
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
  }, []);

  const startInteractiveAuth = useCallback(
    (authPath: "login" | "signup") => {
      clearCheckTimer();
      clearConnectTimer();
      setPhase("connecting");
      connectTimerRef.current = setTimeout(() => {
        if (useAuthStore.getState().session) return;
        void closeShellLogin().catch(() => undefined);
        setPhase("timedOut");
      }, CONNECT_TIMEOUT_MS);
      const redirectB64 = btoa(`${DEEP_LINK_SCHEME}://authentication`);
      void openShellLogin(TENDENCYS_BASE_URL, SHELL_SITE_ID, redirectB64, authPath);
    },
    [clearCheckTimer, clearConnectTimer],
  );

  const startAuth = useCallback(async () => {
    setPhase("checking");
    clearCheckTimer();
    checkTimerRef.current = setTimeout(() => {
      if (useAuthStore.getState().session) return;
      // A slow/absent device key is a normal case, not an error — land on Welcome.
      setPhase((prev) => (prev === "checking" ? "welcome" : prev));
    }, CHECK_TIMEOUT_MS);

    const deviceResult = await tryDeviceKeyLogin();
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
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(deviceResult.redirectUrl);
        return;
      } catch {
        // Fall through to Welcome.
      }
    }
    setPhase((prev) => (prev === "timedOut" ? prev : "welcome"));
  }, [clearCheckTimer]);

  const retryLogin = useCallback(async () => {
    clearCheckTimer();
    clearConnectTimer();
    resetLoginGate();
    await closeShellLogin().catch(() => undefined);
    loginStarted = true;
    await startAuth();
  }, [clearCheckTimer, clearConnectTimer, startAuth]);

  useEffect(() => {
    if (session) {
      loginStarted = false;
      clearCheckTimer();
      clearConnectTimer();
      return;
    }
    if (!isInitialized || loginStarted) return;
    loginStarted = true;
    void startAuth();
  }, [isInitialized, session, startAuth, clearCheckTimer, clearConnectTimer]);

  // Real "Accounts form is visible and interactive" signal — stop guessing a
  // fixed duration and let the connecting timeout expire only if the page
  // genuinely never loads (offline, DNS failure, etc.).
  useEffect(() => {
    if (phase !== "connecting") return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listenShellLoginLoaded(() => {
      if (cancelled) return;
      clearConnectTimer();
      setPhase("authenticating");
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [phase, clearConnectTimer]);

  useEffect(() => clearCheckTimer, [clearCheckTimer]);
  useEffect(() => clearConnectTimer, [clearConnectTimer]);

  if (isInitialized && session) {
    return <Navigate to="/" replace />;
  }

  if (phase === "welcome") {
    return (
      <WelcomeScreen
        onSignIn={() => startInteractiveAuth("login")}
        onCreateAccount={() => startInteractiveAuth("signup")}
      />
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
        <Button onClick={() => void retryLogin()}>
          <RotateCw className="mr-2 h-4 w-4" />
          {t("auth.tryAgain")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-primary text-white">
      <aside
        className="flex h-full shrink-0 flex-col items-center gap-2 py-3"
        style={{ width: LOGIN_RAIL_WIDTH }}
        aria-label={t("login.recoveryRail")}
      >
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 text-sm font-bold"
          aria-hidden
        >
          T
        </div>
        <button
          type="button"
          onClick={() => void retryLogin()}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white"
          aria-label={t("auth.tryAgain")}
          title={t("auth.tryAgain")}
        >
          <RotateCw className="h-4 w-4" />
        </button>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-4">
        <Loader2 className="h-10 w-10 animate-spin" />
        <p>{t("login.signingIn")}</p>
      </div>
    </div>
  );
}
