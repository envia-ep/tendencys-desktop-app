import { BookOpen, ExternalLink, KeyRound, LayoutDashboard } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DEVELOPER_SURFACES,
  type DeveloperSurface,
} from "@/config/developers";
import { getServiceById, type ServiceDefinition } from "@/config/services";
import { ServiceIcon } from "@/components/ServiceIcon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type DevelopersHubProps = {
  onOpenServicePath: (service: ServiceDefinition, path: string) => void;
  onOpenDocs: (url: string) => void;
};

export function DevelopersHub({
  onOpenServicePath,
  onOpenDocs,
}: DevelopersHubProps) {
  const { t } = useTranslation();

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="hero-aurora opacity-40" />
        <div className="hero-grid opacity-15" />
      </div>

      <div className="relative z-10 flex flex-1 flex-col overflow-y-auto px-6 py-8 sm:px-10">
        <header className="mb-8 max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t("developers.title")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("developers.subtitle")}
          </p>
        </header>

        <ul className="grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 xl:grid-cols-3">
          {DEVELOPER_SURFACES.map((surface) => (
            <li key={surface.id}>
              <DeveloperCard
                surface={surface}
                onOpenServicePath={onOpenServicePath}
                onOpenDocs={onOpenDocs}
              />
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

function DeveloperCard({
  surface,
  onOpenServicePath,
  onOpenDocs,
}: {
  surface: DeveloperSurface;
  onOpenServicePath: (service: ServiceDefinition, path: string) => void;
  onOpenDocs: (url: string) => void;
}) {
  const { t } = useTranslation();
  const service = surface.serviceId
    ? getServiceById(surface.serviceId)
    : undefined;
  const hasDocs = Boolean(surface.docsUrl);
  const hasAction = Boolean(service && surface.actionPath);
  const showComingSoon =
    surface.status === "coming_soon" && !hasAction;

  const handleAction = () => {
    if (!service || !surface.actionPath) return;
    onOpenServicePath(service, surface.actionPath);
  };

  const actionLabel =
    surface.actionKind === "manage_keys"
      ? t("developers.manageKeys")
      : t("developers.openDashboard");

  const ActionIcon =
    surface.actionKind === "manage_keys" ? KeyRound : LayoutDashboard;

  return (
    <article
      className={cn(
        "flex h-full flex-col rounded-xl border border-border/80 bg-card/90 p-5 shadow-sm backdrop-blur-sm",
        showComingSoon && "opacity-80",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white"
          style={{ backgroundColor: surface.accentColor }}
        >
          <ServiceIcon icon={surface.icon} className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {t(`developers.surfaces.${surface.id}.name`)}
            </h2>
            {showComingSoon && (
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("developers.comingSoon")}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t(`developers.surfaces.${surface.id}.blurb`)}
          </p>
        </div>
      </div>

      {(hasDocs || hasAction) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {hasDocs && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenDocs(surface.docsUrl!)}
            >
              <BookOpen className="mr-1.5 h-3.5 w-3.5" />
              {t("developers.documentation")}
              <ExternalLink className="ml-1.5 h-3 w-3 opacity-60" />
            </Button>
          )}
          {hasAction && (
            <Button type="button" size="sm" onClick={handleAction}>
              <ActionIcon className="mr-1.5 h-3.5 w-3.5" />
              {actionLabel}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
