-- Jarvis control plane (Postgres + pgvector). In-memory store mirrors this shape.

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  description TEXT NOT NULL DEFAULT ''
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
  assignee_principal_id TEXT REFERENCES principals (id),
  status TEXT NOT NULL DEFAULT 'planned'
);

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
