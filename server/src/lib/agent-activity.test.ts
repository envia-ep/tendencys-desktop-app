import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityForAgent } from "./agent-activity.ts";
import { JarvisStore } from "./store.ts";
import type { RunStatus } from "./types.ts";

function seedRun(store: JarvisStore, status: RunStatus) {
  store.ensureOrg("acme", "user_1");
  const seeded = store.seedDefaultJarvis("acme");
  const thread = store.createThread({
    orgId: "acme",
    actorId: "user_1",
    agentId: seeded.agent.id,
  });
  store.createRun({
    id: "run_1",
    orgId: "acme",
    actorId: "user_1",
    threadId: thread.id,
    agentId: seeded.agent.id,
    agentVersion: seeded.version.id,
    sessionId: "ses_1",
    deviceId: "dev_1",
    prompt: "Qualify inbound leads",
    taskId: null,
    status,
  });
  return seeded.agent.id;
}

describe("activityForAgent", () => {
  it("is idle without an active run", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const seeded = store.seedDefaultJarvis("acme");
    assert.deepEqual(activityForAgent(store, seeded.agent.id), { status: "idle", title: null });
  });

  it("maps each run status instead of collapsing them into working", () => {
    const cases: Array<[RunStatus, string]> = [
      ["queued", "starting"],
      ["running", "working"],
      ["waiting_for_local_tool", "waiting_for_local_tool"],
      ["waiting_for_approval", "waiting_for_approval"],
      ["waiting_for_connect", "waiting_for_connect"],
      ["completed", "idle"],
      ["failed", "idle"],
    ];
    for (const [runStatus, activity] of cases) {
      const store = new JarvisStore();
      const agentId = seedRun(store, runStatus);
      assert.deepEqual(
        activityForAgent(store, agentId),
        {
          status: activity,
          title: activity === "idle" ? null : "Qualify inbound leads",
        },
        runStatus,
      );
    }
  });
});
