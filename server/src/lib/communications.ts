import type { JarvisStore } from "./store.ts";
import type { Principal } from "./types.ts";
import type { WorkforceRepo } from "./workforce.ts";

export type CommKind = "a_a" | "h_a" | "a_h";

export type CommParty = {
  id: string | null;
  type: "human" | "agent" | "organization" | "unknown";
  name: string;
  handle: string | null;
};

export type CommunicationItem = {
  id: string;
  createdAt: string;
  kind: CommKind;
  from: CommParty;
  to: CommParty;
  content: string;
  source: "message" | "task_assign" | "config_switch";
};

const unknownParty: CommParty = {
  id: null,
  type: "unknown",
  name: "unknown",
  handle: null,
};

function partyFromPrincipal(store: JarvisStore, principal: Principal | undefined): CommParty {
  if (!principal) {
    return unknownParty;
  }
  if (principal.type === "agent" && principal.agentId) {
    const agent = store.agents.get(principal.agentId);
    return {
      id: principal.agentId,
      type: "agent",
      name: principal.displayName,
      handle: agent?.handle ?? null,
    };
  }
  return {
    id: principal.userId ?? principal.id,
    type: "human",
    name: principal.displayName,
    handle: null,
  };
}

function partyFromAgentId(store: JarvisStore, orgId: string, agentId: string | null | undefined): CommParty {
  if (!agentId) {
    return unknownParty;
  }
  const agent = store.agents.get(agentId);
  if (!agent || agent.orgId !== orgId) {
    return unknownParty;
  }
  return {
    id: agent.id,
    type: "agent",
    name: agent.name,
    handle: agent.handle,
  };
}

function partyFromUserId(store: JarvisStore, orgId: string, userId: string): CommParty {
  const principal = [...store.principals.values()].find(
    (row) => row.orgId === orgId && row.userId === userId,
  );
  return partyFromPrincipal(store, principal);
}

export async function projectCommunications(
  store: JarvisStore,
  workforce: WorkforceRepo,
  orgId: string,
  userId: string,
): Promise<CommunicationItem[]> {
  const items: CommunicationItem[] = [];

  for (const thread of store.threads.values()) {
    if (thread.orgId !== orgId || thread.actorId !== userId) {
      continue;
    }
    const human = partyFromUserId(store, orgId, thread.actorId);
    const agent = partyFromAgentId(store, orgId, thread.agentId);
    for (const message of store.messagesFor(thread.id)) {
      if (message.role === "user") {
        items.push({
          id: message.id,
          createdAt: message.createdAt,
          kind: "h_a",
          from: human,
          to: agent,
          content: message.content,
          source: "message",
        });
      } else if (message.role === "assistant") {
        items.push({
          id: message.id,
          createdAt: message.createdAt,
          kind: "a_h",
          from: agent,
          to: human,
          content: message.content,
          source: "message",
        });
      }
    }
  }

  for (const run of store.runs.values()) {
    if (run.orgId !== orgId) {
      continue;
    }
    for (const step of store.stepsFor(run.id)) {
      if (step.type !== "config_switch") {
        continue;
      }
      const fromId = typeof step.payload.fromAgentId === "string" ? step.payload.fromAgentId : null;
      const toId = typeof step.payload.toAgentId === "string" ? step.payload.toAgentId : null;
      const to = partyFromAgentId(store, orgId, toId);
      items.push({
        id: step.id,
        createdAt: step.createdAt,
        kind: "a_a",
        from: partyFromAgentId(store, orgId, fromId),
        to,
        content: to.handle ? `handed off to @${to.handle}` : "handed off",
        source: "config_switch",
      });
    }
  }

  const tasks = await workforce.listTasks({ orgId });
  for (const task of tasks) {
    const events = await workforce.listEvents(task.id);
    for (const event of events) {
      if (event.type !== "assigned" || !event.actorPrincipalId) {
        continue;
      }
      const actor = store.principals.get(event.actorPrincipalId);
      const assigneeId =
        typeof event.metadata.assigneePrincipalId === "string"
          ? event.metadata.assigneePrincipalId
          : task.assigneePrincipalId;
      const assignee = assigneeId ? store.principals.get(assigneeId) : undefined;
      if (actor?.type !== "agent" || assignee?.type !== "agent") {
        continue;
      }
      items.push({
        id: event.id,
        createdAt: event.createdAt,
        kind: "a_a",
        from: partyFromPrincipal(store, actor),
        to: partyFromPrincipal(store, assignee),
        content: task.name,
        source: "task_assign",
      });
    }
  }

  items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return items;
}
