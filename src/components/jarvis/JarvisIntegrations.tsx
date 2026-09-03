import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addJarvisDraftSource,
  answerJarvisDraft,
  approveJarvisDraft,
  completeJarvisConnect,
  createJarvisDraft,
  deleteJarvisIntegration,
  getJarvisDraft,
  listJarvisDrafts,
  listJarvisIntegrations,
  patchJarvisIntegration,
  proposeJarvisDraft,
  recommendJarvisConnection,
  startJarvisConnect,
  startJarvisOauth,
  validateJarvisDraft,
  type JarvisConnectorHealthState,
  type JarvisEngineerSourceType,
  type JarvisIntegrationDraft,
  type JarvisIntegrationRecipe,
  type JarvisIntegrationValidation,
  type JarvisIntegrations as JarvisIntegrationsData,
  type JarvisRecipeField,
  type JarvisStudioConnector,
} from "@/lib/jarvis-api";
import { cn } from "@/lib/utils";

type JarvisIntegrationsProps = {
  token: string;
  onClose: () => void;
  onChanged?: () => void;
};

const SOURCE_TYPES: JarvisEngineerSourceType[] = [
  "openapi",
  "mcp",
  "documentation_url",
  "uploaded_documentation",
  "postman",
  "curl",
  "manual",
];

/** Source types where the user supplies a URL/reference rather than pasted content. */
const REF_SOURCES = new Set<JarvisEngineerSourceType>(["mcp", "documentation_url"]);

const HEALTH_TONE: Record<JarvisConnectorHealthState, string> = {
  READY: "bg-emerald-400/15 text-emerald-200 border-emerald-400/30",
  DEGRADED: "bg-amber-400/15 text-amber-200 border-amber-400/30",
  AUTH_EXPIRED: "bg-red-400/15 text-red-200 border-red-400/30",
  UNREACHABLE: "bg-red-400/15 text-red-200 border-red-400/30",
  SCHEMA_CHANGED: "bg-amber-400/15 text-amber-200 border-amber-400/30",
  DISABLED: "bg-white/10 text-white/50 border-white/15",
  REVOKED: "bg-red-400/15 text-red-200 border-red-400/30",
};

function healthOf(state: JarvisConnectorHealthState | undefined): JarvisConnectorHealthState {
  return state ?? "READY";
}

function ConnectorActions({
  connectorId,
  pendingRemoveId,
  busy,
  editLabel,
  removeLabel,
  confirmLabel,
  cancelLabel,
  onEdit,
  onAskRemove,
  onConfirmRemove,
  onCancelRemove,
}: {
  connectorId: string;
  pendingRemoveId: string | null;
  busy: boolean;
  editLabel: string;
  removeLabel: string;
  confirmLabel: string;
  cancelLabel: string;
  onEdit: () => void;
  onAskRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
}) {
  if (pendingRemoveId === connectorId) {
    return (
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy}
          className="rounded-md bg-red-400/90 px-2 py-1 text-[10px] uppercase tracking-wide text-black disabled:opacity-40"
          onClick={onConfirmRemove}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          className="rounded-md border border-white/20 px-2 py-1 text-[10px] uppercase tracking-wide text-white/70 disabled:opacity-40"
          onClick={onCancelRemove}
        >
          {cancelLabel}
        </button>
      </div>
    );
  }
  return (
    <div className="mt-2 flex gap-2">
      <button
        type="button"
        disabled={busy}
        className="rounded-md border border-white/20 px-2 py-1 text-[10px] uppercase tracking-wide text-white/70 disabled:opacity-40"
        onClick={onEdit}
      >
        {editLabel}
      </button>
      <button
        type="button"
        disabled={busy}
        className="rounded-md border border-white/20 px-2 py-1 text-[10px] uppercase tracking-wide text-white/70 disabled:opacity-40"
        onClick={onAskRemove}
      >
        {removeLabel}
      </button>
    </div>
  );
}

