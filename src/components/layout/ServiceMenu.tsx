import { useMemo, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Home,
  LogOut,
  Plus,
  RotateCw,
  Settings2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { getVisibleServices, type ServiceDefinition } from "@/config/services";
import { ServiceIcon } from "@/components/ServiceIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { composeMenuServices } from "@/lib/menu-layout";
import { cn } from "@/lib/utils";
import { getMenuWidth } from "@/config/layout";
import { createShellWindow } from "@/lib/native-webviews";
import { useAuthStore } from "@/stores/auth-store";
import { usePreferencesStore } from "@/stores/preferences-store";
import type { ShellView } from "@/stores/service-store";

type ServiceMenuProps = {
  activeService: ServiceDefinition;
  shellView: ShellView;
  collapsed: boolean;
  onSelectService: (service: ServiceDefinition) => void;
  onShowHome: () => void;
  onShowDevelopers: () => void;
  onShowSettings: () => void;
  onToggleCollapsed: () => void;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onRefresh: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Native mode hides the overlaid product webview while this menu is open. */
  onUserMenuOpenChange?: (open: boolean) => void;
};

function accountDisplayName(firstName: string, lastName: string, email: string) {
  return `${firstName} ${lastName}`.trim() || email;
}

function accountInitials(firstName: string, email: string) {
  return (firstName?.[0] ?? email[0] ?? "?").toUpperCase();
}

function SortableServiceButton({
  service,
  collapsed,
  compact,
  isActive,
  onSelect,
}: {
  service: ServiceDefinition;
  collapsed: boolean;
  compact: boolean;
  isActive: boolean;
  onSelect: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: service.id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };
  const rowH = compact ? "h-8" : "h-9";
  const iconBox = compact ? "w-8" : "w-9";

  return (
    <button
      ref={setNodeRef}
      type="button"
      style={style}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 rounded-lg transition-colors touch-none",
        collapsed ? `${rowH} ${iconBox} justify-center` : `${rowH} w-full px-2`,
        isActive
          ? "bg-white text-primary"
          : "text-white/80 hover:bg-white/10 hover:text-white",
        isDragging && "shadow-lg ring-1 ring-white/30",
      )}
      aria-label={service.name}
      aria-current={isActive ? "page" : undefined}
      title={collapsed ? service.name : undefined}
      {...attributes}
      {...listeners}
    >
      <ServiceIcon
        icon={service.icon}
        className={cn("shrink-0", compact ? "h-3.5 w-3.5" : "h-4 w-4")}
      />
      {!collapsed && (
        <span
          className={cn(
            "truncate font-medium",
            compact ? "text-xs" : "text-sm",
          )}
        >
          {service.name}
        </span>
      )}
    </button>
  );
}

/**
 * Full-height left chrome column: nav, services, and user actions.
 * Collapsed = icon-only; expanded = icon + labels. Product webviews sit to the
 * right (top=0), so this column can never be covered by native child webviews.
 */
