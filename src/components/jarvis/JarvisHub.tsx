import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import type { ServiceDefinition } from "@/config/services";
import {
  completeJarvisConnect,
  createJarvisRun,
  createJarvisSession,
  decideJarvisApproval,
  executeClientTool,
  executeNativeEnvelope,
  jarvisHealth,
  listJarvisAgents,
  listJarvisCommunications,
  listJarvisMemories,
  listJarvisThreads,
  postJarvisToolResult,
  revokeJarvisSession,
  startJarvisOauth,
  subscribeJarvisRun,
  type JarvisAgent,
  type JarvisCommunication,
  type JarvisEnvelope,
  type JarvisMemory,
  type JarvisSession,
} from "@/lib/jarvis-api";
import { readCachedJarvisSession } from "@/lib/jarvis-session-cache";
import { JarvisInbox } from "./JarvisInbox";
import { JarvisIntegrations as JarvisIntegrationsPanel } from "./JarvisIntegrations";
import { JarvisStudio } from "./JarvisStudio";
import { invoke } from "@tauri-apps/api/core";
import { applyAgentHandle } from "@/lib/jarvis-prompt";
import { activityDotClass } from "@/lib/jarvis-org-map";
import { cn } from "@/lib/utils";

type TranscriptItem = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
};

function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type ApprovalCard = {
  approvalId: string;
  tool: string;
  arguments: Record<string, unknown>;
};

type ConnectField = { key: string; label: string; help?: string; href?: string; secret?: boolean };

type ConnectCard = {
  connectId: string;
  purpose?: string;
  provider: string | null;
  ask?: string;
  candidates: Array<{ id: string; fields?: ConnectField[] }>;
  authMethods: Array<{ kind: string; fields: ConnectField[] }>;
  fields: ConnectField[];
};