/** Dynamic credential inputs rendered from a recipe's requiredFields. */
function RecipeFieldList({
  fields,
  values,
  onChange,
}: {
  fields: JarvisRecipeField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <div key={field.key}>
          <label className="block text-[11px] uppercase text-white/40" htmlFor={`fld-${field.key}`}>
            {field.label}
          </label>
          <input
            id={`fld-${field.key}`}
            type={field.secret ? "password" : "text"}
            value={values[field.key] ?? ""}
            onChange={(event) => onChange(field.key, event.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
          />
          {(field.help || field.href) && (
            <p className="mt-1 text-[11px] text-white/45">
              {field.help}
              {field.href && (
                <>
                  {" "}
                  <a
                    href={field.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--color-primary-glow)] underline"
                  >
                    {field.href}
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

export function JarvisIntegrations({ token, onClose, onChanged }: JarvisIntegrationsProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<JarvisIntegrationsData | null>(null);
  const [drafts, setDrafts] = useState<JarvisIntegrationDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  // Composer / engineer state
  const [draft, setDraft] = useState<JarvisIntegrationDraft | null>(null);
  const [validations, setValidations] = useState<JarvisIntegrationValidation[]>([]);
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<JarvisEngineerSourceType>("openapi");
  const [sourceRef, setSourceRef] = useState("");
  const [sourceContent, setSourceContent] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authKind, setAuthKind] = useState("");
  const [secret, setSecret] = useState("");
  const [recipe, setRecipe] = useState<JarvisIntegrationRecipe | null>(null);
  const [recipeSource, setRecipeSource] = useState<JarvisIntegrationRecipe["source"] | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [editing, setEditing] = useState<JarvisStudioConnector | null>(null);
  const [editName, setEditName] = useState("");
  const [editOrigin, setEditOrigin] = useState("");
  const [editSecret, setEditSecret] = useState("");
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);

  const refresh = async () => {
    const [integrations, draftList] = await Promise.all([
      listJarvisIntegrations(token),
      listJarvisDrafts(token).catch(() => ({ drafts: [] as JarvisIntegrationDraft[] })),
    ]);
    setData(integrations);
    setDrafts(draftList.drafts);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("jarvis.integrations.loadFailed", "Failed to load integrations"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const activeConnectors = useMemo(
    () => (data?.connectors ?? []).filter((row) => row.status !== "disabled"),
    [data],
  );
  const needsAttention = useMemo(
    () => activeConnectors.filter((row) => healthOf(row.health) !== "READY"),
    [activeConnectors],
  );
  const healthy = useMemo(
    () => activeConnectors.filter((row) => healthOf(row.health) === "READY"),
    [activeConnectors],
  );
  const openDrafts = useMemo(
    () => drafts.filter((row) => row.status !== "READY"),
    [drafts],
  );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("jarvis.engineer.failed", "Something went wrong"));
    } finally {
      setBusy(false);
    }
  };

  const resetComposer = () => {
    setDraft(null);
    setValidations([]);
    setName("");
    setSourceType("openapi");
    setSourceRef("");
    setSourceContent("");
    setBaseUrl("");
    setAuthKind("");
    setSecret("");
    setRecipe(null);
    setRecipeSource(null);
    setFieldValues({});
    setConnected(false);
  };

  const setField = (key: string, value: string) =>
    setFieldValues((prev) => ({ ...prev, [key]: value }));

  /** Fields the connection actually needs; falls back to a single secret box. */
  const recipeFields: JarvisRecipeField[] =
    recipe?.requiredFields && recipe.requiredFields.length > 0
      ? recipe.requiredFields
      : [{ key: "secret", label: t("jarvis.engineer.secret", "Credential secret"), help: "", secret: true }];

  /** Assemble the credential payload the engineer routes expect from the field map. */
  const credentialPayload = (): { secret?: string; fields?: Record<string, string> } => {
    const filled = Object.fromEntries(
      Object.entries(fieldValues).map(([key, value]) => [key, value.trim()]),
    );
    const keys = recipeFields.map((field) => field.key);
    if (keys.length === 1 && keys[0] === "secret") {
      return { secret: filled.secret || secret.trim() || undefined };
    }
    return { fields: filled };
  };

  const hasCredential = () => {
    const payload = credentialPayload();
    if (payload.secret) {
      return true;
    }
    return Object.values(payload.fields ?? {}).some((value) => value.length > 0);
  };

  const recommend = (product: string) =>
    run(async () => {
      const trimmed = product.trim();
      if (!trimmed) {
        return;
      }
      const result = await recommendJarvisConnection(token, { product: trimmed });
      setRecipe(result.recipe);
      setRecipeSource(result.source);
      setName((current) => current || result.recipe.displayName);
    });

  /** Catalog OAuth: kick off the hosted OAuth flow, threading user-supplied client id/secret. */
  const connectWithOauth = () =>
    run(async () => {
      if (!recipe) {
        return;
      }
      const started = await startJarvisConnect(token, { product: recipe.slug, purpose: recipe.purpose });
      if (started.status === "connected") {
        await refresh();
        onChanged?.();
        setConnected(true);
        return;
      }
      if (!started.connectId) {
        return;
      }
      const oauth = await startJarvisOauth(token, started.connectId, fieldValues, recipe.slug);
      window.open(oauth.url, "_blank", "noopener,noreferrer");
    });

  /** Catalog non-OAuth: complete the trusted connect flow with the supplied fields. */
  const connectWithFields = () =>
    run(async () => {
      if (!recipe) {
        return;
      }
      const started = await startJarvisConnect(token, { product: recipe.slug, purpose: recipe.purpose });
      if (started.status === "connected") {
        setConnected(true);
        return;
      }
      if (!started.connectId) {
        return;
      }
      await completeJarvisConnect(token, started.connectId, fieldValues, recipe.slug);
      await refresh();
      onChanged?.();
      setConnected(true);
    });

  const startDraft = () =>
    run(async () => {
      const created = await createJarvisDraft(token, name.trim() || t("jarvis.engineer.untitled", "Untitled integration"));
      setDraft(created.draft);
    });

  const submitSource = () =>
    run(async () => {
      if (!draft) {
        return;
      }
      const usesRef = REF_SOURCES.has(sourceType);
      const updated = await addJarvisDraftSource(token, draft.id, {
        type: sourceType,
        ref: usesRef ? sourceRef.trim() || undefined : undefined,
        content: usesRef ? undefined : sourceContent.trim() || undefined,
      });
      setDraft(updated.draft);
      setSourceContent("");
      setSourceRef("");
    });

  const submitAnswer = () =>
    run(async () => {
      if (!draft) {
        return;
      }
      const updated = await answerJarvisDraft(token, draft.id, {
        baseUrl: baseUrl.trim() || undefined,
        authKind: authKind.trim() || undefined,
      });
      setDraft(updated.draft);
    });

  const submitPropose = () =>
    run(async () => {
      if (!draft) {
        return;
      }
      const updated = await proposeJarvisDraft(token, draft.id);
      setDraft(updated.draft);
    });

  const submitValidate = () =>
    run(async () => {
      if (!draft) {
        return;
      }
      const result = await validateJarvisDraft(token, draft.id, credentialPayload());
      setDraft(result.draft);
      setValidations(result.validations);
    });

  const submitApprove = () =>
    run(async () => {
      if (!draft || !hasCredential()) {
        return;
      }
      // Prove-before-done: register (which validates + remembers on pass) keeps
      // the entered fields intact if it throws, so the user fixes one value and
      // retries instead of starting over.
      await approveJarvisDraft(token, draft.id, credentialPayload());
      await refresh();
      onChanged?.();
      setComposerOpen(false);
      resetComposer();
    });

  const openEdit = (row: JarvisStudioConnector) => {
    setEditing(row);
    setEditName(row.name);
    setEditOrigin(row.origin);
    setEditSecret("");
    setPendingRemoveId(null);
  };

  const saveEdit = () =>
    run(async () => {
      if (!editing) {
        return;
      }
      await patchJarvisIntegration(token, editing.id, {
        name: editName.trim() || undefined,
        origin: editOrigin.trim() || undefined,
        secret: editSecret.trim() || undefined,
      });
      setEditing(null);
      setEditSecret("");
      await refresh();
      onChanged?.();
    });

  const removeConnectorRow = (connectorId: string) =>
    run(async () => {
      await deleteJarvisIntegration(token, connectorId);
      setPendingRemoveId(null);
      await refresh();
      onChanged?.();
    });

  const resumeDraft = (draftId: string) =>
    run(async () => {
      const detail = await getJarvisDraft(token, draftId);
      setDraft(detail.draft);
      setValidations(detail.validations);
      setName(detail.draft.name);
      setComposerOpen(true);
    });

  const statusTone = (status: JarvisIntegrationDraft["status"]) => {
    if (status === "READY") {
      return "text-emerald-200";
    }
    if (status.endsWith("_FAILED") || status === "INVALID_SPEC" || status === "REVOKED" || status === "DISABLED") {
      return "text-red-200";
    }
    return "text-[var(--color-primary-glow)]";
  };

  const usesRef = REF_SOURCES.has(sourceType);

  return (
    <aside className="absolute inset-0 z-20 flex flex-col bg-[#070b14]">
      <header className="flex items-center justify-between gap-4 border-b border-white/10 px-6 py-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-primary-glow)]">
            {t("jarvis.integrations.title")}
          </p>
          <h2 className="mt-1 text-lg font-semibold">
            {t("jarvis.integrations.subtitle", "Integration Operating System")}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-lg bg-[var(--color-primary-glow)] px-3 py-1.5 text-xs font-medium text-black"
            onClick={() => {
              resetComposer();
              setComposerOpen(true);
            }}
          >
            {t("jarvis.engineer.connectAnything", "+ Connect anything")}
          </button>
          <button
            type="button"
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
            onClick={onClose}
          >
            {t("jarvis.studio.close")}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <section>
            <h3 className="mb-3 text-[11px] uppercase tracking-[0.18em] text-white/40">
              {t("jarvis.integrations.connected")}
            </h3>
            {healthy.length === 0 && (
              <p className="text-sm text-white/40">{t("jarvis.integrations.empty")}</p>
            )}
            <ul className="space-y-2">
              {healthy.map((row) => (
                <li key={row.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-white/85">{row.name}</p>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide",
                        HEALTH_TONE[healthOf(row.health)],
                      )}
                    >
                      {t(`jarvis.health.${healthOf(row.health)}`, healthOf(row.health))}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] uppercase tracking-wide text-white/40">
                    {row.purpose ?? row.kind} · r{row.revision} ·{" "}
                    {t("jarvis.integrations.capabilities", "{{count}} capabilities", {
                      count: row.capabilityCount ?? 0,
                    })}
                  </p>
                  {row.origin && <p className="mt-1 truncate text-xs text-white/50">{row.origin}</p>}
                  <ConnectorActions
                    connectorId={row.id}
                    pendingRemoveId={pendingRemoveId}
                    busy={busy}
                    editLabel={t("jarvis.integrations.edit", "Edit")}
                    removeLabel={t("jarvis.integrations.remove", "Remove")}
                    confirmLabel={t("jarvis.integrations.confirmRemove", "Confirm remove")}
                    cancelLabel={t("jarvis.integrations.cancel", "Cancel")}
                    onEdit={() => openEdit(row)}
                    onAskRemove={() => setPendingRemoveId(row.id)}
                    onConfirmRemove={() => void removeConnectorRow(row.id)}
                    onCancelRemove={() => setPendingRemoveId(null)}
                  />
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-3 text-[11px] uppercase tracking-[0.18em] text-white/40">
              {t("jarvis.integrations.needsAttention", "Needs attention")}
            </h3>
            {needsAttention.length === 0 && (
              <p className="text-sm text-white/40">{t("jarvis.integrations.allHealthy", "Everything is healthy")}</p>
            )}
            <ul className="space-y-2">
              {needsAttention.map((row) => (
                <li key={row.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-white/85">{row.name}</p>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide",
                        HEALTH_TONE[healthOf(row.health)],
                      )}
                    >
                      {t(`jarvis.health.${healthOf(row.health)}`, healthOf(row.health))}
                    </span>
                  </div>
                  {row.healthDetail && (
                    <p className="mt-1 text-xs text-white/55">{row.healthDetail}</p>
                  )}
                  <ConnectorActions
                    connectorId={row.id}
                    pendingRemoveId={pendingRemoveId}
                    busy={busy}
                    editLabel={t("jarvis.integrations.edit", "Edit")}
                    removeLabel={t("jarvis.integrations.remove", "Remove")}
                    confirmLabel={t("jarvis.integrations.confirmRemove", "Confirm remove")}
                    cancelLabel={t("jarvis.integrations.cancel", "Cancel")}
                    onEdit={() => openEdit(row)}
                    onAskRemove={() => setPendingRemoveId(row.id)}
                    onConfirmRemove={() => void removeConnectorRow(row.id)}
                    onCancelRemove={() => setPendingRemoveId(null)}
                  />
                </li>
              ))}
            </ul>

            {openDrafts.length > 0 && (
              <>
                <h3 className="mb-3 mt-6 text-[11px] uppercase tracking-[0.18em] text-white/40">
                  {t("jarvis.engineer.draftsInProgress", "Drafts in progress")}
                </h3>
                <ul className="space-y-2">
                  {openDrafts.map((row) => (
                    <li
                      key={row.id}
                      className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/20 p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-white/85">{row.name}</p>
                        <p className={cn("mt-0.5 text-[10px] uppercase tracking-wide", statusTone(row.status))}>
                          {t(`jarvis.engineer.status.${row.status}`, row.status)}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        className="shrink-0 rounded-md border border-white/20 px-2 py-1 text-[10px] uppercase tracking-wide text-white/70 disabled:opacity-40"
                        onClick={() => void resumeDraft(row.id)}
                      >
                        {t("jarvis.engineer.resume", "Resume")}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>

        <section className="mt-8">
          <h3 className="mb-3 text-[11px] uppercase tracking-[0.18em] text-white/40">
            {t("jarvis.integrations.catalog")}
          </h3>
          <div className="flex flex-wrap gap-2">
            {data?.catalog.map((row) => (
              <button
                key={row.id}
                type="button"
                className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-white/60 hover:border-[var(--color-primary-glow)]/50 hover:text-white/90"
                onClick={() => {
                  resetComposer();
                  setName(row.id);
                  setComposerOpen(true);
                  void recommend(row.id);
                }}
              >
                {row.id}
              </button>
            ))}
          </div>
        </section>

        {error && <p className="mt-6 text-sm text-red-300">{error}</p>}
      </div>

      {editing && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#0b1220] p-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{t("jarvis.integrations.editTitle", "Edit integration")}</h3>
              <button
                type="button"
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
                onClick={() => setEditing(null)}
              >
                {t("jarvis.studio.close")}
              </button>
            </div>
            <label className="mt-4 block text-[11px] uppercase text-white/40" htmlFor="edit-name">
              {t("jarvis.engineer.name", "Name")}
            </label>
            <input
              id="edit-name"
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
            />
            <label className="mt-3 block text-[11px] uppercase text-white/40" htmlFor="edit-origin">
              {t("jarvis.studio.connectorOrigin", "Origin")}
            </label>
            <input
              id="edit-origin"
              value={editOrigin}
              onChange={(event) => setEditOrigin(event.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
            />
            <label className="mt-3 block text-[11px] uppercase text-white/40" htmlFor="edit-secret">
              {t("jarvis.engineer.secret", "Credential secret")}
            </label>
            <input
              id="edit-secret"
              type="password"
              value={editSecret}
              onChange={(event) => setEditSecret(event.target.value)}
              placeholder={t("jarvis.integrations.secretKeep", "Leave blank to keep the current secret")}
              className="mt-1 h-9 w-full rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
            />
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                disabled={busy}
                className="rounded-lg bg-[var(--color-primary-glow)] px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40"
                onClick={() => void saveEdit()}
              >
                {t("jarvis.integrations.save", "Save")}
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                onClick={() => setEditing(null)}
              >
                {t("jarvis.integrations.cancel", "Cancel")}
              </button>
            </div>
            {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
          </div>
        </div>
      )}

      {composerOpen && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-6">
          <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#0b1220]">
            <div className="flex items-center justify-between gap-2 border-b border-white/10 px-5 py-3">
              <h3 className="text-sm font-semibold">
                {t("jarvis.engineer.title", "Integration Engineer")}
              </h3>
              <button
                type="button"
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
                onClick={() => {
                  setComposerOpen(false);
                  resetComposer();
                }}
              >
                {t("jarvis.studio.close")}
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              {!draft ? (
                <>
                  <p className="text-xs text-white/50">
                    {t(
                      "jarvis.engineer.intro",
                      "Describe the system to connect. Jarvis discovers the API, proposes capabilities, validates the connection, then registers it.",
                    )}
                  </p>
                  <label className="block text-[11px] uppercase text-white/40" htmlFor="eng-name">
                    {t("jarvis.engineer.name", "Name")}
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="eng-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={t("jarvis.engineer.namePlaceholder", "e.g. Gmail, Acme Inventory")}
                      className="h-9 flex-1 rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
                    />
                    <button
                      type="button"
                      disabled={busy || !name.trim()}
                      className="shrink-0 rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                      onClick={() => void recommend(name)}
                    >
                      {t("jarvis.recommend.howTo", "How to connect")}
                    </button>
                  </div>

                  {recipe && (
                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-white/90">
                          {t("jarvis.recommend.title", "How to connect {{product}}", {
                            product: recipe.displayName,
                          })}
                        </p>
                        {recipeSource && (
                          <span className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/55">
                            {t(`jarvis.recommend.source.${recipeSource}`, recipeSource)}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] uppercase tracking-wide text-[var(--color-primary-glow)]">
                        {t("jarvis.recommend.recommendedMethod", "Recommended: {{method}}", {
                          method: t(
                            `jarvis.recommend.method.${recipe.recommendedAuth.kind}`,
                            recipe.recommendedAuth.kind,
                          ),
                        })}
                      </p>

                      {recipe.steps.length > 0 && (
                        <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-white/70">
                          {recipe.steps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                      )}

                      {recipe.docs.length > 0 && (
                        <ul className="mt-2 space-y-1 text-xs">
                          {recipe.docs.map((doc) => (
                            <li key={doc.url}>
                              <a
                                href={doc.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[var(--color-primary-glow)] underline"
                              >
                                {doc.title}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="mt-3">
                        <RecipeFieldList fields={recipeFields} values={fieldValues} onChange={setField} />
                      </div>

                      {connected ? (
                        <p className="mt-3 text-sm text-emerald-200">
                          {t("jarvis.recommend.connected", "Connected")}
                        </p>
                      ) : (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {recipeSource === "catalog" && recipe.recommendedAuth.kind === "oauth" ? (
                            <button
                              type="button"
                              disabled={busy}
                              className="rounded-lg bg-[var(--color-primary-glow)] px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40"
                              onClick={() => void connectWithOauth()}
                            >
                              {t("jarvis.recommend.connectOauth", "Connect with OAuth")}
                            </button>
                          ) : recipeSource === "catalog" ? (
                            <button
                              type="button"
                              disabled={busy || !hasCredential()}
                              className="rounded-lg bg-[var(--color-primary-glow)] px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40"
                              onClick={() => void connectWithFields()}
                            >
                              {t("jarvis.recommend.connect", "Connect")}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            disabled={busy}
                            className="rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                            onClick={() => {
                              if (recipe.baseUrl) {
                                setBaseUrl(recipe.baseUrl);
                              }
                              setAuthKind(recipe.credentialKind);
                              void startDraft();
                            }}
                          >
                            {t("jarvis.recommend.useRecipe", "Set up manually")}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {!recipe && (
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-lg bg-[var(--color-primary-glow)] px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40"
                      onClick={() => void startDraft()}
                    >
                      {t("jarvis.engineer.start", "Start")}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-white/90">{draft.name}</p>
                    <span className={cn("text-[10px] uppercase tracking-wide", statusTone(draft.status))}>
                      {t(`jarvis.engineer.status.${draft.status}`, draft.status)}
                    </span>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <p className="text-[11px] uppercase text-white/40">
                      {t("jarvis.engineer.addSource", "Add source")}
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <select
                        value={sourceType}
                        onChange={(event) => setSourceType(event.target.value as JarvisEngineerSourceType)}
                        className="h-9 rounded-lg border border-white/15 bg-black/40 px-2 text-sm"
                      >
                        {SOURCE_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {t(`jarvis.engineer.source.${type}`, type)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy}
                        className="rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                        onClick={() => void submitSource()}
                      >
                        {t("jarvis.engineer.discover", "Discover")}
                      </button>
                    </div>
                    {usesRef ? (
                      <input
                        value={sourceRef}
                        onChange={(event) => setSourceRef(event.target.value)}
                        placeholder={t("jarvis.engineer.refPlaceholder", "https://...")}
                        className="mt-2 h-9 w-full rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
                      />
                    ) : (
                      <textarea
                        value={sourceContent}
                        onChange={(event) => setSourceContent(event.target.value)}
                        placeholder={t("jarvis.engineer.contentPlaceholder", "Paste OpenAPI, Postman, curl, or docs…")}
                        className="mt-2 h-24 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm"
                      />
                    )}
                  </div>

                  {draft.questions.length > 0 && (
                    <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3">
                      <p className="text-[11px] uppercase text-amber-200/80">
                        {t("jarvis.engineer.missingInfo", "Missing info")}
                      </p>
                      <ul className="mt-1 space-y-1 text-xs text-amber-100/90">
                        {draft.questions.map((question) => (
                          <li key={question}>{question}</li>
                        ))}
                      </ul>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <input
                          value={baseUrl}
                          onChange={(event) => setBaseUrl(event.target.value)}
                          placeholder={t("jarvis.engineer.baseUrl", "Base URL")}
                          className="h-9 rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
                        />
                        <input
                          value={authKind}
                          onChange={(event) => setAuthKind(event.target.value)}
                          placeholder={t("jarvis.engineer.authKind", "Auth (bearer/api_key/oauth)")}
                          className="h-9 rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        className="mt-2 rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                        onClick={() => void submitAnswer()}
                      >
                        {t("jarvis.engineer.answer", "Answer")}
                      </button>
                    </div>
                  )}

                  {draft.discoveredOperations.length > 0 && (
                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <p className="text-[11px] uppercase text-white/40">
                        {t("jarvis.engineer.operations", "Discovered operations")}
                      </p>
                      <ul className="mt-1 space-y-1 text-xs text-white/70">
                        {draft.discoveredOperations.slice(0, 20).map((op) => (
                          <li key={op.externalId} className="font-mono">
                            {op.method} {op.path}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {draft.proposedCapabilities.length > 0 && (
                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <p className="text-[11px] uppercase text-white/40">
                        {t("jarvis.engineer.capabilities", "Proposed capabilities")}
                      </p>
                      <ul className="mt-1 space-y-1 text-xs text-white/75">
                        {draft.proposedCapabilities.map((cap) => (
                          <li key={cap.toolId} className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate">
                              {cap.capabilityId}{" "}
                              <span className="text-white/40">({cap.method} {cap.path})</span>
                            </span>
                            <span className="shrink-0 text-white/45">
                              {cap.risk} · {Math.round(cap.confidence * 100)}%
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {validations.length > 0 && (
                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <p className="text-[11px] uppercase text-white/40">
                        {t("jarvis.engineer.validation", "Validation")}
                      </p>
                      <ul className="mt-1 space-y-1 text-xs">
                        {validations.map((row) => (
                          <li key={row.id} className="flex items-center justify-between gap-2">
                            <span className="text-white/70">
                              {t(`jarvis.engineer.level.${row.level}`, row.level)}
                            </span>
                            <span
                              className={cn(
                                row.status === "passed"
                                  ? "text-emerald-200"
                                  : row.status === "failed"
                                    ? "text-red-200"
                                    : "text-white/45",
                              )}
                            >
                              {t(`jarvis.engineer.vstatus.${row.status}`, row.status)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <RecipeFieldList fields={recipeFields} values={fieldValues} onChange={setField} />

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                      onClick={() => void submitPropose()}
                    >
                      {t("jarvis.engineer.propose", "Propose")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                      onClick={() => void submitValidate()}
                    >
                      {t("jarvis.engineer.validate", "Validate")}
                    </button>
                    <button
                      type="button"
                      disabled={busy || !hasCredential()}
                      className="rounded-lg bg-[var(--color-primary-glow)] px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40"
                      onClick={() => void submitApprove()}
                    >
                      {t("jarvis.engineer.approve", "Approve & register")}
                    </button>
                  </div>
                </>
              )}
              {error && <p className="text-sm text-red-300">{error}</p>}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
