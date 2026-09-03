import type { JarvisStore } from "./store.ts";
import type { Run, ToolInvocation } from "./types.ts";

export function semanticActionSummary(
  handle: string,
  invocation: ToolInvocation,
): string {
  const tag = `@${handle}`;
  if (invocation.status === "failed") {
    const error =
      invocation.result && typeof invocation.result === "object" && "error" in invocation.result
        ? String((invocation.result as { error: unknown }).error)
        : "failed";
    return `${tag} was denied or failed ${invocation.tool} (${error}).`;
  }
  if (invocation.tool === "memory.remember") {
    return `${tag} stored a memory.`;
  }
  if (invocation.tool === "memory.recall") {
    const count =
      invocation.result && typeof invocation.result === "object" && "memories" in invocation.result
        ? (invocation.result as { memories: unknown[] }).memories.length
        : 0;
    return `${tag} recalled ${count} memories.`;
  }
  if (invocation.tool === "desktop.open_service") {
    return `${tag} opened ${String(invocation.arguments.serviceId ?? "a service")}.`;
  }
  if (invocation.tool === "task.complete_current") {
    return `${tag} completed the task.`;
  }
  if (invocation.tool === "task.update_current") {
    return `${tag} updated the current task.`;
  }
  if (invocation.tool === "web.search") {
    return `${tag} searched the web.`;
  }
  if (invocation.tool === "task.create") {
    const count =
      invocation.result && typeof invocation.result === "object" && "count" in invocation.result
        ? Number((invocation.result as { count: unknown }).count)
        : 0;
    return `${tag} created ${count} inbox tasks.`;
  }
  if (
    invocation.result &&
    typeof invocation.result === "object" &&
    "segments" in invocation.result
  ) {
    const row = invocation.result as { total?: unknown; segments?: unknown[] };
    return `${tag} grouped ${Number(row.total ?? 0)} customers into ${row.segments?.length ?? 0} segments.`;
  }
  return `${tag} completed ${invocation.tool}.`;
}

export async function recordActionOutcome(store: JarvisStore, run: Run, invocation: ToolInvocation): Promise<void> {
  const agent = store.agents.get(run.agentId);
  const outcome = store.addActionOutcome({
    orgId: run.orgId,
    agentId: run.agentId,
    threadId: run.threadId,
    taskId: run.taskId,
    runId: run.id,
    tool: invocation.tool,
    summary: semanticActionSummary(agent?.handle ?? "agent", invocation),
  });
  await store.persist("action_outcomes", outcome);
}
