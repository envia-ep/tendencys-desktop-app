import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  closeProductTab,
  focusProductTab,
  type ProductTab,
} from "@/lib/native-webviews";

type ProductTabStripProps = {
  serviceName: string;
  tabs: ProductTab[];
  activeTabId: string | null;
  collapsed: boolean;
  compact: boolean;
};

/**
 * In-app tab switcher in the left chrome (native product webviews cover the
 * content area, so this cannot sit above the webview).
 */
export function ProductTabStrip({
  serviceName,
  tabs,
  activeTabId,
  collapsed,
  compact,
}: ProductTabStripProps) {
  const { t } = useTranslation();
  if (tabs.length === 0) {
    return null;
  }

  const rowH = compact ? "h-8" : "h-9";
  const primaryActive = activeTabId == null;

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1 border-t border-white/10 pt-2",
        collapsed ? "items-center" : "w-full",
      )}
      role="tablist"
      aria-label={t("tabs.label")}
    >
      <button
        type="button"
        role="tab"
        aria-selected={primaryActive}
        onClick={() => void focusProductTab(null).catch(() => undefined)}
        className={cn(
          "flex items-center rounded-lg transition-colors",
          rowH,
          collapsed ? "w-9 justify-center px-0" : "w-full gap-2 px-2",
          primaryActive
            ? "bg-white text-primary"
            : "text-white/80 hover:bg-white/10 hover:text-white",
        )}
        title={serviceName}
      >
        <span
          className={cn(
            "truncate font-medium",
            compact ? "text-xs" : "text-sm",
            collapsed && "sr-only",
          )}
        >
          {serviceName}
        </span>
        {collapsed && (
          <span className="text-xs font-semibold" aria-hidden>
            {serviceName.slice(0, 1)}
          </span>
        )}
      </button>

      {tabs.map((tab) => {
        const selected = activeTabId === tab.id;
        const title = tab.title || t("tabs.untitled");
        return (
          <div
            key={tab.id}
            className={cn(
              "flex items-center gap-0.5",
              collapsed ? "w-9 justify-center" : "w-full",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => void focusProductTab(tab.id).catch(() => undefined)}
              className={cn(
                "flex min-w-0 items-center rounded-lg transition-colors",
                rowH,
                collapsed ? "w-9 justify-center px-0" : "flex-1 gap-2 px-2",
                selected
                  ? "bg-white text-primary"
                  : "text-white/80 hover:bg-white/10 hover:text-white",
              )}
              title={title}
            >
              <span
                className={cn(
                  "truncate font-medium",
                  compact ? "text-xs" : "text-sm",
                  collapsed && "sr-only",
                )}
              >
                {title}
              </span>
              {collapsed && (
                <span className="text-xs font-semibold" aria-hidden>
                  {title.slice(0, 1)}
                </span>
              )}
            </button>
            {!collapsed && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeProductTab(tab.id).catch(() => undefined);
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/50 hover:bg-white/10 hover:text-white"
                aria-label={t("tabs.close", { title })}
                title={t("tabs.close", { title })}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
