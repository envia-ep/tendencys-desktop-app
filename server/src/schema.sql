-- Jarvis control plane (Postgres + pgvector). In-memory store mirrors this shape.
-- Access: service_role only. ENABLE RLS on every public table, no anon/authenticated
-- policies (default deny). Desktop never queries Supabase.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  company_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  graph_revision INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  company_id TEXT NOT NULL REFERENCES organizations (company_id),
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  public_key TEXT NOT NULL,
  name TEXT NOT NULL,
  accounts_device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE jarvis_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  name TEXT NOT NULL,
  handle TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, handle)
);

CREATE TABLE agent_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  version INTEGER NOT NULL,
  identity TEXT NOT NULL,
  jobs TEXT NOT NULL,
  tool_ids TEXT[] NOT NULL,
  requested_tool_ids TEXT[] NOT NULL DEFAULT '{}',
  role_ids TEXT[] NOT NULL DEFAULT '{}',
  skill_version_ids TEXT[] NOT NULL DEFAULT '{}',
  compiled_instructions TEXT NOT NULL DEFAULT '',
  responsibilities TEXT[] NOT NULL DEFAULT '{}',
  expected_outcomes TEXT[] NOT NULL DEFAULT '{}',
  memory_policy JSONB NOT NULL,
  model_tier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  actor_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads (id),
  agent_id TEXT NOT NULL REFERENCES agents (id),
  agent_version TEXT NOT NULL REFERENCES agent_versions (id),
  session_id TEXT NOT NULL REFERENCES jarvis_sessions (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_wake_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id),
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE TABLE tool_invocations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id),
  run_step_id TEXT NOT NULL REFERENCES run_steps (id),
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  side TEXT NOT NULL,
  tool TEXT NOT NULL,
  arguments JSONB NOT NULL,
  args_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  result JSONB,
  grant_id TEXT,
  arguments_sealed TEXT,
  result_sealed TEXT,
  connector_version_id TEXT,
  capability_version_id TEXT,
  nonce TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  tool_invocation_id TEXT NOT NULL REFERENCES tool_invocations (id),
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (id),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  decision TEXT NOT NULL
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  subject_user_id TEXT,
  created_by_agent_id TEXT,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 1,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  embedding VECTOR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_confirmed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id),
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  agent_id TEXT,
  agent_version TEXT,
  action TEXT NOT NULL,
  policy_outcome TEXT,
  approval_id TEXT,
  device_id TEXT,
  execution_result TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trace_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id),
  run_step_id TEXT,
  model_tier TEXT,
  latency_ms INTEGER,
  token_count INTEGER,
  memory_retrieval_ids TEXT[],
  tool_planning JSONB,
  error_details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE grant_projections (
  grant_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  type TEXT NOT NULL,
  user_id TEXT,
  agent_id TEXT REFERENCES agents (id),
  display_name TEXT NOT NULL
);

CREATE TABLE organizational_units (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_unit_id TEXT REFERENCES organizational_units (id)
);

CREATE TABLE project_details (
  unit_id TEXT PRIMARY KEY REFERENCES organizational_units (id),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  objective_id TEXT
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  name TEXT NOT NULL,
  required_tool_ids TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  name TEXT NOT NULL
);

CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills (id),
  version INTEGER NOT NULL,
  instructions TEXT NOT NULL,
  input_schema JSONB NOT NULL DEFAULT '{}',
  output_schema JSONB NOT NULL DEFAULT '{}',
  required_tools TEXT[] NOT NULL DEFAULT '{}',
  required_knowledge TEXT[] NOT NULL DEFAULT '{}',
  evaluation_policy JSONB NOT NULL DEFAULT '{}',
  UNIQUE (skill_id, version)
);

CREATE TABLE unit_memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  principal_id TEXT NOT NULL REFERENCES principals (id),
  unit_id TEXT NOT NULL REFERENCES organizational_units (id)
);

