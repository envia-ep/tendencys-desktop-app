import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { UpdateBanner } from "@/components/UpdateBanner";
import { useAuthStore } from "@/stores/auth-store";
import { useTauriDeepLink } from "@/hooks/useTauriDeepLink";
import { listenShellAuthToken } from "@/lib/native-webviews";
import { diagnoseAccountsSession } from "@/lib/sso-log";
import Home from "@/pages/Home";
import LoginPage from "@/pages/LoginPage";
import Authentication from "@/pages/Authentication";

function AppRoutes() {
  useTauriDeepLink();
  const navigate = useNavigate();
  const initialize = useAuthStore((s) => s.initialize);
  const isInitialized = useAuthStore((s) => s.isInitialized);

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Dev-only console helper: `window.__ssoDiagnose()` prints the live jar `_atid`
  // claim shape + expiry (never the token value) to confirm silent-SSO health.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__ssoDiagnose =
      diagnoseAccountsSession;
  }, []);

  // Native in-app login delivers the handoff JWT via an event, not the deep link.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let handled = false;
    void listenShellAuthToken(async ({ token, atid }) => {
      if (handled) return;
      handled = true;
      const ok = await useAuthStore.getState().validateAndLogin(token, atid);
      if (ok) {
        navigate("/", { replace: true });
      } else {
        handled = false;
        navigate("/authentication", { replace: true });
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [navigate]);

  if (!isInitialized) {
    return (
      <div className="flex h-screen items-center justify-center bg-primary text-white">
        Loading...
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/authentication" element={<Authentication />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <TooltipProvider>
      <BrowserRouter>
        <ErrorBoundary>
          <div className="flex h-screen flex-col overflow-hidden">
            <UpdateBanner />
            <div className="min-h-0 flex-1">
              <AppRoutes />
            </div>
          </div>
        </ErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  );
}
