import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { isTauri } from "@/lib/tauri";
import { DEEP_LINK_SCHEME } from "@/lib/tendencys-auth";

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

export function useTauriDeepLink() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;

    const handleUrls = (urls: string[]) => {
      for (const raw of urls) {
        const authorization = extractAuthorization(raw);
        if (!authorization) {
          console.warn("[TauriDeepLink] No authorization in:", raw);
          continue;
        }

        const search = new URLSearchParams();
        search.set("authorization", authorization);
        navigate(`/authentication?${search.toString()}`);
        return;
      }
    };

    const setup = async () => {
      const { getCurrent, onOpenUrl } = await import(
        "@tauri-apps/plugin-deep-link"
      );

      // Cold start: app launched by tendencys://… (getCurrent), not only onOpenUrl.
      try {
        const startUrls = await getCurrent();
        if (startUrls?.length) {
          handleUrls(startUrls);
        }
      } catch (err) {
        console.error("[TauriDeepLink] getCurrent failed:", err);
      }

      unlisten = await onOpenUrl((urls) => {
        handleUrls(urls);
      });
    };

    void setup();

    return () => {
      unlisten?.();
    };
  }, [navigate]);
}