CREATE TABLE agent_roles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  agent_id TEXT NOT NULL REFERENCES agents (id),
  role_id TEXT NOT NULL REFERENCES roles (id),
  priority INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE agent_skills (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  agent_id TEXT NOT NULL REFERENCES agents (id),
  skill_id TEXT NOT NULL REFERENCES skills (id),
  skill_version_id TEXT REFERENCES skill_versions (id)
);

CREATE TABLE role_skills (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  role_id TEXT NOT NULL REFERENCES roles (id),
  skill_id TEXT NOT NULL REFERENCES skills (id)
);

CREATE TABLE role_responsibilities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  role_id TEXT NOT NULL REFERENCES roles (id),
  text TEXT NOT NULL
);

CREATE TABLE principal_relationships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  kind TEXT NOT NULL,
  from_principal_id TEXT NOT NULL REFERENCES principals (id),
  to_principal_id TEXT NOT NULL REFERENCES principals (id)
);

CREATE TABLE project_memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  principal_id TEXT NOT NULL REFERENCES principals (id),
  unit_id TEXT NOT NULL REFERENCES organizational_units (id)
);

CREATE TABLE objectives (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  project_unit_id TEXT REFERENCES organizational_units (id)
);

CREATE TABLE objective_owners (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  principal_id TEXT NOT NULL REFERENCES principals (id),
  objective_id TEXT NOT NULL REFERENCES objectives (id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  objective_id TEXT REFERENCES objectives (id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',
  assignee_principal_id TEXT REFERENCES principals (id),
  status TEXT NOT NULL DEFAULT 'planned',
  created_by_principal_id TEXT REFERENCES principals (id),
  due_at TIMESTAMPTZ,
  project_unit_id TEXT REFERENCES organizational_units (id),
  result_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  type TEXT NOT NULL,
  actor_principal_id TEXT REFERENCES principals (id),
  run_id TEXT,
  from_status TEXT,
  to_status TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id, created_at);

CREATE TABLE context_compilations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  run_step_id TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  agent_version_id TEXT NOT NULL,
  usage JSONB NOT NULL,
  provenance JSONB NOT NULL,
  presented_tools TEXT[] NOT NULL DEFAULT '{}',
  prompt_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS context_compilations_run_idx ON context_compilations (run_id, created_at);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft'
);

CREATE TABLE access_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  principal_id TEXT NOT NULL REFERENCES principals (id),
  tool_id TEXT NOT NULL,
  kind TEXT NOT NULL
);

CREATE TABLE policy_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  principal_id TEXT NOT NULL REFERENCES principals (id),
  tool_id TEXT NOT NULL,
  outcome TEXT NOT NULL
);

CREATE TABLE studio_proposals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  created_by TEXT NOT NULL,
  brief TEXT NOT NULL,
  template_id TEXT,
  base_graph_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  nodes JSONB NOT NULL,
  edges JSONB NOT NULL,
  instantiated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS task_id TEXT REFERENCES tasks (id);

