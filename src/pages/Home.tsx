import { Navigate } from "react-router-dom";
import { useAuthStore } from "@/stores/auth-store";
import { AppShell } from "@/components/layout/AppShell";

export default function Home() {
  const session = useAuthStore((s) => s.session);
  const isInitialized = useAuthStore((s) => s.isInitialized);

  if (!isInitialized) {
    return null;
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return <AppShell />;
}
