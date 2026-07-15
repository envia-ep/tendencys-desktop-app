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

/**
 * System-browser / OS deep-link handoff only (`tendencys://authentication?authorization=`).
 * In-app shell login uses `shell-auth-token` in App.tsx instead — do not treat this
 * page as the primary auth path.
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
        // If listenShellAuthToken already claimed this token (Strict Mode race or
        // the Rust layer firing both the IPC event and the deep-link), bail out
        // so we don't burn the one-time token with a second validate call.
        if (!claimHandoffToken(authorizationToken)) {
          setIsValidating(false);
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
