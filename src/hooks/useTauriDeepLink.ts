import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { isTauri } from "@/lib/tauri";
import { DEEP_LINK_SCHEME } from "@/lib/tendencys-auth";
import {
  extractOpenTarget,
  setPendingOpenTarget,
} from "@/lib/pending-open-target";

function extractAuthorization(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
    const path = url.host || url.pathname.replace(/^\//, "");
    if (path !== "authentication") return null;
    return url.searchParams.get("authorization");
  } catch {
    if (!raw.startsWith(`${DEEP_LINK_SCHEME}://`)) return null;
    const match = raw.match(/[?&]authorization=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

/**
 * Backup deep-link path for auth + open targets (products / shell sections).
 * Primary path is Rust `emit_deep_link` → `shell-auth-token` / `shell-open`.
 */
export function useTauriDeepLink() {
  const navigate = useNavigate();
  // `navigate` from a plain <BrowserRouter> is re-created on every pathname
  // change (react-router's useNavigateUnstable memoizes on locationPathname).
  // A ref keeps this effect's deps free of that churn so setup() — which
  // itself navigates and calls the sticky Tauri getCurrent() — cannot
  // re-trigger itself in a loop.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const handleUrls = (urls: string[]) => {
      for (const raw of urls) {
        const authorization = extractAuthorization(raw);
        if (authorization) {
          const search = new URLSearchParams();
          search.set("authorization", authorization);
          navigateRef.current(`/authentication?${search.toString()}`, {
            replace: true,
          });
          return;
        }

        const target = extractOpenTarget(raw, DEEP_LINK_SCHEME);
        if (target) {
          // useProductSso consumes this once authenticated / on event.
          setPendingOpenTarget(target);
          return;
        }
      }
    };

    const setup = async () => {
      const { getCurrent, onOpenUrl } = await import(
        "@tauri-apps/plugin-deep-link"
      );

      // Cold start: app launched by tendencys://… (getCurrent), not only onOpenUrl.
      try {
        const startUrls = await getCurrent();
        if (!cancelled && startUrls?.length) {
          handleUrls(startUrls);
        }
      } catch (err) {
        console.error("[TauriDeepLink] getCurrent failed:", err);
      }

      if (cancelled) return;
      unlisten = await onOpenUrl((urls) => {
        handleUrls(urls);
      });
    };

    void setup();

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // Intentionally run once for the app's lifetime — see navigateRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
