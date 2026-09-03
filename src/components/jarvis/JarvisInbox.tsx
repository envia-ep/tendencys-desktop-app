import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createJarvisTask,
  listJarvisInbox,
  patchJarvisTask,
  listJarvisObjectives,
  listJarvisPrincipals,
  listJarvisTaskEvents,
  retryJarvisTask,
  startJarvisTask,
  type JarvisInboxItem,
  type JarvisObjective,
  type JarvisPrincipal,
  type JarvisTaskEvent,
  type JarvisTaskPriority,
  type JarvisTaskStatus,
} from "@/lib/jarvis-api";

type JarvisInboxProps = {
  token: string;
  onClose: () => void;
};

const OPEN_SECTIONS: Array<{ key: "assigned" | "inProgress" | "blocked"; status: JarvisTaskStatus }> =
  [
    { key: "assigned", status: "assigned" },
    { key: "inProgress", status: "in_progress" },
    { key: "blocked", status: "blocked" },
  ];

function isTerminalRun(status: string | undefined): boolean {
  return status === "completed" || status === "failed";
}

export function JarvisInbox({ token, onClose }: JarvisInboxProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<JarvisInboxItem[]>([]);
  const [objectives, setObjectives] = useState<JarvisObjective[]>([]);
  const [principals, setPrincipals] = useState<JarvisPrincipal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<JarvisTaskEvent[]>([]);
  const [name, setName] = useState("");
  const [objectiveId, setObjectiveId] = useState("");
  const [assigneePrincipalId, setAssigneePrincipalId] = useState("");
  const [priority, setPriority] = useState<JarvisTaskPriority>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const [inbox, objectiveList, principalList] = await Promise.all([
      listJarvisInbox(token),
      listJarvisObjectives(token),
      listJarvisPrincipals(token),
    ]);
    setItems(inbox.items);
    setObjectives(objectiveList.items);
    setPrincipals(principalList.items);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await reload();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("jarvis.inbox.loadFailed"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  useEffect(() => {
    if (!selectedId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    void listJarvisTaskEvents(token, selectedId)
      .then((list) => {
        if (!cancelled) {
          setEvents(list.items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEvents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, token]);

  const grouped = useMemo(() => {
    return {
      assigned: items.filter((row) => row.task.status === "assigned"),
      inProgress: items.filter((row) => row.task.status === "in_progress"),
      blocked: items.filter((row) => row.task.status === "blocked"),
      completed: items.filter((row) => row.task.status === "completed"),
    };
  }, [items]);

  const act = async (fn: () => Promise<unknown>, failedKey: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t(failedKey));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="absolute inset-y-0 right-0 z-20 w-96 overflow-y-auto border-l border-white/10 bg-[#0b1220] p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t("jarvis.inbox.title")}</h2>
          <p className="text-[11px] text-white/45">{t("jarvis.inbox.subtitle")}</p>
        </div>
        <button
          type="button"
          className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
          onClick={onClose}
        >
          {t("jarvis.studio.close")}
        </button>
      </div>

      <form
        className="mt-4 space-y-2 rounded-xl border border-white/10 bg-black/20 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) {
            return;
          }
          void act(async () => {
            await createJarvisTask(token, {
              name: name.trim(),
              objectiveId: objectiveId || null,
              assigneePrincipalId: assigneePrincipalId || null,
              priority,
            });
            setName("");
          }, "jarvis.inbox.createFailed");
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("jarvis.inbox.namePlaceholder")}
          className="h-8 w-full rounded-md border border-white/15 bg-black/40 px-2 text-xs outline-none"
        />
        <div className="grid grid-cols-2 gap-2">
          <select
            value={objectiveId}
            onChange={(event) => setObjectiveId(event.target.value)}
            className="h-8 rounded-md border border-white/15 bg-black/40 px-2 text-xs"
          >
            <option value="">{t("jarvis.inbox.objectiveNone")}</option>
            {objectives.map((objective) => (
              <option key={objective.id} value={objective.id}>
                {objective.name}
              </option>
            ))}
          </select>
          <select
            value={assigneePrincipalId}
            onChange={(event) => setAssigneePrincipalId(event.target.value)}
            className="h-8 rounded-md border border-white/15 bg-black/40 px-2 text-xs"
          >
            <option value="">{t("jarvis.inbox.unassigned")}</option>
            {principals.map((principal) => (
              <option key={principal.id} value={principal.id}>
                {principal.handle ? `@${principal.handle}` : principal.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as JarvisTaskPriority)}
            className="h-8 flex-1 rounded-md border border-white/15 bg-black/40 px-2 text-xs"
          >
            {(["low", "normal", "high", "urgent"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`jarvis.inbox.priority${value[0].toUpperCase()}${value.slice(1)}`)}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="h-8 rounded-md bg-[var(--color-primary-glow)] px-3 text-xs font-medium disabled:opacity-40"
          >
            {t("jarvis.inbox.create")}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-xs text-red-300">{error}</p>}

      {OPEN_SECTIONS.map((section) => (
        <InboxSection
          key={section.key}
          title={t(`jarvis.inbox.${section.key}`)}
          empty={t("jarvis.inbox.empty")}
          items={grouped[section.key]}
          selectedId={selectedId}
          onSelect={setSelectedId}
          busy={busy}
          onStart={(taskId) =>
            void act(() => startJarvisTask(token, taskId), "jarvis.inbox.actionFailed")
          }
          onRetry={(taskId) =>
            void act(() => retryJarvisTask(token, taskId), "jarvis.inbox.actionFailed")
          }
        />
      ))}
      <InboxSection
        title={t("jarvis.inbox.completed")}
        empty={t("jarvis.inbox.empty")}
        items={grouped.completed}
        selectedId={selectedId}
        onSelect={setSelectedId}
        busy={busy}
      />

      {selectedId && (
        <div className="mt-4">
          <div className="mb-3 flex gap-2">
            <select
              value={assigneePrincipalId}
              onChange={(event) => setAssigneePrincipalId(event.target.value)}
              className="h-8 flex-1 rounded-md border border-white/15 bg-black/40 px-2 text-xs"
            >
              <option value="">{t("jarvis.inbox.unassigned")}</option>
              {principals.map((principal) => (
                <option key={principal.id} value={principal.id}>
                  {principal.handle ? `@${principal.handle}` : principal.displayName}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              className="h-8 rounded-md border border-white/15 px-3 text-xs disabled:opacity-40"
              onClick={() =>
                void act(
                  () =>
                    patchJarvisTask(token, selectedId, {
                      assigneePrincipalId: assigneePrincipalId || null,
                    }),
                  "jarvis.inbox.actionFailed",
                )
              }
            >
              {t("jarvis.inbox.reassign")}
            </button>
          </div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
            {t("jarvis.inbox.history")}
          </h3>
          {events.length === 0 && (
            <p className="mt-2 text-xs text-white/40">{t("jarvis.inbox.historyEmpty")}</p>
          )}
          <ul className="mt-2 space-y-1 text-xs text-white/60">
            {events.map((event) => (
              <li key={event.id}>
                {event.type}
                {event.toStatus ? ` → ${event.toStatus}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

function InboxSection({
  title,
  empty,
  items,
  selectedId,
  onSelect,
  busy,
  onStart,
  onRetry,
}: {
  title: string;
  empty: string;
  items: JarvisInboxItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  busy: boolean;
  onStart?: (taskId: string) => void;
  onRetry?: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="mt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-white/40">{title}</h3>
      {items.length === 0 && <p className="mt-2 text-xs text-white/35">{empty}</p>}
      <ul className="mt-2 space-y-2">
        {items.map((row) => {
          const canStart = !row.activeRun && (row.task.status === "assigned" || row.task.status === "in_progress");
          const canRetry = !row.activeRun && isTerminalRun(row.lastRun?.status);
          return (
            <li key={row.task.id}>
              <button
                type="button"
                onClick={() => onSelect(row.task.id)}
                className={`w-full rounded-lg border p-3 text-left ${
                  selectedId === row.task.id
                    ? "border-[var(--color-primary-glow)]/50 bg-white/10"
                    : "border-white/10 bg-black/20"
                }`}
              >
                <p className="text-sm text-white/90">{row.task.name}</p>
                <p className="mt-1 text-[10px] uppercase tracking-wide text-white/40">
                  {t("jarvis.inbox.status")} {row.task.status.replace("_", " ")}
                  {" · "}
                  {row.activeRun
                    ? `${t("jarvis.inbox.runStatus")} ${row.activeRun.status.replace(/_/g, " ")}`
                    : t("jarvis.inbox.noRun")}
                </p>
                {row.assignee && (
                  <p className="mt-1 text-[11px] text-white/50">
                    {row.assignee.handle ? `@${row.assignee.handle}` : row.assignee.displayName}
                  </p>
                )}
              </button>
              {(canStart || canRetry) && (
                <div className="mt-1 flex gap-2">
                  {canStart && onStart && (
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-md border border-white/15 px-2 py-1 text-[11px] text-white/80 disabled:opacity-40"
                      onClick={() => onStart(row.task.id)}
                    >
                      {t("jarvis.inbox.start")}
                    </button>
                  )}
                  {canRetry && onRetry && (
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-md border border-white/15 px-2 py-1 text-[11px] text-white/80 disabled:opacity-40"
                      onClick={() => onRetry(row.task.id)}
                    >
                      {t("jarvis.inbox.retry")}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
