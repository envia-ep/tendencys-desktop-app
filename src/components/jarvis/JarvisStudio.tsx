import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Bot, Building2, Headphones, Minus, Plus, TrendingUp, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createJarvisAgent,
  createJarvisStudioProposal,
  createJarvisStudioSkills,
  createJarvisStudioUnits,
  deleteJarvisStudioRelationship,
  deleteJarvisStudioUnit,
  attachJarvisConnectors,
  getJarvisStudio,
  instantiateJarvisStudioProposal,
  saveJarvisCustomTools,
  listJarvisAgents,
  listJarvisPrincipals,
  listJarvisStudioTemplates,
  patchJarvisStudioPrincipal,
  patchJarvisStudioProposal,
  patchJarvisStudioUnit,
  replaceJarvisReportsTo,
  writeJarvisStudioRelationships,
  type JarvisAgent,
  type JarvisCapabilityGap,
  type JarvisGraphEdge,
  type JarvisGraphNode,
  type JarvisStudioConnector,
  type JarvisStudioCustomTool,
  type JarvisStudioProposal,
} from "@/lib/jarvis-api";
import {
  clampZoom,
  clientToWorld,
  dropTarget,
  hitNode,
  zoomAtPoint,
  type DropTarget,
  type Point,
} from "@/lib/jarvis-org-canvas";
import {
  activityDotClass,
  activityHeartbeat,
  groupFleet,
  layoutReportingTree,
  skillsForPrincipal,
} from "@/lib/jarvis-org-map";
import { cn } from "@/lib/utils";

type JarvisStudioProps = {
  token: string;
  onClose: () => void;
  onInstantiated: () => void;
};

type StudioTab = "agents" | "organization";

function nodeIcon(kind: string, role: string) {
  const hay = `${kind} ${role}`.toLowerCase();
  if (kind === "human") {
    return User;
  }
  if (hay.includes("sales") || hay.includes("lead")) {
    return TrendingUp;
  }
  if (hay.includes("support") || hay.includes("cx") || hay.includes("customer")) {
    return Headphones;
  }
  if (kind === "unit") {
    return Building2;
  }
  return Bot;
}

function applyGraph(
  graph: { nodes: JarvisGraphNode[]; edges: JarvisGraphEdge[] },
  setNodes: (nodes: JarvisGraphNode[]) => void,
  setEdges: (edges: JarvisGraphEdge[]) => void,
) {
  setNodes(graph.nodes);
  setEdges(graph.edges);
}

