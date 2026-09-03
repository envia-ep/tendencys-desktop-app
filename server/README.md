# Jarvis control plane

Hono API + worker for the desktop Jarvis section. Postgres is the source of truth. Each model call gets a compiled working set — not a dump of the company.

```bash
npm run jarvis:dev      # HTTP on :8788 (loads server/.env)
npm run jarvis:worker   # lease claim loop
npm run jarvis:test     # node --test, no Supabase / OpenAI required
```

`JARVIS_INLINE_WORKER=1` (default in `jarvis:dev`) runs the model loop in-process so the HUD does not need a second process.

## Local runbook

1. `server/.env` and `.env` are gitignored. Copy names from `server/.env.example` only.
2. Pin `JARVIS_SERVER_PRIVATE_KEY` / `JARVIS_SERVER_PUBLIC_KEY` / `JARVIS_JWT_SECRET` so the desktop pin survives a server restart. When `SUPABASE_*` is set, boot fails if those keys are missing — they are never regenerated.
3. Apply SQL in order to project `ushfsdpiefajtzggknvy` (never edit an applied file):
   - `sql/migrations/001_control_plane.sql`
   - `sql/migrations/002_agent_handles.sql`
   - `sql/migrations/003_context_compiler.sql`
   - `sql/migrations/004_service_role_grants.sql`
   - `sql/migrations/005_workforce.sql`
   - `sql/migrations/006_memory_created_by_agent.sql`
   - `sql/migrations/007_runtime_durability.sql`
   - `sql/migrations/008_connectors.sql`
   - `sql/migrations/009_rls_service_role_only.sql`
   - `sql/migrations/010_waiting_for_connect.sql`
   - `sql/migrations/011_integration_drafts.sql`
   - `sql/migrations/012_connector_health.sql`
   - `sql/migrations/013_connector_versions.sql`
   - `sql/migrations/014_integration_recipes.sql`
4. Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` so HTTP and the worker share the same project. Both processes hydrate `persist.ts` (org, threads, messages, memories, action outcomes) and `RuntimeRepo` (sessions, devices, runs, leases, invocations, approvals, grants, events, nonces).
5. `JARVIS_MODEL_API_KEY` unset keeps the regex planner. Set it for the OpenAI loop (key lives only in `server/.env`, never in the desktop bundle).
6. `npm run jarvis:dev` from the repo root (cwd for the workspace is `server/`, so `loadDotenv()` reads `server/.env`).
7. Rebuild and open **Envia.com.app** (never `npm run tauri:dev` / `tendencys-desktop`). Keep `npm run dev` on `:1420` so the debug app hot-reloads the shell:

```bash
osascript -e 'quit app "Envia.com"'
pkill -f 'target/debug/tendencys-desktop' || true
npm run tauri build -- --debug
open src-tauri/target/debug/bundle/macos/Envia.com.app
```

Rolled-up contract: `src/schema.sql`. Railway: two services from this folder (HTTP `npm start`, worker `npm run worker`) against the same Supabase project. The worker must hydrate before claiming. Do not hitch deploys to desktop `v*` tags.
