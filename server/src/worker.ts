import { loadEnv } from "./lib/env.ts";
import { createPersister } from "./lib/persist.ts";
import { processRun, type RuntimeKeys } from "./lib/runtime.ts";
import { createPostgresRuntime, memoryRuntime } from "./lib/runtime-repo.ts";
import { store } from "./lib/store.ts";
import { id } from "./lib/ids.ts";
import type { JarvisStore } from "./lib/store.ts";
import { createPostgresWorkforce, memoryWorkforce } from "./lib/workforce.ts";

export async function tickWorker(
  workerStore: JarvisStore,
  keys: RuntimeKeys,
  workerId: string,
  leaseMs: number,
): Promise<boolean> {
  const runtime = keys.runtime ?? memoryRuntime(workerStore);
  const run = await runtime.claimRun(workerId, leaseMs);
  if (!run) {
    return false;
  }
  await processRun(workerStore, run, { ...keys, runtime });
  return true;
}

export async function drainWorker(
  workerStore: JarvisStore,
  keys: RuntimeKeys,
  workerId = id("wrk"),
  leaseMs = 30_000,
  maxTicks = 16,
): Promise<number> {
  let ticks = 0;
  while (ticks < maxTicks && (await tickWorker(workerStore, keys, workerId, leaseMs))) {
    ticks += 1;
  }
  return ticks;
}

const isMain = process.argv[1]?.includes("worker");
if (isMain) {
  const env = loadEnv();
  const persister = createPersister(env);
  if (persister) {
    store.persister = persister;
    try {
      await persister.hydrate(store);
      console.log("[jarvis/worker] hydrated control plane from Supabase");
    } catch (error) {
      console.error("[jarvis/worker] hydrate failed, continuing in memory", error);
    }
  }
  const workforce = createPostgresWorkforce(env) ?? memoryWorkforce();
  const runtime = createPostgresRuntime(env, store) ?? memoryRuntime(store);
  try {
    await runtime.hydrateStore(store);
    console.log("[jarvis/worker] hydrated runtime from Supabase");
  } catch (error) {
    console.error("[jarvis/worker] runtime hydrate failed, continuing in memory", error);
  }
  const workerId = id("wrk");
  console.log(`[jarvis/worker] started ${workerId}`);
  const loop = () => {
    void tickWorker(store, { ...env, workforce, runtime }, workerId, env.leaseMs).catch((error) => {
      console.error("[jarvis/worker] tick failed", error);
    });
  };
  setInterval(loop, 250);
  loop();
}
