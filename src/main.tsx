import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "./index.css";
import App from "./App";
import { initSentry, setSentryUser } from "./lib/sentry";
import { useAuthStore } from "./stores/auth-store";

// Must run before render so unhandled errors + promise rejections are captured.
initSentry();

// Keep Sentry identity in sync with the active Accounts session for triage.
useAuthStore.subscribe((state) => {
  const account = state.session?.account;
  setSentryUser(account ? { id: account.id, email: account.email } : null);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