export function ServiceMenu({
  activeService,
  shellView,
  collapsed,
  onSelectService,
  onShowHome,
  onShowDevelopers,
  onShowSettings,
  onToggleCollapsed,
  onNavigateBack,
  onNavigateForward,
  onRefresh,
  canGoBack,
  canGoForward,
  onUserMenuOpenChange,
}: ServiceMenuProps) {
  const { t } = useTranslation();
  const account = useAuthStore((s) => s.getAccount());
  const accounts = useAuthStore((s) => s.accounts);
  const logout = useAuthStore((s) => s.logout);
  const addAccount = useAuthStore((s) => s.addAccount);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const menuLayout = usePreferencesStore((s) => s.menuLayout);
  const environmentMode = usePreferencesStore((s) => s.environmentMode);
  const uiDensity = usePreferencesStore((s) => s.uiDensity);
  const setMenuOrder = usePreferencesStore((s) => s.setMenuOrder);
  const compact = uiDensity === "compact";
  const railServices = useMemo(
    () => composeMenuServices(getVisibleServices(), menuLayout),
    [menuLayout, environmentMode],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const onHome = shellView === "home";
  const onDevelopers = shellView === "developers";
  const onSettings = shellView === "settings";
  const onService = shellView === "service";
  const width = getMenuWidth(collapsed, uiDensity);
  const rowH = compact ? "h-8" : "h-9";
  const iconBox = compact ? "w-8" : "w-9";

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = railServices.map((service) => service.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    void setMenuOrder(arrayMove(ids, oldIndex, newIndex));
  };

  const displayName = account
    ? accountDisplayName(account.firstName, account.lastName, account.email)
    : "";

  const initials = account
    ? accountInitials(account.firstName, account.email)
    : "?";

  // Exclude active by id and email — store may briefly hold duplicate ids
  // for the same email until loadShellAuth/saveSession heal it.
  const activeEmail = account?.email.trim().toLowerCase() ?? "";
  const otherAccounts = accounts.filter((a) => {
    if (a.account.id === account?.id) return false;
    if (activeEmail && a.account.email.trim().toLowerCase() === activeEmail) {
      return false;
    }
    return true;
  });


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
        "flex items-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40",
        rowH,
        collapsed ? `${iconBox} justify-center` : "w-full gap-2 px-2",
      )}
      aria-label={opts.label}
      title={collapsed ? opts.label : undefined}
    >
      {opts.children}
    </button>
  );

  return (
    <nav
      className={cn(
        "flex h-full shrink-0 flex-col bg-primary transition-[width] duration-150",
        compact ? "py-2" : "py-3",
      )}
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
                  className={cn(
                    "flex items-center justify-center rounded-lg bg-white/15 text-sm font-medium text-white hover:bg-white/25",
                    rowH,
                    iconBox,
                  )}
                  aria-label={t("topBar.userMenu")}
                  title={displayName || t("topBar.userMenu")}
                >
                  {initials}
                </button>
              ) : (
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 text-white/80 hover:bg-white/10 hover:text-white",
                    rowH,
                  )}
                  aria-label={t("topBar.userMenu")}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/15 text-xs font-medium text-white">
                    {initials}
                  </span>
                  <span className="truncate text-sm">{displayName}</span>
                </button>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start" className="w-64">
              {account && (
                <>
                  <DropdownMenuLabel>
                    <div className="flex items-center gap-2.5 py-1">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
                        {initials}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium leading-tight">
                          {displayName}
                        </span>
                        <span className="truncate text-xs font-normal leading-tight text-muted-foreground">
                          {account.email}
                        </span>
                      </div>
                      <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                    </div>
                  </DropdownMenuLabel>

                  {otherAccounts.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                        {t("topBar.signedInAccounts")}
                      </DropdownMenuLabel>
                      {otherAccounts.map((slot) => {
                        const name = accountDisplayName(
                          slot.account.firstName,
                          slot.account.lastName,
                          slot.account.email,
                        );
                        const slotInitials = accountInitials(
                          slot.account.firstName,
                          slot.account.email,
                        );
                        return (
                          <DropdownMenuItem
                            key={slot.account.id}
                            onClick={() => void switchAccount(slot.account.id)}
                            className="gap-2"
                            aria-label={t("topBar.switchAccount", {
                              email: slot.account.email,
                            })}
                          >
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                              {slotInitials}
                            </span>
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate text-sm leading-tight">
                                {name}
                              </span>
                              <span className="truncate text-xs text-muted-foreground leading-tight">
                                {slot.account.email}
                              </span>
                            </div>
                          </DropdownMenuItem>
                        );
                      })}
                    </>
                  )}

                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => void createShellWindow().catch(() => undefined)}
                    className="gap-2"
                  >
                    <AppWindow className="h-4 w-4" />
                    {t("topBar.newWindow")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void addAccount()}
                    className="gap-2"
                  >
                    <Plus className="h-4 w-4" />
                    {t("topBar.addAccount")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void logout()}
                    className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                  >
                    <LogOut className="h-4 w-4" />
                    {t("topBar.signOut")}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {onHome
                  ? t("home.menuLabel")
                  : onDevelopers
                    ? t("developers.menuLabel")
                    : onSettings
                      ? t("settings.menuLabel")
                      : activeService.name}
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
            disabled={!onService || !canGoBack}
            className={cn(
              "flex items-center justify-center rounded-lg text-white/80 transition-colors enabled:hover:bg-white/10 enabled:hover:text-white enabled:active:bg-white/20 disabled:opacity-40",
              rowH,
              iconBox,
            )}
            aria-label={t("topBar.back")}
            title={t("topBar.back")}
          >
            <ArrowLeft className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
          </button>
          <button
            type="button"
            onClick={onNavigateForward}
            disabled={!onService || !canGoForward}
            className={cn(
              "flex items-center justify-center rounded-lg text-white/80 transition-colors enabled:hover:bg-white/10 enabled:hover:text-white enabled:active:bg-white/20 disabled:opacity-40",
              rowH,
              iconBox,
            )}
            aria-label={t("topBar.forward")}
            title={t("topBar.forward")}
          >
            <ArrowRight className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={!onService}
            className={cn(
              "flex items-center justify-center rounded-lg text-white/80 transition-colors enabled:hover:bg-white/10 enabled:hover:text-white enabled:active:bg-white/20 disabled:opacity-40",
              rowH,
              iconBox,
            )}
            aria-label={t("topBar.refresh")}
            title={t("topBar.refresh")}
          >
            <RotateCw className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-2">
          <button
            type="button"
            onClick={onShowHome}
            className={cn(
              "flex items-center gap-2 rounded-lg transition-colors",
              collapsed ? `${rowH} ${iconBox} justify-center` : `${rowH} w-full px-2`,
              onHome
                ? "bg-white text-primary"
                : "text-white/80 hover:bg-white/10 hover:text-white",
            )}
            aria-label={t("home.menuLabel")}
            aria-current={onHome ? "page" : undefined}
            title={collapsed ? t("home.menuLabel") : undefined}
          >
            <Home className={cn("shrink-0", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
            {!collapsed && (
              <span
                className={cn(
                  "truncate font-medium",
                  compact ? "text-xs" : "text-sm",
                )}
              >
                {t("home.menuLabel")}
              </span>
            )}
          </button>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={railServices.map((service) => service.id)}
              strategy={verticalListSortingStrategy}
            >
              {railServices.map((service) => (
                <SortableServiceButton
                  key={service.id}
                  service={service}
                  collapsed={collapsed}
                  compact={compact}
                  isActive={onService && service.id === activeService.id}
                  onSelect={() => onSelectService(service)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        <div className="mt-2 flex flex-col gap-1 px-2">
          <button
            type="button"
            onClick={onShowDevelopers}
            className={cn(
              "flex items-center gap-2 rounded-lg transition-colors",
              collapsed ? `${rowH} ${iconBox} justify-center` : `${rowH} w-full px-2`,
              onDevelopers
                ? "bg-white text-primary"
                : "text-white/80 hover:bg-white/10 hover:text-white",
            )}
            aria-label={t("developers.menuLabel")}
            aria-current={onDevelopers ? "page" : undefined}
            title={collapsed ? t("developers.menuLabel") : undefined}
          >
            <Code2 className={cn("shrink-0", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
            {!collapsed && (
              <span
                className={cn(
                  "truncate font-medium",
                  compact ? "text-xs" : "text-sm",
                )}
              >
                {t("developers.menuLabel")}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={onShowSettings}
            className={cn(
              "flex items-center gap-2 rounded-lg transition-colors",
              collapsed ? `${rowH} ${iconBox} justify-center` : `${rowH} w-full px-2`,
              onSettings
                ? "bg-white text-primary"
                : "text-white/80 hover:bg-white/10 hover:text-white",
            )}
            aria-label={t("settings.menuLabel")}
            aria-current={onSettings ? "page" : undefined}
            title={collapsed ? t("settings.menuLabel") : undefined}
          >
            <Settings2 className={cn("shrink-0", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
            {!collapsed && (
              <span
                className={cn(
                  "truncate font-medium",
                  compact ? "text-xs" : "text-sm",
                )}
              >
                {t("settings.menuLabel")}
              </span>
            )}
          </button>

          {iconBtn({
            label: t("topBar.newWindow"),
            onClick: () => void createShellWindow().catch(() => undefined),
            children: (
              <>
                <AppWindow className="h-4 w-4 shrink-0" />
                {!collapsed && (
                  <span className="truncate text-sm">
                    {t("topBar.newWindow")}
                  </span>
                )}
              </>
            ),
          })}

          <button
            type="button"
            onClick={onToggleCollapsed}
            className={cn(
              "flex items-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white",
              rowH,
              collapsed ? `${iconBox} justify-center` : "w-full gap-2 px-2",
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