CREATE TABLE IF NOT EXISTS thread_summaries (
  thread_id TEXT PRIMARY KEY REFERENCES threads (id),
  summary TEXT NOT NULL,
  through_message_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_outcomes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  agent_id TEXT NOT NULL REFERENCES agents (id),
  thread_id TEXT NOT NULL REFERENCES threads (id),
  task_id TEXT REFERENCES tasks (id),
  run_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_outcomes_agent_idx ON action_outcomes (org_id, agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS used_nonces (
  nonce TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (key, scope)
);

CREATE INDEX IF NOT EXISTS runs_claim_idx
  ON runs (status, lease_expires_at, next_wake_at, created_at);

CREATE OR REPLACE FUNCTION claim_jarvis_run(p_worker_id TEXT, p_lease_ms INT)
RETURNS SETOF runs
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  claimed runs;
BEGIN
  SELECT * INTO claimed
  FROM runs
  WHERE status = 'queued'
     OR (
       status = 'running'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < now()
     )
     OR (
       status IN ('waiting_for_local_tool', 'waiting_for_approval', 'waiting_for_connect')
       AND next_wake_at IS NOT NULL
       AND next_wake_at <= now()
     )
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE runs
  SET
    status = 'running',
    attempt = attempt + 1,
    worker_id = p_worker_id,
    lease_expires_at = now() + (p_lease_ms || ' milliseconds')::interval,
    next_wake_at = NULL
  WHERE id = claimed.id
  RETURNING * INTO claimed;

  RETURN NEXT claimed;
END;
$$;

ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS arguments_sealed TEXT;
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS result_sealed TEXT;

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  sealed TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (org_id, label)
);

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  revision INTEGER NOT NULL DEFAULT 1,
  credential_id TEXT REFERENCES credentials (id),
  public_config JSONB NOT NULL DEFAULT '{}',
  spec_hash TEXT,
  auth_sealed TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  connector_id TEXT NOT NULL REFERENCES connectors (id),
  tool_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  side TEXT NOT NULL,
  risk TEXT NOT NULL,
  input_schema JSONB NOT NULL DEFAULT '{}',
  output_schema JSONB NOT NULL DEFAULT '{}',
  binding JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (org_id, tool_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS capabilities_one_enabled
  ON capabilities (org_id, tool_id)
  WHERE enabled;

CREATE TABLE IF NOT EXISTS custom_tools (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  tool_id TEXT NOT NULL,
  definition JSONB NOT NULL,
  risk TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, tool_id)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors (id),
  nonce TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  body_sealed TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connector_id, nonce)
);

CREATE TABLE IF NOT EXISTS integration_drafts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  name TEXT NOT NULL,
  source_type TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  spec_hash TEXT,
  base_url TEXT,
  discovered_auth JSONB,
  discovered_operations JSONB NOT NULL DEFAULT '[]',
  proposed_capabilities JSONB NOT NULL DEFAULT '[]',
  validation_state TEXT,
  questions JSONB NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_sources (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES integration_drafts (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  ref TEXT,
  content TEXT,
  sha TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_validations (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES integration_drafts (id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connect_sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  run_id TEXT,
  agent_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  provider_id TEXT,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  oauth_state TEXT,
  tool_ids JSONB NOT NULL DEFAULT '[]',
  fields JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connector_health (
  connector_id TEXT PRIMARY KEY REFERENCES connectors (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  state TEXT NOT NULL DEFAULT 'READY',
  detail TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connector_versions (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  revision INTEGER NOT NULL,
  spec_hash TEXT,
  public_config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connector_id, revision)
);

CREATE TABLE IF NOT EXISTS capability_versions (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capabilities (id) ON DELETE CASCADE,
  connector_version_id TEXT NOT NULL REFERENCES connector_versions (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  tool_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  side TEXT NOT NULL,
  risk TEXT NOT NULL,
  binding JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, tool_id, version)
);

CREATE TABLE IF NOT EXISTS integration_recipes (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  aliases JSONB NOT NULL DEFAULT '[]',
  purpose TEXT NOT NULL DEFAULT 'custom',
  base_url TEXT,
  recommended_auth JSONB NOT NULL DEFAULT '{}',
  required_fields JSONB NOT NULL DEFAULT '[]',
  fallback_auth JSONB,
  steps JSONB NOT NULL DEFAULT '[]',
  docs JSONB NOT NULL DEFAULT '[]',
  operations JSONB NOT NULL DEFAULT '[]',
  credential_kind TEXT NOT NULL DEFAULT 'bearer',
  source TEXT NOT NULL DEFAULT 'learned',
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  success_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_recipes_source ON integration_recipes (source);

CREATE OR REPLACE FUNCTION renew_jarvis_lease(
  p_run_id TEXT,
  p_worker_id TEXT,
  p_lease_ms INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE runs
  SET lease_expires_at = now() + (p_lease_ms || ' milliseconds')::interval
  WHERE id = p_run_id
    AND worker_id = p_worker_id;
  RETURN FOUND;
END;
$$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', r.tablename);
  END LOOP;
END $$;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION claim_jarvis_run(TEXT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION renew_jarvis_lease(TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_jarvis_run(TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION renew_jarvis_lease(TEXT, TEXT, INT) TO service_role;
