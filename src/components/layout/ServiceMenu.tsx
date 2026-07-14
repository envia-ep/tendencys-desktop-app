import type { ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  LogOut,
  RotateCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { SERVICES, type ServiceDefinition } from "@/config/services";
import { ServiceIcon } from "@/components/ServiceIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import { MENU_COLLAPSED_WIDTH, MENU_EXPANDED_WIDTH } from "@/config/layout";

type ServiceMenuProps = {
  activeService: ServiceDefinition;
  collapsed: boolean;
  onSelectService: (service: ServiceDefinition) => void;
  onToggleCollapsed: () => void;
  onOpenInBrowser: () => void;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onRefresh: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Native mode hides the overlaid product webview while this menu is open. */
  onUserMenuOpenChange?: (open: boolean) => void;
};

/**
 * Full-height left chrome column: nav, services, and user actions.
 * Collapsed = icon-only; expanded = icon + labels. Product webviews sit to the
 * right (top=0), so this column can never be covered by native child webviews.
 */
export function ServiceMenu({
  activeService,
  collapsed,
  onSelectService,
  onToggleCollapsed,
  onOpenInBrowser,
  onNavigateBack,
  onNavigateForward,
  onRefresh,
  canGoBack,
  canGoForward,
  onUserMenuOpenChange,
}: ServiceMenuProps) {
  const { t } = useTranslation();
  const account = useAuthStore((s) => s.getAccount());
  const logout = useAuthStore((s) => s.logout);
  const width = collapsed ? MENU_COLLAPSED_WIDTH : MENU_EXPANDED_WIDTH;

  const displayName = account
    ? `${account.firstName} ${account.lastName}`.trim() || account.email
    : "";

  const initials = account
    ? (account.firstName?.[0] ?? account.email[0]).toUpperCase()
    : "?";

  // Native product webviews overlay everything right of this rail, so a DOM
  // tooltip (side="right") would render underneath them and stay invisible.
  // Use the OS-native `title` tooltip when collapsed — it draws above the
  // native child webviews.
  const iconBtn = (opts: {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <button
      type="button"
      onClick={opts.onClick}
      disabled={opts.disabled}
      className={cn(
        "flex h-9 items-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40",
        collapsed ? "w-9 justify-center" : "w-full gap-2 px-2",
      )}
      aria-label={opts.label}
      title={collapsed ? opts.label : undefined}
    >
      {opts.children}
    </button>
  );

  return (
    <nav
      className="flex h-full shrink-0 flex-col bg-primary py-3 transition-[width] duration-150"
      style={{ width }}
      aria-label={t("serviceRail.label")}
    >
        <div className="mb-2 px-2">
          <DropdownMenu
            onOpenChange={collapsed ? onUserMenuOpenChange : undefined}
          >
            <DropdownMenuTrigger asChild>
              {collapsed ? (
                <button
                  type="button"
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 text-sm font-medium text-white hover:bg-white/25"
                  aria-label={t("topBar.userMenu")}
                  title={displayName || t("topBar.userMenu")}
                >
                  {initials}
                </button>
              ) : (
                <button
                  type="button"
                  className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-white/80 hover:bg-white/10 hover:text-white"
                  aria-label={t("topBar.userMenu")}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/15 text-xs font-medium text-white">
                    {initials}
                  </span>
                  <span className="truncate text-sm">{displayName}</span>
                </button>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start" className="w-52">
              {account && (
                <>
                  <DropdownMenuLabel>
                    <div className="flex items-center gap-2.5 py-1">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
                        {initials}
                      </span>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium leading-tight">
                          {displayName}
                        </span>
                        <span className="truncate text-xs font-normal leading-tight text-muted-foreground">
                          {account.email}
                        </span>
                      </div>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => logout()}
                    className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                  >
                    <LogOut className="h-4 w-4" />
                    {t("topBar.signOut")}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {activeService.name}
              </DropdownMenuLabel>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          className={cn(
            "mb-2 flex gap-1 px-2",
            collapsed ? "flex-col" : "flex-row justify-center",
          )}
        >
          <button
            type="button"
            onClick={onNavigateBack}
            disabled={!canGoBack}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition-colors enabled:hover:bg-white/10 enabled:hover:text-white enabled:active:bg-white/20 disabled:opacity-40"
            aria-label={t("topBar.back")}
            title={t("topBar.back")}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onNavigateForward}
            disabled={!canGoForward}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition-colors enabled:hover:bg-white/10 enabled:hover:text-white enabled:active:bg-white/20 disabled:opacity-40"
            aria-label={t("topBar.forward")}
            title={t("topBar.forward")}
          >
            <ArrowRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white active:bg-white/20"
            aria-label={t("topBar.refresh")}
            title={t("topBar.refresh")}
          >
            <RotateCw className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-2">
          {SERVICES.map((service) => {
            const isActive = service.id === activeService.id;
            return (
              <button
                key={service.id}
                type="button"
                onClick={() => onSelectService(service)}
                className={cn(
                  "flex items-center gap-2 rounded-lg transition-colors",
                  collapsed ? "h-9 w-9 justify-center" : "h-9 w-full px-2",
                  isActive
                    ? "bg-white text-primary"
                    : "text-white/80 hover:bg-white/10 hover:text-white",
                )}
                aria-label={service.name}
                aria-current={isActive ? "page" : undefined}
                title={collapsed ? service.name : undefined}
              >
                <ServiceIcon icon={service.icon} className="h-4 w-4 shrink-0" />
                {!collapsed && (
                  <span className="truncate text-sm font-medium">
                    {service.name}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-2 flex flex-col gap-1 px-2">
          {iconBtn({
            label: t("topBar.openInBrowser"),
            onClick: onOpenInBrowser,
            children: (
              <>
                <ExternalLink className="h-4 w-4 shrink-0" />
                {!collapsed && (
                  <span className="truncate text-sm">
                    {t("topBar.openInBrowser")}
                  </span>
                )}
              </>
            ),
          })}

          <button
            type="button"
            onClick={onToggleCollapsed}
            className={cn(
              "flex h-9 items-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white",
              collapsed ? "w-9 justify-center" : "w-full gap-2 px-2",
            )}
            aria-label={
              collapsed ? t("serviceRail.expand") : t("serviceRail.collapse")
            }
            title={collapsed ? t("serviceRail.expand") : undefined}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
            {!collapsed && (
              <span className="truncate text-sm">
                {t("serviceRail.collapse")}
              </span>
            )}
          </button>
        </div>
    </nav>
  );
}
