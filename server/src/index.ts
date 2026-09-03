import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadEnv } from "./lib/env.ts";
import { createPersister } from "./lib/persist.ts";
import { createPostgresRuntime, memoryRuntime } from "./lib/runtime-repo.ts";
import { store } from "./lib/store.ts";
import { createPostgresWorkforce, memoryWorkforce } from "./lib/workforce.ts";

const env = loadEnv();
const persister = createPersister(env);
if (persister) {
  store.persister = persister;
  try {
    await persister.hydrate(store);
    console.log("[jarvis/http] hydrated control plane from Supabase");
  } catch (error) {
    console.error("[jarvis/http] hydrate failed, continuing in memory", error);
  }
}
const workforce = createPostgresWorkforce(env) ?? memoryWorkforce();
const runtime = createPostgresRuntime(env, store) ?? memoryRuntime(store);
try {
  await runtime.hydrateStore(store);
  console.log("[jarvis/http] hydrated runtime from Supabase");
} catch (error) {
  console.error("[jarvis/http] runtime hydrate failed, continuing in memory", error);
}
const app = createApp({ store, env, workforce, runtime });

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[jarvis/http] listening on :${info.port}`);
});
