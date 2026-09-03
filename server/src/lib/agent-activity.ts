import type { JarvisStore } from "./store.ts";
import type { RunStatus } from "./types.ts";

const ACTIVE: ReadonlySet<RunStatus> = new Set([
  "queued",
  "running",
  "waiting_for_local_tool",
  "waiting_for_approval",
  "waiting_for_connect",
]);

export type AgentActivityStatus =
  | "idle"
  | "starting"
  | "working"
  | "waiting_for_local_tool"
  | "waiting_for_approval"
  | "waiting_for_connect";

export type AgentActivity = {
  status: AgentActivityStatus;
  title: string | null;
};

function statusForRun(status: RunStatus): AgentActivityStatus {
  if (status === "queued") {
    return "starting";
  }
  if (status === "running") {
    return "working";
  }
  if (status === "waiting_for_local_tool") {
    return "waiting_for_local_tool";
  }
  if (status === "waiting_for_approval") {
    return "waiting_for_approval";
  }
  if (status === "waiting_for_connect") {
    return "waiting_for_connect";
  }
  return "idle";
}

export function activityForAgent(store: JarvisStore, agentId: string): AgentActivity {
  const active = [...store.runs.values()]
    .filter((run) => run.agentId === agentId && ACTIVE.has(run.status))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!active) {
    return { status: "idle", title: null };
  }
  return {
    status: statusForRun(active.status),
    title: active.prompt.trim().slice(0, 120) || null,
  };
}
