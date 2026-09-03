import { cosine, embedText, sha256Hex } from "./crypto.ts";
import { id } from "./ids.ts";
import { principalForAgent } from "./org-graph.ts";
import { presentedRegistryTools, resolveToolDef } from "./registry.ts";
import { effectiveTools, grantedToolsForAgent } from "./studio-access.ts";
import type { JarvisStore } from "./store.ts";
import { TOOLS } from "./tools.ts";
import type {
  ActionOutcome,
  AgentVersion,
  ContextCompilation,
  ContextProvenance,
  LayerUsage,
  Memory,
  Message,
  ProvenanceReason,
  Run,
  SkillVersion,
  Task,
} from "./types.ts";

export const COMPILER_VERSION = "1";

export const CONTEXT_BUDGETS = {
  platform: 8_000,
  identity: 4_000,
  skills: 15_000,
  task: 8_000,
  conversation: 20_000,
  memory: 15_000,
  actions: 10_000,
  org: 5_000,
  tools: 10_000,
  output: 5_000,
} as const;

const PLATFORM = `You are Jarvis, an Envia desktop AI worker.
Follow the execution protocol: return JSON {"text": string, "tool"?: string, "arguments"?: object}.
text is the final human answer. If you need a tool, call it now. Never say you will do something later.
Never grant yourself tools. Never invent tool ids. Denied and privileged tools are unavailable.
Use only tools listed under Access. Prefer remember/recall for durable facts.
If the job needs an external product (shop, email, chat, calendar, or any API), call integrations.status then integrations.connect. Never ask the user for a spreadsheet dump or to browse an admin for you.
For memory.remember, put the fact in arguments.content.
For assigned work, use task.update_current or task.complete_current. Do not invent a taskId.`;

export type CompiledContext = {
  layers: Record<string, string>;
  prompt: string;
  presentedTools: string[];
  usage: Record<string, LayerUsage>;
  provenance: ContextProvenance[];
};

export type BuildContextInput = {
  store: JarvisStore;
  version: AgentVersion;
  userId: string;
  prompt: string;
  run?: Run;
  task?: Task | null;
};

function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function trimToBudget(text: string, budget: number): string {
  const maxChars = budget * 4;
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 16).trim()}\n[trimmed]`;
}

function layer(name: string, body: string, budget: number): string {
  if (!body.trim()) {
    return "";
  }
  return trimToBudget(`## ${name}\n${body.trim()}`, budget);
}

function skillBlock(skillName: string, version: SkillVersion): string {
  return [
    `${skillName}@v${version.version}`,
    `Purpose:\n${version.instructions}`,
    `Required tools:\n${version.requiredTools.join(", ") || "none"}`,
  ].join("\n");
}