export function JarvisStudio({ token, onClose, onInstantiated }: JarvisStudioProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<StudioTab>("agents");
  const [brief, setBrief] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [templates, setTemplates] = useState<string[]>([]);
  const [liveNodes, setLiveNodes] = useState<JarvisGraphNode[]>([]);
  const [liveEdges, setLiveEdges] = useState<JarvisGraphEdge[]>([]);
  const [agents, setAgents] = useState<JarvisAgent[]>([]);
  const [gaps, setGaps] = useState<JarvisCapabilityGap[]>([]);
  const [connectors, setConnectors] = useState<JarvisStudioConnector[]>([]);
  const [customTools, setCustomTools] = useState<JarvisStudioCustomTool[]>([]);
  const [connectorName, setConnectorName] = useState("");
  const [connectorOrigin, setConnectorOrigin] = useState("https://");
  const [connectorPurpose, setConnectorPurpose] = useState<"shop" | "outbound">("shop");
  const [connectorSecret, setConnectorSecret] = useState("");
  const [connectorToolId, setConnectorToolId] = useState("");
  const [customToolId, setCustomToolId] = useState("customers.find_churned");
  const [customStepToolId, setCustomStepToolId] = useState("");
  const [proposal, setProposal] = useState<JarvisStudioProposal | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [managerId, setManagerId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [addName, setAddName] = useState("");
  const [skillName, setSkillName] = useState("");
  const [addSkillId, setAddSkillId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 24, y: 24 });
  const [drag, setDrag] = useState<null | {
    mode: "pan" | "node";
    id?: string;
    start: Point;
    last: Point;
    moved: boolean;
  }>(null);
  const [hoverTarget, setHoverTarget] = useState<DropTarget | null>(null);
  const [ghost, setGhost] = useState<Point | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const live = !proposal || proposal.status === "instantiated";
  const nodes = live ? liveNodes : (proposal?.nodes ?? liveNodes);
  const edges = live ? liveEdges : (proposal?.edges ?? liveEdges);

  const refresh = async () => {
    const [snapshot, agentList] = await Promise.all([getJarvisStudio(token), listJarvisAgents(token)]);
    setLiveNodes(snapshot.nodes);
    setLiveEdges(snapshot.edges);
    setGaps(snapshot.gaps);
    setConnectors(snapshot.connectors ?? []);
    setCustomTools(snapshot.customTools ?? []);
    setAgents(agentList.items);
    return snapshot;
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [snapshot, templateList, agentList] = await Promise.all([
          getJarvisStudio(token),
          listJarvisStudioTemplates(token),
          listJarvisAgents(token),
        ]);
        if (cancelled) {
          return;
        }
        setLiveNodes(snapshot.nodes);
        setLiveEdges(snapshot.edges);
        setGaps(snapshot.gaps);
        setConnectors(snapshot.connectors ?? []);
        setCustomTools(snapshot.customTools ?? []);
        setTemplates(templateList.items.map((item) => item.id));
        setAgents(agentList.items);
        const hasGraph = snapshot.edges.some((edge) => edge.kind === "reports_to" || edge.kind === "member_of");
        setTab(hasGraph ? "organization" : "agents");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("jarvis.studio.loadFailed"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  const fleet = useMemo(() => groupFleet(nodes, edges, agents), [nodes, edges, agents]);
  const layout = useMemo(() => layoutReportingTree(nodes, edges, agents), [nodes, edges, agents]);
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  const people = nodes.filter((node) => node.kind === "human" || node.kind === "agent");
  const units = nodes.filter((node) => node.kind === "unit");
  const assignedSkills = selected ? skillsForPrincipal(nodes, edges, selected.id) : [];
  const unusedSkills = nodes.filter(
    (node) => node.kind === "skill" && !assignedSkills.some((row) => row.skillId === node.id),
  );

  useEffect(() => {
    if (!selected) {
      return;
    }
    setNameDraft(selected.label);
    setManagerId(edges.find((edge) => edge.kind === "reports_to" && edge.fromId === selected.id)?.toId ?? "");
    setUnitId(edges.find((edge) => edge.kind === "member_of" && edge.fromId === selected.id)?.toId ?? "");
  }, [selected, edges]);

  const propose = async () => {
    if (!brief.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createJarvisStudioProposal(token, brief.trim(), templateId || undefined);
      setProposal(created.proposal);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("jarvis.studio.proposeFailed"));
    } finally {
      setBusy(false);
    }
  };

  const reparentToMe = async () => {
    if (!proposal || busy) {
      return;
    }
    const me = proposal.nodes.find((node) => node.kind === "human")?.id;
    if (!me) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextEdges = proposal.edges.map((edge) =>
        edge.kind === "reports_to" ? { ...edge, toId: me } : edge,
      );
      const updated = await patchJarvisStudioProposal(token, proposal.id, { edges: nextEdges });
      setProposal(updated.proposal);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("jarvis.studio.editFailed"));
    } finally {
      setBusy(false);
    }
  };

  const instantiate = async () => {
    if (!proposal || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await instantiateJarvisStudioProposal(token, proposal.id);
      setProposal(null);
      applyGraph(result.graph, setLiveNodes, setLiveEdges);
      setGaps(result.gaps);
      const agentList = await listJarvisAgents(token);
      setAgents(agentList.items);
      onInstantiated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("jarvis.studio.instantiateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const saveSelected = async () => {
    if (!live || !selected || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (selected.kind === "unit") {
        const result = await patchJarvisStudioUnit(token, selected.id, {
          name: nameDraft.trim() || selected.label,
          parentUnitId: unitId || null,
        });
        applyGraph(result.graph, setLiveNodes, setLiveEdges);
        setProposal(null);
      } else {
        if (nameDraft.trim() && nameDraft.trim() !== selected.label) {
          const renamed = await patchJarvisStudioPrincipal(token, selected.id, nameDraft.trim());
          applyGraph(renamed.graph, setLiveNodes, setLiveEdges);
        }
        if (managerId) {
          const replaced = await replaceJarvisReportsTo(token, selected.id, managerId);
          applyGraph(replaced.graph, setLiveNodes, setLiveEdges);
        }
        const current = edges.find((edge) => edge.kind === "member_of" && edge.fromId === selected.id);
        if (current && current.toId !== unitId) {
          const removed = await deleteJarvisStudioRelationship(token, current.id);
          applyGraph(removed.graph, setLiveNodes, setLiveEdges);
        }
        if (unitId && current?.toId !== unitId) {
          const added = await writeJarvisStudioRelationships(token, [
            { kind: "member_of", fromId: selected.id, toId: unitId },
          ]);
          applyGraph(added.graph, setLiveNodes, setLiveEdges);
        }
        setProposal(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("jarvis.studio.editFailed"));
    } finally {
      setBusy(false);
    }
  };

  const assignFromDrop = async (fromId: string, target: DropTarget) => {
    if (!live || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (target.kind === "person") {
        const current = edges.find((edge) => edge.kind === "reports_to" && edge.fromId === fromId);
        if (current?.toId === target.id) {
          return;
        }
        const replaced = await replaceJarvisReportsTo(token, fromId, target.id);
        applyGraph(replaced.graph, setLiveNodes, setLiveEdges);
      } else {
        const current = edges.find((edge) => edge.kind === "member_of" && edge.fromId === fromId);
        if (current?.toId !== target.id) {
          if (current) {
            const removed = await deleteJarvisStudioRelationship(token, current.id);
            applyGraph(removed.graph, setLiveNodes, setLiveEdges);
          }
          const added = await writeJarvisStudioRelationships(token, [
            { kind: "member_of", fromId, toId: target.id },
          ]);
          applyGraph(added.graph, setLiveNodes, setLiveEdges);
        }
      }
      setProposal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("jarvis.studio.editFailed"));
    } finally {
      setBusy(false);
    }
  };

  const worldPoint = (client: Point) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: 0, y: 0 };
    }
    return clientToWorld(client, rect, pan, zoom);
  };

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || tab !== "organization") {
      return;
    }
    const onWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const next = zoomAtPoint(
        zoom,
        event.deltaY < 0 ? 1.1 : 1 / 1.1,
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        pan,
      );
      setZoom(next.zoom);
      setPan(next.pan);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [tab, zoom, pan]);

  const onCanvasPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const client = { x: event.clientX, y: event.clientY };
    const node = hitNode(layout.nodes, worldPoint(client));
    if (node && (node.kind === "human" || node.kind === "agent") && live && !busy) {
      setDrag({ mode: "node", id: node.id, start: client, last: client, moved: false });
      setGhost(worldPoint(client));
      return;
    }
    if (node) {
      setSelectedId(node.id);
      return;
    }
    setDrag({ mode: "pan", start: client, last: client, moved: false });
  };

  const onCanvasPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) {
      return;
    }
    const client = { x: event.clientX, y: event.clientY };
    const moved =
      drag.moved || Math.abs(client.x - drag.start.x) + Math.abs(client.y - drag.start.y) > 4;
    if (drag.mode === "pan") {
      setPan({
        x: pan.x + client.x - drag.last.x,
        y: pan.y + client.y - drag.last.y,
      });
      setDrag({ ...drag, last: client, moved });
      return;
    }
    const world = worldPoint(client);
    setGhost(world);
    setHoverTarget(drag.id ? dropTarget(world, layout.nodes, layout.regions, drag.id) : null);
    setDrag({ ...drag, last: client, moved });
  };

  const onCanvasPointerUp = () => {
    if (drag?.mode === "node" && drag.id) {
      if (drag.moved && hoverTarget) {
        void assignFromDrop(drag.id, hoverTarget);
      } else if (!drag.moved) {
        setSelectedId(drag.id);
      }
    }
    setDrag(null);
    setGhost(null);
    setHoverTarget(null);
  };

  const removeSelected = async () => {
    if (!live || !selected || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (selected.kind === "unit") {
        const result = await deleteJarvisStudioUnit(token, selected.id);
        applyGraph(result.graph, setLiveNodes, setLiveEdges);
      } else {
        const reports = edges.find((edge) => edge.kind === "reports_to" && edge.fromId === selected.id);
        if (reports) {
          const result = await deleteJarvisStudioRelationship(token, reports.id);
          applyGraph(result.graph, setLiveNodes, setLiveEdges);
        }
      }
      setSelectedId(null);
      setProposal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("jarvis.studio.editFailed"));
    } finally {
      setBusy(false);
    }
  };

  const attachSkill = async (skillId: string) => {
    if (!live || !selected || selected.kind !== "agent" || !skillId || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await writeJarvisStudioRelationships(token, [
        { kind: "has_skill", fromId: selected.id, toId: skillId },
      ]);
      applyGraph(result.graph, setLiveNodes, setLiveEdges);
      setAddSkillId("");
      setSkillName("");
      setProposal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("jarvis.studio.editFailed"));
    } finally {
      setBusy(false);
    }
  };

  const createAndAttachSkill = async () => {
    if (!live || !selected || selected.kind !== "agent" || !skillName.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createJarvisStudioSkills(token, [{ name: skillName.trim() }]);
      applyGraph(created.graph, setLiveNodes, setLiveEdges);
      const skillId = created.results[0]?.id;
      if (skillId) {
        const result = await writeJarvisStudioRelationships(token, [
          { kind: "has_skill", fromId: selected.id, toId: skillId },
        ]);
        applyGraph(result.graph, setLiveNodes, setLiveEdges);
      }
      setSkillName("");
      setProposal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("jarvis.studio.editFailed"));
    } finally {
      setBusy(false);
    }
  };

  const removeSkill = async (edgeId: string) => {
    if (!live || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await deleteJarvisStudioRelationship(token, edgeId);
      applyGraph(result.graph, setLiveNodes, setLiveEdges);
      setProposal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("jarvis.studio.editFailed"));
    } finally {
      setBusy(false);
    }
  };

  const addAgent = async () => {
    if (!live || !addName.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createJarvisAgent(token, addName.trim());
      const principals = await listJarvisPrincipals(token);
      const principal = principals.items.find((item) => item.agentId === created.agent.id);
      const items: Array<{ kind: string; fromId: string; toId: string }> = [];
      if (principal && managerId) {
        items.push({ kind: "reports_to", fromId: principal.id, toId: managerId });
      }
      if (principal && unitId) {
        items.push({ kind: "member_of", fromId: principal.id, toId: unitId });
      }
      if (items.length > 0) {
        const result = await writeJarvisStudioRelationships(token, items);
        applyGraph(result.graph, setLiveNodes, setLiveEdges);
      } else {
        await refresh();
      }
      setAddName("");
      setProposal(null);
      onInstantiated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("jarvis.studio.editFailed"));
    } finally {
      setBusy(false);
    }
  };

  const addUnit = async () => {
    if (!live || !addName.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createJarvisStudioUnits(token, [
        { name: addName.trim(), type: "department", parentUnitId: unitId || null },
      ]);
      applyGraph(result.graph, setLiveNodes, setLiveEdges);
      setAddName("");
      setProposal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("jarvis.studio.editFailed"));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (status: string) => t(`jarvis.studio.status.${status}`, status);

  return (
    <aside className="absolute inset-0 z-20 flex flex-col bg-[#070b14]">
      <header className="flex items-center justify-between gap-4 border-b border-white/10 px-6 py-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-primary-glow)]">
            {t("jarvis.studio.title")}
          </p>
          <h2 className="mt-1 text-lg font-semibold">{t("jarvis.studio.subtitle")}</h2>
        </div>
        <div className="flex items-center gap-2">
          {(["agents", "organization"] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs",
                tab === id
                  ? "bg-[var(--color-primary-glow)] text-black"
                  : "border border-white/15 text-white/80 hover:bg-white/10",
              )}
              onClick={() => setTab(id)}
            >
              {t(`jarvis.studio.tab.${id}`)}
            </button>
          ))}
          <button
            type="button"
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
            onClick={onClose}
          >
            {t("jarvis.studio.close")}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1",
            tab === "organization" ? "relative overflow-hidden" : "overflow-auto p-6",
          )}
        >
          {tab === "agents" ? (
            fleet.length === 0 && units.length === 0 ? (
              <p className="text-sm text-white/50">{t("jarvis.studio.emptyFleet")}</p>
            ) : (
              <div className="space-y-8">
                {fleet.map((section) => (
                  <section key={section.id}>
                    <h3 className="mb-3 text-[11px] uppercase tracking-[0.18em] text-white/40">
                      {section.kind === "core"
                        ? t("jarvis.studio.core")
                        : section.kind === "unassigned"
                          ? t("jarvis.studio.unassigned")
                          : section.title}
                    </h3>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {section.cards.map((card) => {
                        const Icon = nodeIcon(card.agentId ? "agent" : "human", card.role);
                        return (
                          <button
                            key={card.nodeId}
                            type="button"
                            onClick={() => setSelectedId(card.nodeId)}
                            className={cn(
                              "rounded-2xl border bg-black/30 p-4 text-left",
                              selectedId === card.nodeId
                                ? "border-[var(--color-primary-glow)]"
                                : "border-white/10 hover:border-white/25",
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-center gap-3">
                                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 text-[var(--color-primary-glow)]">
                                  <Icon size={18} />
                                </span>
                                <div>
                                  <p className="text-sm font-medium">{card.name}</p>
                                  <p className="text-xs text-white/45">{card.role}</p>
                                </div>
                              </div>
                              <span className={cn("h-2.5 w-2.5 rounded-full", activityDotClass(card.status))} />
                            </div>
                            <p className="mt-3 text-[11px] uppercase tracking-wide text-white/35">
                              {statusLabel(card.status)}
                            </p>
                            <p className="mt-1 truncate text-sm text-white/80">{card.title ?? "—"}</p>
                            <div className="mt-3 flex justify-between text-[11px] text-white/40">
                              <span>
                                {t("jarvis.studio.heartbeat")}: {activityHeartbeat(card.status)}
                              </span>
                              <span>{card.model ?? "—"}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
                {units.length > 0 && (
                  <section>
                    <h3 className="mb-3 text-[11px] uppercase tracking-[0.18em] text-white/40">
                      {t("jarvis.studio.units")}
                    </h3>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {units.map((unit) => (
                        <button
                          key={unit.id}
                          type="button"
                          onClick={() => setSelectedId(unit.id)}
                          className={cn(
                            "rounded-2xl border bg-black/30 p-4 text-left",
                            selectedId === unit.id
                              ? "border-[var(--color-primary-glow)]"
                              : "border-white/10 hover:border-white/25",
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 text-[var(--color-primary-glow)]">
                              <Building2 size={18} />
                            </span>
                            <div>
                              <p className="text-sm font-medium">{unit.label}</p>
                              <p className="text-xs text-white/45">{unit.meta?.unitType ?? t("jarvis.studio.unit")}</p>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )
          ) : layout.nodes.length === 0 ? (
            <p className="p-6 text-sm text-white/50">{t("jarvis.studio.emptyMap")}</p>
          ) : (
            <div
              ref={canvasRef}
              className={cn(
                "absolute inset-0 touch-none",
                drag?.mode === "pan" ? "cursor-grabbing" : drag?.mode === "node" ? "cursor-grabbing" : "cursor-grab",
              )}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
              role="img"
              aria-label={t("jarvis.studio.tab.organization")}
            >
              <svg className="h-full w-full">
                <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
                  {layout.regions.map((region) => {
                    const active = hoverTarget?.kind === "unit" && hoverTarget.id === region.unitId;
                    return (
                      <g key={region.unitId}>
                        <rect
                          x={region.x}
                          y={region.y}
                          width={region.width}
                          height={region.height}
                          rx={18}
                          fill={`${region.color}14`}
                          stroke={region.color}
                          strokeOpacity={active ? 0.95 : 0.45}
                          strokeWidth={active ? 2 : 1}
                        />
                        <text
                          x={region.x + 16}
                          y={region.y + 22}
                          fill={region.color}
                          fontSize={11}
                          letterSpacing={1.6}
                        >
                          {region.label.toUpperCase()}
                        </text>
                      </g>
                    );
                  })}
                  {layout.connectors.map((edge) => (
                    <path
                      key={edge.id}
                      d={edge.d}
                      fill="none"
                      stroke="var(--color-primary-glow)"
                      strokeWidth={edge.pulse ? 2 : 1.25}
                      strokeOpacity={edge.pulse ? 0.95 : 0.45}
                      strokeDasharray={edge.pulse ? "6 8" : undefined}
                      className={edge.pulse ? "animate-[jarvisDash_1.2s_linear_infinite]" : undefined}
                    />
                  ))}
                  {layout.nodes.map((node) => {
                    const Icon = nodeIcon(node.kind, node.role);
                    const active = hoverTarget?.id === node.id;
                    return (
                      <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
                        <rect
                          width={node.width}
                          height={node.height}
                          rx={14}
                          fill="#0b1220"
                          stroke={
                            active || selectedId === node.id
                              ? "var(--color-primary-glow)"
                              : "rgba(255,255,255,0.12)"
                          }
                          strokeWidth={active ? 2 : 1}
                        />
                        <foreignObject width={node.width} height={node.height}>
                          <div className="flex h-full flex-col justify-center px-3 py-2 text-left">
                            <div className="flex items-center gap-2">
                              <Icon size={14} className="text-[var(--color-primary-glow)]" />
                              <span className="truncate text-xs font-medium text-white">{node.label}</span>
                              <span
                                className={cn("ml-auto h-2 w-2 rounded-full", activityDotClass(node.status))}
                              />
                            </div>
                            <p className="truncate text-[10px] text-white/45">{node.role}</p>
                            {node.kind !== "unit" && (
                              <p className="truncate text-[10px] uppercase text-white/50">
                                {statusLabel(node.status)}
                              </p>
                            )}
                            {node.title && <p className="truncate text-[10px] text-white/70">{node.title}</p>}
                          </div>
                        </foreignObject>
                      </g>
                    );
                  })}
                  {ghost && drag?.id && (() => {
                    const node = layout.nodes.find((item) => item.id === drag.id);
                    if (!node) {
                      return null;
                    }
                    const Icon = nodeIcon(node.kind, node.role);
                    return (
                      <g transform={`translate(${ghost.x - node.width / 2} ${ghost.y - node.height / 2})`} opacity={0.7}>
                        <rect
                          width={node.width}
                          height={node.height}
                          rx={14}
                          fill="#0b1220"
                          stroke="var(--color-primary-glow)"
                        />
                        <foreignObject width={node.width} height={node.height}>
                          <div className="flex h-full items-center gap-2 px-3 text-left">
                            <Icon size={14} className="text-[var(--color-primary-glow)]" />
                            <span className="truncate text-xs font-medium text-white">{node.label}</span>
                          </div>
                        </foreignObject>
                      </g>
                    );
                  })()}
                </g>
              </svg>
              <div
                className="absolute left-4 top-4 flex items-center gap-1 rounded-lg border border-white/15 bg-[#0b1220]/90 p-1"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="rounded-md p-1.5 text-white/80 hover:bg-white/10"
                  aria-label={t("jarvis.studio.zoomOut")}
                  onClick={() => setZoom((value) => clampZoom(value / 1.15))}
                >
                  <Minus size={14} />
                </button>
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-[11px] text-white/70 hover:bg-white/10"
                  aria-label={t("jarvis.studio.zoomReset")}
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 24, y: 24 });
                  }}
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  className="rounded-md p-1.5 text-white/80 hover:bg-white/10"
                  aria-label={t("jarvis.studio.zoomIn")}
                  onClick={() => setZoom((value) => clampZoom(value * 1.15))}
                >
                  <Plus size={14} />
                </button>
              </div>
              {drag?.mode === "node" && hoverTarget && (
                <p className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-[#0b1220]/90 px-3 py-1 text-[11px] text-white/70">
                  {t("jarvis.studio.dropAssign")}
                </p>
              )}
            </div>
          )}
        </div>

        <aside className="w-80 shrink-0 overflow-y-auto border-l border-white/10 bg-[#0b1220] p-4">
          <h3 className="text-xs uppercase tracking-wide text-white/45">{t("jarvis.studio.inspector")}</h3>
          {!live && <p className="mt-2 text-xs text-amber-200/80">{t("jarvis.studio.draftReadonly")}</p>}
          {selected ? (
            <div className="mt-3 space-y-3">
              <label className="block text-[11px] uppercase text-white/40" htmlFor="studio-name">
                {t("jarvis.studio.name")}
              </label>
              <input
                id="studio-name"
                value={nameDraft}
                disabled={!live}
                onChange={(event) => setNameDraft(event.target.value)}
                className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
              />
              {selected.kind !== "unit" && (
                <>
                  <label className="block text-[11px] uppercase text-white/40" htmlFor="studio-manager">
                    {t("jarvis.studio.manager")}
                  </label>
                  <select
                    id="studio-manager"
                    value={managerId}
                    disabled={!live}
                    onChange={(event) => setManagerId(event.target.value)}
                    className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
                  >
                    <option value="">{t("jarvis.studio.unassigned")}</option>
                    {people
                      .filter((node) => node.id !== selected.id)
                      .map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.label}
                        </option>
                      ))}
                  </select>
                </>
              )}
              <label className="block text-[11px] uppercase text-white/40" htmlFor="studio-unit">
                {selected.kind === "unit" ? t("jarvis.studio.parent") : t("jarvis.studio.unit")}
              </label>
              <select
                id="studio-unit"
                value={unitId}
                disabled={!live}
                onChange={(event) => setUnitId(event.target.value)}
                className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
              >
                <option value="">{t("jarvis.studio.unassigned")}</option>
                {units
                  .filter((node) => node.id !== selected.id)
                  .map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.label}
                    </option>
                  ))}
              </select>
              {selected.kind === "agent" && (
                <div className="space-y-2">
                  <p className="text-[11px] uppercase text-white/40">{t("jarvis.studio.skills")}</p>
                  {assignedSkills.length === 0 ? (
                    <p className="text-xs text-white/40">{t("jarvis.studio.unassigned")}</p>
                  ) : (
                    <ul className="space-y-1">
                      {assignedSkills.map((row) => (
                        <li
                          key={row.skillId}
                          className="flex items-center justify-between gap-2 rounded-lg border border-white/10 px-2 py-1.5"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm">{row.name}</span>
                            {row.viaRole && (
                              <span className="block truncate text-[11px] text-white/40">
                                {t("jarvis.studio.viaRole", { role: row.viaRole })}
                              </span>
                            )}
                          </span>
                          {live && row.edgeId && (
                            <button
                              type="button"
                              disabled={busy}
                              className="shrink-0 text-[11px] text-white/50 hover:text-white disabled:opacity-40"
                              onClick={() => void removeSkill(row.edgeId!)}
                            >
                              {t("jarvis.studio.delete")}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {live && (
                    <>
                      {unusedSkills.length > 0 && (
                        <select
                          id="studio-add-skill"
                          value={addSkillId}
                          disabled={busy}
                          onChange={(event) => {
                            const next = event.target.value;
                            setAddSkillId(next);
                            if (next) {
                              void attachSkill(next);
                            }
                          }}
                          className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
                        >
                          <option value="">{t("jarvis.studio.addSkill")}</option>
                          {unusedSkills.map((node) => (
                            <option key={node.id} value={node.id}>
                              {node.label}
                            </option>
                          ))}
                        </select>
                      )}
                      <div className="flex gap-2">
                        <input
                          value={skillName}
                          disabled={busy}
                          onChange={(event) => setSkillName(event.target.value)}
                          placeholder={t("jarvis.studio.addSkill")}
                          className="h-9 min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
                        />
                        <button
                          type="button"
                          disabled={busy || !skillName.trim()}
                          className="rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                          onClick={() => void createAndAttachSkill()}
                        >
                          {t("jarvis.studio.addSkill")}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
              {live && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-lg bg-[var(--color-primary-glow)] px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40"
                    onClick={() => void saveSelected()}
                  >
                    {t("jarvis.studio.save")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                    onClick={() => void removeSelected()}
                  >
                    {t("jarvis.studio.delete")}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm text-white/40">{t("jarvis.studio.inspectorEmpty")}</p>
          )}

          {live && (
            <div className="mt-8 space-y-2 border-t border-white/10 pt-4">
              <input
                value={addName}
                onChange={(event) => setAddName(event.target.value)}
                placeholder={t("jarvis.studio.addName")}
                className="h-9 w-full rounded-lg border border-white/15 bg-black/40 px-3 text-sm"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy || !addName.trim()}
                  className="rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                  onClick={() => void addAgent()}
                >
                  {t("jarvis.studio.addAgent")}
                </button>
                <button
                  type="button"
                  disabled={busy || !addName.trim()}
                  className="rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                  onClick={() => void addUnit()}
                >
                  {t("jarvis.studio.addUnit")}
                </button>
              </div>
            </div>
          )}

          {gaps.length > 0 && (
            <div className="mt-6">
              <h3 className="text-xs uppercase tracking-wide text-white/50">{t("jarvis.studio.gaps")}</h3>
              <ul className="mt-2 space-y-2 text-xs text-amber-200/90">
                {gaps.map((gap) => (
                  <li key={`${gap.agentId}:${gap.toolId}:${gap.requiredBy}`}>
                    {gap.requiredBy === "connector"
                      ? t("jarvis.studio.gapConnector", { tool: gap.toolId })
                      : gap.requiredBy === "capability_version"
                        ? t("jarvis.studio.gapVersion", { tool: gap.toolId })
                        : t("jarvis.studio.gapItem", { role: gap.agentName, tool: gap.toolId })}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-6 space-y-3">
            <h3 className="text-xs uppercase tracking-wide text-white/50">{t("jarvis.studio.connectors")}</h3>
            {connectors.length === 0 && (
              <p className="text-xs text-white/40">{t("jarvis.studio.connectorsEmpty")}</p>
            )}
            <ul className="space-y-1 text-xs text-white/70">
              {connectors.map((row) => (
                <li key={row.id}>
                  {row.name} · {row.purpose ?? row.kind} · r{row.revision}
                </li>
              ))}
            </ul>
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!connectorName.trim() || !connectorSecret.trim() || !connectorToolId.trim()) {
                  return;
                }
                void (async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await attachJarvisConnectors(token, [
                      {
                        kind: "openapi",
                        name: connectorName.trim(),
                        purpose: connectorPurpose,
                        origin: connectorOrigin.trim(),
                        credential: {
                          label: connectorName.trim(),
                          kind: "bearer",
                          secret: connectorSecret,
                        },
                        operations: [
                          {
                            toolId: connectorToolId.trim(),
                            risk: connectorPurpose === "outbound" ? "external_write" : "low",
                            binding: { method: connectorPurpose === "outbound" ? "POST" : "GET", path: "/" },
                          },
                        ],
                      },
                    ]);
                    setConnectorSecret("");
                    await refresh();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : t("jarvis.studio.editFailed"));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              <input
                value={connectorName}
                onChange={(event) => setConnectorName(event.target.value)}
                placeholder={t("jarvis.studio.connectorName")}
                className="h-8 w-full rounded-md border border-white/15 bg-black/40 px-2 text-xs outline-none"
              />
              <input
                value={connectorOrigin}
                onChange={(event) => setConnectorOrigin(event.target.value)}
                placeholder={t("jarvis.studio.connectorOrigin")}
                className="h-8 w-full rounded-md border border-white/15 bg-black/40 px-2 text-xs outline-none"
              />
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={connectorPurpose}
                  onChange={(event) => setConnectorPurpose(event.target.value as "shop" | "outbound")}
                  className="h-8 rounded-md border border-white/15 bg-black/40 px-2 text-xs"
                >
                  <option value="shop">{t("jarvis.studio.purposeShop")}</option>
                  <option value="outbound">{t("jarvis.studio.purposeOutbound")}</option>
                </select>
                <input
                  value={connectorToolId}
                  onChange={(event) => setConnectorToolId(event.target.value)}
                  placeholder={t("jarvis.studio.connectorToolId")}
                  className="h-8 rounded-md border border-white/15 bg-black/40 px-2 text-xs outline-none"
                />
              </div>
              <input
                type="password"
                value={connectorSecret}
                onChange={(event) => setConnectorSecret(event.target.value)}
                placeholder={t("jarvis.studio.connectorSecret")}
                className="h-8 w-full rounded-md border border-white/15 bg-black/40 px-2 text-xs outline-none"
              />
              <button
                type="submit"
                disabled={busy}
                className="h-8 rounded-md bg-[var(--color-primary-glow)] px-3 text-xs font-medium disabled:opacity-40"
              >
                {t("jarvis.studio.attachConnector")}
              </button>
            </form>
            <h3 className="pt-2 text-xs uppercase tracking-wide text-white/50">{t("jarvis.studio.customTools")}</h3>
            <ul className="space-y-1 text-xs text-white/70">
              {customTools.map((row) => (
                <li key={row.id}>
                  {row.toolId} · {row.risk}
                </li>
              ))}
            </ul>
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!customToolId.trim() || !customStepToolId.trim()) {
                  return;
                }
                void (async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await saveJarvisCustomTools(token, [
                      {
                        toolId: customToolId.trim(),
                        definition: {
                          steps: [{ toolId: customStepToolId.trim(), version: 1 }],
                          groupBy: ["country", "language"],
                        },
                      },
                    ]);
                    await refresh();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : t("jarvis.studio.editFailed"));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              <input
                value={customToolId}
                onChange={(event) => setCustomToolId(event.target.value)}
                placeholder={t("jarvis.studio.customToolId")}
                className="h-8 w-full rounded-md border border-white/15 bg-black/40 px-2 text-xs outline-none"
              />
              <input
                value={customStepToolId}
                onChange={(event) => setCustomStepToolId(event.target.value)}
                placeholder={t("jarvis.studio.customStepToolId")}
                className="h-8 w-full rounded-md border border-white/15 bg-black/40 px-2 text-xs outline-none"
              />
              <button
                type="submit"
                disabled={busy}
                className="h-8 rounded-md border border-white/15 px-3 text-xs disabled:opacity-40"
              >
                {t("jarvis.studio.attachCustomTool")}
              </button>
            </form>
          </div>
        </aside>
      </div>

      <footer className="border-t border-white/10 px-6 py-3">
        <button
          type="button"
          className="text-xs text-white/60 hover:text-white"
          onClick={() => setBriefOpen((open) => !open)}
        >
          {t("jarvis.studio.generateFromBrief")}
        </button>
        {briefOpen && (
          <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-end">
            <textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder={t("jarvis.studio.briefPlaceholder")}
              className="h-20 w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm"
            />
            <select
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
              className="h-10 rounded-xl border border-white/15 bg-black/40 px-3 text-sm"
            >
              <option value="">{t("jarvis.studio.templateAuto")}</option>
              {templates.map((id) => (
                <option key={id} value={id}>
                  {id.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !brief.trim()}
                className="rounded-lg bg-[var(--color-primary-glow)] px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40"
                onClick={() => void propose()}
              >
                {t("jarvis.studio.propose")}
              </button>
              <button
                type="button"
                disabled={busy || !proposal || proposal.status === "instantiated"}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                onClick={() => void reparentToMe()}
              >
                {t("jarvis.studio.reparentToMe")}
              </button>
              <button
                type="button"
                disabled={busy || !proposal || proposal.status === "instantiated"}
                className="rounded-lg border border-white/20 px-3 py-1.5 text-xs disabled:opacity-40"
                onClick={() => void instantiate()}
              >
                {t("jarvis.studio.instantiate")}
              </button>
            </div>
          </div>
        )}
        {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
      </footer>
      <style>{`@keyframes jarvisDash { to { stroke-dashoffset: -24; } }`}</style>
    </aside>
  );
}
