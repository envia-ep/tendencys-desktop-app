import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Loader2, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { resetLoginGate } from "@/pages/LoginPage";
import { claimHandoffToken } from "@/lib/auth-handoff";

/** Survive React Strict Mode remounts — one validation per handoff JWT. */
let pendingToken: string | null = null;
let pendingAuth: Promise<boolean> | null = null;

function resetPendingAuth() {
  pendingToken = null;
  pendingAuth = null;
}

/** Wait for App.tsx's shell-auth-token path to finish when we lost the claim race. */
async function waitForSession(ms = 8000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (useAuthStore.getState().session?.token) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Boolean(useAuthStore.getState().session?.token);
}

/**
 * System-browser / OS deep-link handoff backup (`tendencys://authentication?authorization=`).
 * Primary path: Rust emits `shell-auth-token` → App.tsx `listenShellAuthToken`.
 * This page runs when JS `onOpenUrl` navigates here, or when the claim race lost
 * to App and we only need to wait for session.
 */
export default function Authentication() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const validateAndLogin = useAuthStore((s) => s.validateAndLogin);
  const session = useAuthStore((s) => s.session);
  const error = useAuthStore((s) => s.error);

  const [isValidating, setIsValidating] = useState(true);

  useEffect(() => {
    if (session) {
      setIsValidating(false);
      return;
    }

    const authorizationToken =
      searchParams.get("authorization") || pendingToken;

    if (!authorizationToken) {
      setIsValidating(false);
      return;
    }

    let cancelled = false;

    const run = async () => {
      if (!pendingAuth || pendingToken !== authorizationToken) {
        // Rust emit + JS deep-link may both arrive; first claimer validates.
        if (!claimHandoffToken(authorizationToken)) {
          const ok = await waitForSession();
          if (cancelled) return;
          setIsValidating(false);
          if (ok) {
            navigate("/", { replace: true });
          }
          return;
        }
        pendingToken = authorizationToken;
        window.history.replaceState({}, "", window.location.pathname);
        pendingAuth = validateAndLogin(authorizationToken);
      }

      const success = await pendingAuth;

      if (cancelled) return;

      setIsValidating(false);
      if (success) {
        resetPendingAuth();
        navigate("/", { replace: true });
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [searchParams, validateAndLogin, navigate, session]);

  if (session) {
    return <Navigate to="/" replace />;
  }

  if (isValidating) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-primary text-white">
        <Loader2 className="h-10 w-10 animate-spin" />
        <p>{t("auth.validating")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-primary p-8 text-white">
      <AlertCircle className="h-10 w-10 text-red-300" />
      <h1 className="text-xl font-semibold">{t("auth.failedTitle")}</h1>
      <p className="max-w-md text-center text-white/80">
        {error ?? t("auth.failedDescription")}
      </p>
      <Button
        onClick={() => {
          resetPendingAuth();
          resetLoginGate();
          navigate("/login", { replace: true });
        }}
      >
        {t("auth.tryAgain")}
      </Button>
    </div>
  );
}