function rankByPrompt<T>(items: T[], prompt: string, textOf: (item: T) => string): T[] {
  const query = embedText(prompt);
  return [...items]
    .map((item) => ({
      item,
      score:
        cosine(embedText(textOf(item)), query) +
        (textOf(item).toLowerCase().includes(prompt.toLowerCase()) ? 0.2 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}

function addProvenance(
  rows: ContextProvenance[],
  layerName: string,
  kind: string,
  itemId: string,
  reason: ProvenanceReason,
) {
  rows.push({ layer: layerName, kind, id: itemId, reason });
}

function workText(store: JarvisStore, task: Task): string {
  const objective = task.objectiveId ? store.objectives.get(task.objectiveId) : undefined;
  const assignee = task.assigneePrincipalId
    ? store.principals.get(task.assigneePrincipalId)
    : undefined;
  const project = task.projectUnitId ? store.units.get(task.projectUnitId) : undefined;
  return [
    `Title: ${task.name}`,
    task.description ? `Description: ${task.description}` : "",
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    assignee ? `Assignee: ${assignee.displayName}` : "",
    objective ? `Objective: ${objective.name}` : "",
    project ? `Project: ${project.name}` : "",
    task.resultSummary ? `Previous result: ${task.resultSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildContext(input: BuildContextInput): CompiledContext {
  const { store, version, userId, prompt, run } = input;
  const provenance: ContextProvenance[] = [];
  const agent = store.agents.get(version.agentId);
  const orgId = agent?.orgId ?? run?.orgId ?? "";
  const granted = grantedToolsForAgent(store, orgId, version.agentId);
  const firstParty = effectiveTools(version.requestedToolIds, granted).filter((toolId) => {
    const def = TOOLS[toolId];
    return Boolean(def) && !def.privileged && def.risk !== "privileged";
  });
  const registry = presentedRegistryTools(store, orgId, granted).filter((toolId) => {
    const def = resolveToolDef(store, orgId, toolId);
    return Boolean(def) && !def.privileged && def.risk !== "privileged";
  });
  const presentedTools = [...new Set([...firstParty, ...registry])];
  for (const toolId of presentedTools) {
    addProvenance(provenance, "access", "tool", toolId, "granted");
  }

  const identityLines = [
    agent ? `You are @${agent.handle} (${agent.name}).` : version.identity,
    version.identity,
    version.jobs,
    ...version.responsibilities,
  ].filter(Boolean);
  if (agent) {
    addProvenance(provenance, "identity", "agent", agent.id, "identity");
  }
  addProvenance(provenance, "identity", "agent_version", version.id, "identity");

  const skillVersions = version.skillVersionIds
    .map((skillVersionId) => store.skillVersions.get(skillVersionId))
    .filter((row): row is SkillVersion => Boolean(row));
  const rankedSkills = rankByPrompt(skillVersions, prompt, (row) => row.instructions).slice(0, 4);
  const skillText = rankedSkills
    .map((row) => {
      addProvenance(provenance, "skills", "skill_version", row.id, "ranked");
      const skill = store.skills.get(row.skillId);
      return skillBlock(skill?.name ?? row.skillId, row);
    })
    .join("\n\n");

  const principal = principalForAgent(store, orgId, version.agentId);
  const orgLines: string[] = [];
  if (principal) {
    addProvenance(provenance, "organization", "principal", principal.id, "assigned");
    for (const rel of store.principalRelationships.values()) {
      if (rel.orgId !== orgId) {
        continue;
      }
      if (rel.fromPrincipalId !== principal.id && rel.toPrincipalId !== principal.id) {
        continue;
      }
      const otherId = rel.fromPrincipalId === principal.id ? rel.toPrincipalId : rel.fromPrincipalId;
      const other = store.principals.get(otherId);
      if (other) {
        orgLines.push(`${rel.kind}: ${other.displayName}`);
        addProvenance(provenance, "organization", "principal_relationship", rel.id, "assigned");
      }
    }
    for (const membership of store.unitMemberships.values()) {
      if (membership.principalId !== principal.id) {
        continue;
      }
      const unit = store.units.get(membership.unitId);
      if (unit) {
        orgLines.push(`member_of: ${unit.name}`);
        addProvenance(provenance, "organization", "unit", unit.id, "assigned");
      }
    }
  }

  const task = input.task ?? null;
  let taskText = "";
  if (task) {
    taskText = workText(store, task);
    addProvenance(provenance, "work", "task", task.id, "assigned");
    if (task.objectiveId) {
      addProvenance(provenance, "work", "objective", task.objectiveId, "assigned");
    }
  }

  const threadId = run?.threadId;
  const allMessages = threadId ? store.messagesFor(threadId) : [];
  const recent = allMessages.slice(-15);
  const older = allMessages.slice(0, Math.max(0, allMessages.length - 15));
  const retrievedOlder = rankByPrompt(older, prompt, (row) => row.content).slice(0, 5);
  const summary = threadId ? store.threadSummaries.get(threadId) : undefined;
  const conversation = [
    summary ? `Summary:\n${summary.summary}` : "",
    recent.length ? `Recent:\n${recent.map(formatMessage).join("\n")}` : "",
    retrievedOlder.length
      ? `Retrieved older:\n${retrievedOlder.map(formatMessage).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (summary) {
    addProvenance(provenance, "conversation", "thread_summary", summary.threadId, "summary");
  }
  for (const row of recent) {
    addProvenance(provenance, "conversation", "message", row.id, "recent");
  }
  for (const row of retrievedOlder) {
    addProvenance(provenance, "conversation", "message", row.id, "retrieved");
  }

  const memories: Memory[] = store.recall({
    orgId,
    actorId: userId,
    agentId: version.agentId,
    threadId: threadId ?? "",
    allowScopes: version.memoryPolicy.allowScopes,
    query: prompt,
    embedding: embedText(prompt),
  });
  const memoryText = memories.map((row) => `- (${row.scopeType}) ${row.content}`).join("\n");
  for (const row of memories) {
    addProvenance(provenance, "memory", "memory", row.id, "retrieved");
  }

  const outcomes: ActionOutcome[] = store
    .actionOutcomesFor({
      orgId,
      agentId: version.agentId,
      threadId,
      taskId: run?.taskId,
    })
    .slice(0, 8);
  const actionText = outcomes.map((row) => `- ${row.summary}`).join("\n");
  for (const row of outcomes) {
    addProvenance(provenance, "actions", "action_outcome", row.id, "recent");
  }

  const lastInvocation = run
    ? [...store.invocations.values()].filter((row) => row.runId === run.id).at(-1)
    : undefined;
  const runText = run
    ? [
        `Run ${run.id} status=${run.status}`,
        `Prompt: ${run.prompt}`,
        lastInvocation
          ? `Last tool: ${lastInvocation.tool}\nArguments: ${JSON.stringify(lastInvocation.arguments)}\nResult: ${JSON.stringify(lastInvocation.result)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  if (run) {
    addProvenance(provenance, "run", "run", run.id, "assigned");
  }

  const accessText = presentedTools
    .map((toolId) => {
      const recorded = principal
        ? store.policyOutcomeFor(orgId, principal.id, toolId)
        : undefined;
      return `- ${toolId}${recorded ? ` (${recorded})` : ""}`;
    })
    .join("\n");

  const policyLines = [
    `Memory scopes: ${version.memoryPolicy.allowScopes.join(", ") || "none"}`,
    ...presentedTools.flatMap((toolId) => {
      const recorded = principal
        ? store.policyOutcomeFor(orgId, principal.id, toolId)
        : undefined;
      if (!recorded || recorded === "DENY") {
        return [];
      }
      addProvenance(provenance, "policies", "policy_record", `${principal?.id ?? "none"}:${toolId}`, "recorded");
      return [`- ${toolId} (${recorded})`];
    }),
  ];

  const layers: Record<string, string> = {
    platform: layer("Platform", PLATFORM, CONTEXT_BUDGETS.platform),
    identity: layer("Agent identity", identityLines.join("\n"), CONTEXT_BUDGETS.identity),
    skills: layer("Skills", skillText, CONTEXT_BUDGETS.skills),
    access: layer("Access", accessText, CONTEXT_BUDGETS.tools),
    policies: layer("Policies", policyLines.join("\n"), CONTEXT_BUDGETS.tools),
    organization: layer("Organization", orgLines.join("\n"), CONTEXT_BUDGETS.org),
    work: layer("Current work", taskText, CONTEXT_BUDGETS.task),
    conversation: layer("Conversation", conversation, CONTEXT_BUDGETS.conversation),
    memory: layer("Long-term memory", memoryText, CONTEXT_BUDGETS.memory),
    actions: layer("Action history", actionText, CONTEXT_BUDGETS.actions),
    run: layer("Current run", runText, CONTEXT_BUDGETS.output),
  };

  const usage: Record<string, LayerUsage> = {};
  const budgetByLayer: Record<string, number> = {
    platform: CONTEXT_BUDGETS.platform,
    identity: CONTEXT_BUDGETS.identity,
    skills: CONTEXT_BUDGETS.skills,
    access: CONTEXT_BUDGETS.tools,
    policies: CONTEXT_BUDGETS.tools,
    organization: CONTEXT_BUDGETS.org,
    work: CONTEXT_BUDGETS.task,
    conversation: CONTEXT_BUDGETS.conversation,
    memory: CONTEXT_BUDGETS.memory,
    actions: CONTEXT_BUDGETS.actions,
    run: CONTEXT_BUDGETS.output,
  };
  for (const [name, text] of Object.entries(layers)) {
    usage[name] = { used: tokens(text), budget: budgetByLayer[name] ?? 0 };
  }

  const promptText = Object.values(layers)
    .filter(Boolean)
    .join("\n\n");

  return { layers, prompt: promptText, presentedTools, usage, provenance };
}

export function recordCompilation(
  store: JarvisStore,
  compiled: CompiledContext,
  run: Run,
  version: AgentVersion,
): ContextCompilation {
  const compilationId = id("cc");
  const step = store.addStep(run.id, "context", { contextCompilationId: compilationId });
  return {
    id: compilationId,
    runId: run.id,
    runStepId: step.id,
    compilerVersion: COMPILER_VERSION,
    agentVersionId: version.id,
    usage: compiled.usage,
    provenance: compiled.provenance,
    presentedTools: compiled.presentedTools,
    requestableTools: compiled.presentedTools,
    promptHash: sha256Hex(run.prompt),
    contextHash: sha256Hex(compiled.prompt),
    createdAt: new Date().toISOString(),
  };
}

function formatMessage(row: Message): string {
  return `${row.role}: ${row.content}`;
}