function ConnectCardForm({
  card,
  values,
  onChange,
  onSubmit,
  onOauth,
  submitLabel,
  oauthLabel,
  chooseProductLabel,
  guideLabel,
  title,
  subtitle,
}: {
  card: ConnectCard;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  onSubmit: () => void;
  onOauth: () => void;
  submitLabel: string;
  oauthLabel: string;
  chooseProductLabel: string;
  guideLabel: string;
  title: string;
  subtitle: string;
}) {
  const selected = card.candidates.find((row) => row.id === values.product);
  const visibleFields = card.fields.length > 0 ? card.fields : (selected?.fields ?? []);
  const hasOauth = card.authMethods.some((row) => row.kind === "oauth");
  return (
    <div className="rounded-xl border border-sky-400/40 bg-sky-400/10 p-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-white/60">{subtitle}</p>
      <div className="mt-3 flex flex-col gap-2">
        {card.ask === "product" && card.candidates.length > 0 && (
          <select
            className="rounded-md border border-white/15 bg-black/30 px-2 py-1 text-xs"
            value={values.product ?? ""}
            onChange={(event) => onChange({ ...values, product: event.target.value })}
          >
            <option value="">{chooseProductLabel}</option>
            {card.candidates.map((row) => (
              <option key={row.id} value={row.id}>
                {row.id}
              </option>
            ))}
          </select>
        )}
        {visibleFields
          .filter((field) => field.key !== "product")
          .map((field) => (
            <div key={field.key} className="flex flex-col gap-1">
              <input
                type={field.secret ? "password" : "text"}
                className="rounded-md border border-white/15 bg-black/30 px-2 py-1 text-xs"
                placeholder={field.label}
                value={values[field.key] ?? ""}
                onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
              />
              {field.help && <p className="text-xs text-white/50">{field.help}</p>}
              {field.href && (
                <button
                  type="button"
                  className="self-start text-xs text-sky-300 underline-offset-2 hover:underline"
                  onClick={() => void openConnectUrl(field.href!)}
                >
                  {guideLabel}
                </button>
              )}
            </div>
          ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="rounded-md bg-[var(--color-primary-glow)] px-3 py-1 text-xs font-medium"
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
        {hasOauth && (
          <button
            type="button"
            className="rounded-md border border-white/20 px-3 py-1 text-xs"
            onClick={onOauth}
          >
            {oauthLabel}
          </button>
        )}
      </div>
    </div>
  );
}

async function openConnectUrl(url: string) {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}

type JarvisHubProps = {
  onOpenService: (service: ServiceDefinition) => void;
  onShowHome: () => void;
  onShowDevelopers: () => void;
  onShowSettings: () => void;
};

export function JarvisHub({
  onOpenService,
  onShowHome,
  onShowDevelopers,
  onShowSettings,
}: JarvisHubProps) {
  const { t } = useTranslation();
  const account = useAuthStore((s) => s.session?.account);
  const atid = useAuthStore((s) => s.session?.token);
  const [session, setSession] = useState<JarvisSession | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<
    "studio" | "inbox" | "memory" | "comms" | "integrations" | null
  >(null);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [connects, setConnects] = useState<ConnectCard[]>([]);
  const [resolveGaps, setResolveGaps] = useState<
    Array<{ id: string; purpose: string | null; status: string }>
  >([]);
  const [connectFields, setConnectFields] = useState<Record<string, Record<string, string>>>({});
  const [agents, setAgents] = useState<JarvisAgent[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [communications, setCommunications] = useState<JarvisCommunication[]>([]);
  const [memories, setMemories] = useState<JarvisMemory[]>([]);
  const [commKind, setCommKind] = useState<"all" | "a_a" | "h_a" | "a_h">("all");
  const [commAgentId, setCommAgentId] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [thinkingKey, setThinkingKey] = useState("jarvis.thinking");
  const [bootKey, setBootKey] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!atid) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const health = await jarvisHealth();
        try {
          await invoke("jarvis_pin_server_key", { publicKey: health.serverPublicKey });
        } catch (err) {
          if (String(err).includes("already pinned")) {
            throw new Error("Jarvis server key changed. Restart the desktop app.");
          }
          throw err;
        }
        const cached = readCachedJarvisSession(localStorage);
        const next =
          cached && cached.serverPublicKey === health.serverPublicKey
            ? cached
            : await createJarvisSession(atid);
        if (cancelled) {
          return;
        }
        if (next.serverPublicKey !== health.serverPublicKey) {
          throw new Error("Jarvis server key changed. Restart the desktop app.");
        }
        setSession(next);
        let token = next.token;
        let agentList: Awaited<ReturnType<typeof listJarvisAgents>>;
        let comms: Awaited<ReturnType<typeof listJarvisCommunications>>;
        let threads: Awaited<ReturnType<typeof listJarvisThreads>>;
        try {
          [agentList, comms, threads] = await Promise.all([
            listJarvisAgents(token),
            listJarvisCommunications(token),
            listJarvisThreads(token),
          ]);
        } catch (err) {
          if (next !== cached) {
            throw err;
          }
          const minted = await createJarvisSession(atid);
          if (cancelled) {
            return;
          }
          setSession(minted);
          token = minted.token;
          [agentList, comms, threads] = await Promise.all([
            listJarvisAgents(token),
            listJarvisCommunications(token),
            listJarvisThreads(token),
          ]);
        }
        if (cancelled) {
          return;
        }
        setAgents(agentList.items);
        setCommunications(comms.items);
        try {
          const mems = await listJarvisMemories(token);
          if (!cancelled) {
            setMemories(mems.items);
          }
        } catch {
          if (!cancelled) {
            setMemories([]);
          }
        }
        const latest = [...threads.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (latest) {
          setThreadId(latest.id);
          setTranscript(
            (latest.messages ?? []).map((row) => ({
              id: row.id,
              role: row.role,
              text: row.content,
              createdAt: row.createdAt,
            })),
          );
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Jarvis session failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [atid, bootKey]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [transcript, busy, connects.length]);

  const greeting = useMemo(
    () =>
      account?.firstName
        ? t("jarvis.greeting", { name: account.firstName })
        : t("jarvis.greetingFallback"),
    [account?.firstName, t],
  );

  const refreshAgents = async (token: string) => {
    const list = await listJarvisAgents(token);
    setAgents(list.items);
  };

  const applyOpenTarget = (opened: unknown) => {
    const target = opened as {
      kind?: string;
      service?: ServiceDefinition;
      id?: string;
    };
    if (target.kind === "service" && target.service) {
      onOpenService(target.service);
      return;
    }
    if (target.id === "home") {
      onShowHome();
    }
    if (target.id === "developers") {
      onShowDevelopers();
    }
    if (target.id === "settings") {
      onShowSettings();
    }
  };

  const handleToolStarted = async (
    token: string,
    runId: string,
    payload: Record<string, unknown>,
  ) => {
    const envelope = payload.envelope as JarvisEnvelope | undefined;
    const tool = String(payload.tool ?? envelope?.tool ?? "");
    if (tool === "desktop.open_service") {
      const args = (envelope?.arguments ?? {}) as Record<string, unknown>;
      const opened = await executeClientTool(tool, args);
      const signed = await invoke<{
        status: "succeeded" | "failed";
        result: unknown;
        executedAt: string;
        deviceSignature: string;
        toolInvocationId: string;
        requestId: string;
      }>("jarvis_sign_tool_result", {
        runId,
        toolInvocationId: envelope!.toolInvocationId,
        requestId: envelope!.requestId,
        status: "succeeded",
        result: opened,
      });
      await postJarvisToolResult(token, runId, signed);
      applyOpenTarget(opened.opened);
      return;
    }
    if (envelope && (payload.side === "native" || envelope.tool)) {
      const signed = await executeNativeEnvelope(envelope);
      await postJarvisToolResult(token, runId, signed);
    }
  };

  const submit = async () => {
    if (!session || !prompt.trim() || busy) {
      return;
    }
    const text = prompt.trim();
    const boundId =
      selectedAgentId ??
      agents.find((agent) => text.toLowerCase().startsWith(`@${agent.handle.toLowerCase()}`))?.id ??
      null;
    setPrompt("");
    setBusy(true);
    setThinkingKey("jarvis.thinking");
    setError(null);
    if (boundId) {
      setAgents((rows) =>
        rows.map((agent) =>
          agent.id === boundId
            ? { ...agent, activity: { status: "starting", title: text } }
            : agent,
        ),
      );
    }
    setTranscript((rows) => [
      ...rows,
      { id: `u-${Date.now()}`, role: "user", text, createdAt: new Date().toISOString() },
    ]);
    try {
      const created = await createJarvisRun(session.token, text, {
        threadId: threadId ?? undefined,
        agentId: selectedAgentId ?? undefined,
      });
      setThreadId(created.threadId);
      let token = session.token;
      const refreshSession = async () => {
        const next = await createJarvisSession(atid!);
        setSession(next);
        token = next.token;
        return next.token;
      };
      await subscribeJarvisRun(token, created.runId, async (event) => {
        if (event.event === "connect_required") {
          const card: ConnectCard = {
            connectId: String(event.data.connectId),
            purpose: event.data.purpose ? String(event.data.purpose) : undefined,
            provider: event.data.provider ? String(event.data.provider) : null,
            ask: event.data.ask ? String(event.data.ask) : undefined,
            candidates: Array.isArray(event.data.candidates)
              ? (event.data.candidates as ConnectCard["candidates"])
              : [],
            authMethods: Array.isArray(event.data.authMethods)
              ? (event.data.authMethods as ConnectCard["authMethods"])
              : [],
            fields: Array.isArray(event.data.fields)
              ? (event.data.fields as ConnectField[])
              : [],
          };
          setConnects((rows) => [...rows.filter((row) => row.connectId !== card.connectId), card]);
        }
        if (event.event === "resolve_integrations") {
          const caps = Array.isArray(event.data.capabilities)
            ? (event.data.capabilities as Array<Record<string, unknown>>)
            : [];
          setResolveGaps(
            caps.map((row) => ({
              id: String(row.id),
              purpose: row.purpose ? String(row.purpose) : null,
              status: String(row.status ?? "MISSING"),
            })),
          );
        }
        if (event.event === "approval_required") {
          setApprovals((rows) => [
            ...rows,
            {
              approvalId: String(event.data.approvalId),
              tool: String(event.data.tool),
              arguments: (event.data.arguments ?? {}) as Record<string, unknown>,
            },
          ]);
        }
        if (event.event === "message_complete") {
          const handle = String(event.data.handle ?? "");
          const content = String(event.data.content ?? "");
          setTranscript((rows) => [
            ...rows,
            {
              id: event.id,
              role: "assistant",
              text: content.startsWith("@") || !handle ? content : `@${handle} ${content}`,
              createdAt: new Date().toISOString(),
            },
          ]);
          void refreshAgents(token);
        }
        if (event.event === "error") {
          setError(String(event.data.message ?? "Run failed"));
        }
        if (event.event === "tool_started") {
          if (String(event.data.tool ?? "") === "web.search") {
            setThinkingKey("jarvis.searching");
          }
          if (boundId) {
            setAgents((rows) =>
              rows.map((agent) =>
                agent.id === boundId
                  ? { ...agent, activity: { status: "working", title: text } }
                  : agent,
              ),
            );
          }
          void refreshAgents(token);
          await handleToolStarted(token, created.runId, event.data);
        }
        if (event.event === "run_state") {
          const status = String(event.data.status ?? "");
          if (status === "completed" || status === "failed") {
            void refreshAgents(token);
          }
        }
        if (event.event === "memory_update" || event.event === "message_complete") {
          const [comms, mems] = await Promise.all([
            listJarvisCommunications(token),
            listJarvisMemories(token),
          ]);
          setCommunications(comms.items);
          setMemories(mems.items);
        }
      }, { onUnauthorized: refreshSession });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[#070b14] text-white">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="hero-aurora opacity-70" />
        <div className="hero-grid opacity-20" />
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-6 sm:px-10">
        <header className="mb-4 shrink-0 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-primary-glow)]">
              {t("jarvis.menuLabel")}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{greeting}</h1>
            <p className="mt-1 text-sm text-white/60">{t("jarvis.subtitle")}</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
              onClick={() => setDrawer(drawer === "studio" ? null : "studio")}
            >
              {t("jarvis.studio.open")}
            </button>
            <button
              type="button"
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
              onClick={() => setDrawer(drawer === "inbox" ? null : "inbox")}
            >
              {t("jarvis.inbox.open")}
            </button>
            <button
              type="button"
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
              onClick={() => setDrawer(drawer === "integrations" ? null : "integrations")}
            >
              {t("jarvis.integrations.title")}
            </button>
            <button
              type="button"
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
              onClick={() => {
                const next = drawer === "memory" ? null : "memory";
                setDrawer(next);
                if (next === "memory" && session) {
                  void listJarvisMemories(session.token).then((list) => setMemories(list.items));
                }
              }}
            >
              {t("jarvis.memory")}
            </button>
            <button
              type="button"
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
              onClick={() => {
                const next = drawer === "comms" ? null : "comms";
                setDrawer(next);
                if (next === "comms" && session) {
                  void listJarvisCommunications(session.token).then((list) =>
                    setCommunications(list.items),
                  );
                }
              }}
            >
              {t("jarvis.comms.title")}
            </button>
            {session && (
              <button
                type="button"
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
                onClick={() => {
                  void revokeJarvisSession(session.token).then(() => setSession(null));
                }}
              >
                {t("jarvis.revokeSession")}
              </button>
            )}
          </div>
        </header>

        <div className="mb-6 flex shrink-0 items-center justify-center">
          <div
            className="relative flex h-28 w-28 items-center justify-center rounded-full border border-[var(--color-primary-glow)]/40 bg-black/40 shadow-[0_0_40px_var(--color-primary-glow)]"
            aria-label={t("jarvis.orbLabel")}
          >
            <Sparkles className="h-8 w-8 text-[var(--color-primary-glow)]" />
          </div>
        </div>

        <div className="mb-4 flex shrink-0 flex-wrap justify-center gap-2">
          {agents.map((agent) => {
            const status = agent.activity?.status ?? "idle";
            return (
              <button
                key={agent.id}
                type="button"
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10",
                  selectedAgentId === agent.id
                    ? "border-[var(--color-primary-glow)]"
                    : "border-white/15",
                )}
                onClick={() => {
                  setSelectedAgentId(agent.id);
                  setPrompt((current) => applyAgentHandle(current, agent.handle));
                }}
              >
                <span className={cn("h-2 w-2 rounded-full", activityDotClass(status))} />
                {agent.name} @{agent.handle}
                {status !== "idle" && (
                  <span className="text-white/45">
                    {t(`jarvis.studio.status.${status}`, status)}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div
          ref={transcriptRef}
          className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-white/10 bg-black/30 p-4"
        >
          {transcript.length === 0 && (
            <p className="text-sm text-white/50">{t("jarvis.emptyTranscript")}</p>
          )}
          <ul className="space-y-3">
            {transcript.map((item) => (
              <li
                key={item.id}
                className={cn(
                  "max-w-2xl text-sm",
                  item.role === "user" ? "ml-auto text-right text-white" : "text-white/80",
                )}
              >
                <p>{item.text}</p>
                {item.createdAt && (
                  <time
                    dateTime={item.createdAt}
                    className="mt-1 block text-[10px] text-white/35"
                  >
                    {formatStamp(item.createdAt)}
                  </time>
                )}
              </li>
            ))}
            {busy && (
              <li className="text-sm text-white/50">{t(thinkingKey)}</li>
            )}
          </ul>
          {connects.map((card) => {
            const values = connectFields[card.connectId] ?? {};
            return (
              <div key={card.connectId} className="mt-4">
                <ConnectCardForm
                  card={card}
                  values={values}
                  title={t("jarvis.connect.title", {
                    service: card.provider ?? card.purpose ?? t("jarvis.connect.service"),
                  })}
                  subtitle={t("jarvis.connect.subtitle")}
                  submitLabel={t("jarvis.connect.submit")}
                  oauthLabel={t("jarvis.connect.oauth")}
                  chooseProductLabel={t("jarvis.connect.chooseProduct")}
                  guideLabel={t("jarvis.connect.guide")}
                  onChange={(next) =>
                    setConnectFields((rows) => ({ ...rows, [card.connectId]: next }))
                  }
                  onSubmit={() => {
                    if (!session) {
                      return;
                    }
                    void completeJarvisConnect(
                      session.token,
                      card.connectId,
                      values,
                      values.product || card.provider || undefined,
                    ).then(() =>
                      setConnects((rows) => rows.filter((row) => row.connectId !== card.connectId)),
                    );
                  }}
                  onOauth={() => {
                    if (!session) {
                      return;
                    }
                    void startJarvisOauth(
                      session.token,
                      card.connectId,
                      values,
                      values.product || card.provider || undefined,
                    ).then((started) => openConnectUrl(started.url));
                  }}
                />
              </div>
            );
          })}
          {resolveGaps.length > 0 && (
            <div className="mt-4 rounded-xl border border-sky-400/40 bg-sky-400/10 p-3">
              <p className="text-sm font-medium">{t("jarvis.resolve.title", "Capabilities needed")}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-white/70">
                {resolveGaps.map((gap) => (
                  <li key={gap.id}>
                    {gap.purpose ?? gap.id}
                    <span className="ml-1 text-white/40">
                      · {t(`jarvis.resolve.status.${gap.status}`, gap.status)}
                    </span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mt-3 rounded-md bg-[var(--color-primary-glow)] px-3 py-1 text-xs font-medium text-black"
                onClick={() => {
                  setResolveGaps([]);
                  setDrawer("integrations");
                }}
              >
                {t("jarvis.resolve.action", "Resolve integrations")}
              </button>
            </div>
          )}
          {approvals.map((card) => (
            <div
              key={card.approvalId}
              className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3"
            >
              <p className="text-sm font-medium">{t("jarvis.approvalTitle", { tool: card.tool })}</p>
              <p className="mt-1 font-mono text-xs text-white/70">
                {JSON.stringify(card.arguments)}
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className="rounded-md bg-[var(--color-primary-glow)] px-3 py-1 text-xs font-medium"
                  onClick={() => {
                    if (!session) {
                      return;
                    }
                    void decideJarvisApproval(session.token, card.approvalId, "approved").then(
                      () =>
                        setApprovals((rows) =>
                          rows.filter((row) => row.approvalId !== card.approvalId),
                        ),
                    );
                  }}
                >
                  {t("jarvis.approve")}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-white/20 px-3 py-1 text-xs"
                  onClick={() => {
                    if (!session) {
                      return;
                    }
                    void decideJarvisApproval(session.token, card.approvalId, "rejected").then(
                      () =>
                        setApprovals((rows) =>
                          rows.filter((row) => row.approvalId !== card.approvalId),
                        ),
                    );
                  }}
                >
                  {t("jarvis.reject")}
                </button>
              </div>
            </div>
          ))}
        </div>

        {error && (
          <div className="mt-3 flex shrink-0 items-center gap-3">
            <p className="text-sm text-red-300">{error}</p>
            <button
              type="button"
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
              onClick={() => {
                setError(null);
                setBootKey((key) => key + 1);
              }}
            >
              {t("jarvis.retry")}
            </button>
          </div>
        )}

        <form
          className="mt-4 flex shrink-0 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t("jarvis.commandPlaceholder")}
            className="h-11 flex-1 rounded-xl border border-white/15 bg-black/40 px-4 text-sm outline-none ring-[var(--color-primary-glow)] focus:ring-2"
          />
          <button
            type="submit"
            disabled={busy || !session}
            className="h-11 rounded-xl bg-[var(--color-primary-glow)] px-4 text-sm font-medium disabled:opacity-40"
          >
            {t("jarvis.send")}
          </button>
        </form>
      </div>

      {drawer === "studio" && session && (
        <JarvisStudio
          token={session.token}
          onClose={() => setDrawer(null)}
          onInstantiated={() => {
            void listJarvisAgents(session.token).then((list) => setAgents(list.items));
          }}
        />
      )}
      {drawer === "inbox" && session && (
        <JarvisInbox token={session.token} onClose={() => setDrawer(null)} />
      )}
      {drawer === "integrations" && session && (
        <JarvisIntegrationsPanel
          token={session.token}
          onClose={() => setDrawer(null)}
          onChanged={() => {
            void listJarvisAgents(session.token).then((list) => setAgents(list.items));
          }}
        />
      )}
      {drawer === "memory" && session && (
        <aside className="absolute inset-y-0 right-0 z-20 w-[22rem] overflow-y-auto border-l border-white/10 bg-[#0b1220] p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t("jarvis.memory")}</h2>
            <button
              type="button"
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
              onClick={() => setDrawer(null)}
            >
              {t("jarvis.studio.close")}
            </button>
          </div>
          <ul className="mt-3 space-y-3 text-sm text-white/70">
            {memories.length === 0 && (
              <li className="text-white/40">{t("jarvis.memoryEmpty")}</li>
            )}
            {memories.map((row) => (
              <li key={row.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-white/40">
                  <span>{t(`jarvis.memoryScope.${row.scopeType}`, row.scopeType)}</span>
                  {row.createdAt && (
                    <time dateTime={row.createdAt}>{formatStamp(row.createdAt)}</time>
                  )}
                </div>
                <p className="mt-1 text-sm text-white/80">{row.content}</p>
              </li>
            ))}
          </ul>
        </aside>
      )}
      {drawer === "comms" && session && (
        <aside className="absolute inset-y-0 right-0 z-20 w-[22rem] overflow-y-auto border-l border-white/10 bg-[#0b1220] p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t("jarvis.comms.title")}</h2>
            <button
              type="button"
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
              onClick={() => setDrawer(null)}
            >
              {t("jarvis.studio.close")}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            {(["all", "a_a", "h_a", "a_h"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={cn(
                  "rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wide",
                  commKind === kind
                    ? "bg-[var(--color-primary-glow)] text-black"
                    : "border border-white/15 text-white/60",
                )}
                onClick={() => setCommKind(kind)}
              >
                {t(`jarvis.comms.filter.${kind}`)}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            <button
              type="button"
              className={cn(
                "rounded-full px-2.5 py-1 text-[10px]",
                commAgentId === "all" ? "bg-white/15" : "border border-white/15 text-white/60",
              )}
              onClick={() => setCommAgentId("all")}
            >
              {t("jarvis.comms.allAgents")}
            </button>
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className={cn(
                  "rounded-full px-2.5 py-1 text-[10px]",
                  commAgentId === agent.id ? "bg-white/15" : "border border-white/15 text-white/60",
                )}
                onClick={() => setCommAgentId(agent.id)}
              >
                @{agent.handle}
              </button>
            ))}
          </div>
          <ul className="mt-3 space-y-3 text-sm text-white/70">
            {communications
              .filter((row) => commKind === "all" || row.kind === commKind)
              .filter(
                (row) =>
                  commAgentId === "all" || row.from.id === commAgentId || row.to.id === commAgentId,
              ).length === 0 && <li className="text-white/40">{t("jarvis.comms.empty")}</li>}
            {communications
              .filter((row) => commKind === "all" || row.kind === commKind)
              .filter(
                (row) =>
                  commAgentId === "all" || row.from.id === commAgentId || row.to.id === commAgentId,
              )
              .map((row) => (
                <li key={row.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                  <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-white/40">
                    <span>{t(`jarvis.comms.kind.${row.kind}`)}</span>
                    {row.createdAt && (
                      <time dateTime={row.createdAt}>{formatStamp(row.createdAt)}</time>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-white/55">
                    {row.from.handle ? `@${row.from.handle}` : row.from.name} →{" "}
                    {row.to.handle ? `@${row.to.handle}` : row.to.name}
                  </p>
                  <p className="mt-1 text-sm text-white/80">{row.content}</p>
                </li>
              ))}
          </ul>
        </aside>
      )}
    </main>
  );
}
