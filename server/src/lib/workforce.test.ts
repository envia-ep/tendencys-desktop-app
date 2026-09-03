import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JarvisStore } from "./store.ts";
import {
  assignTask,
  completeCurrentTask,
  createTaskRecord,
  memoryWorkforce,
  retryTask,
  startTask,
} from "./workforce.ts";

function auth(store: JarvisStore) {
  store.ensureOrg("acme", "user_1");
  const human = store.ensureHumanPrincipal("acme", "user_1", "Me");
  const seeded = store.seedDefaultJarvis("acme");
  const session = store.createSession({
    userId: "user_1",
    orgId: "acme",
    deviceId: "dev_1",
    ttlMs: 60_000,
  });
  store.upsertDevice({
    id: "dev_1",
    userId: "user_1",
    orgId: "acme",
    publicKey: "pk",
    name: "test",
  });
  return {
    store,
    human,
    seeded,
    auth: {
      userId: "user_1",
      orgId: "acme",
      sessionId: session.id,
      deviceId: "dev_1",
    },
  };
}

describe("workforce assign and dispatch", () => {
  it("assigning an agent queues a run; assigning a human does not", async () => {
    const repo = memoryWorkforce();
    const { store, human, seeded, auth: session } = auth(new JarvisStore());
    const agentPrincipal = store.ensureAgentPrincipal("acme", seeded.agent.id, "Jarvis");
    const toAgent = await createTaskRecord(
      store,
      repo,
      {
        orgId: "acme",
        name: "Follow up with Carlos",
        assigneePrincipalId: agentPrincipal.id,
        createdByPrincipalId: human.id,
      },
      session,
    );
    assert.equal(toAgent.task.status, "assigned");
    assert.ok(toAgent.runId);
    assert.equal(store.getRun(toAgent.runId!)?.taskId, toAgent.task.id);
    assert.equal(store.messagesFor(store.getRun(toAgent.runId!)!.threadId).length, 0);

    const toHuman = await createTaskRecord(
      store,
      repo,
      {
        orgId: "acme",
        name: "Review the brief",
        assigneePrincipalId: human.id,
        createdByPrincipalId: human.id,
      },
      session,
    );
    assert.equal(toHuman.runId, null);
    assert.equal(toHuman.task.status, "assigned");
  });

  it("start is idempotent while a run is active", async () => {
    const repo = memoryWorkforce();
    const { store, human, seeded, auth: session } = auth(new JarvisStore());
    const agentPrincipal = store.ensureAgentPrincipal("acme", seeded.agent.id, "Jarvis");
    const created = await createTaskRecord(
      store,
      repo,
      {
        orgId: "acme",
        name: "Write a recap",
        assigneePrincipalId: agentPrincipal.id,
        createdByPrincipalId: human.id,
      },
      session,
    );
    const again = await startTask(store, repo, created.task.id, human.id, session);
    assert.equal(again.runId, created.runId);
    assert.equal(again.created, false);
  });

  it("retry only after a terminal run", async () => {
    const repo = memoryWorkforce();
    const { store, human, seeded, auth: session } = auth(new JarvisStore());
    const agentPrincipal = store.ensureAgentPrincipal("acme", seeded.agent.id, "Jarvis");
    const created = await createTaskRecord(
      store,
      repo,
      {
        orgId: "acme",
        name: "Retry me",
        assigneePrincipalId: agentPrincipal.id,
        createdByPrincipalId: human.id,
      },
      session,
    );
    const early = await retryTask(store, repo, created.task.id, human.id, session);
    assert.equal(early.created, false);
    store.setRunStatus(created.runId!, "failed", { clearLease: true });
    const retried = await retryTask(store, repo, created.task.id, human.id, session);
    assert.equal(retried.created, true);
    assert.notEqual(retried.runId, created.runId);
  });

  it("re-assigning a human after an agent does not keep auto-dispatching", async () => {
    const repo = memoryWorkforce();
    const { store, human, seeded, auth: session } = auth(new JarvisStore());
    const agentPrincipal = store.ensureAgentPrincipal("acme", seeded.agent.id, "Jarvis");
    const created = await createTaskRecord(
      store,
      repo,
      { orgId: "acme", name: "Move to me", createdByPrincipalId: human.id },
      session,
    );
    assert.equal(created.runId, null);
    const assigned = await assignTask(
      store,
      repo,
      created.task.id,
      agentPrincipal.id,
      human.id,
      session,
    );
    assert.ok(assigned.runId);
    const toHuman = await assignTask(store, repo, created.task.id, human.id, human.id, session);
    assert.equal(toHuman.runId, null);
    assert.equal(toHuman.created, false);
  });

  it("complete writes result_summary", async () => {
    const repo = memoryWorkforce();
    const { store, human, auth: session } = auth(new JarvisStore());
    const created = await createTaskRecord(
      store,
      repo,
      { orgId: "acme", name: "Close the loop", createdByPrincipalId: human.id },
      session,
    );
    const done = await completeCurrentTask(repo, created.task.id, "Sent the recap.", "run_x");
    assert.equal(done.status, "completed");
    assert.equal(done.resultSummary, "Sent the recap.");
  });
});
