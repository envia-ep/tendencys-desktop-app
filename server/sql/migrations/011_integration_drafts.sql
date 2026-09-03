-- Integration lifecycle persistence for the AI Integration Engineer.
-- Service-role only, matching migration 008/009 (Hono uses service_role; RLS
-- default-denies everyone else). Connect sessions gain durability so a
-- half-finished connect survives a restart.

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

CREATE INDEX IF NOT EXISTS integration_drafts_org ON integration_drafts (org_id);

CREATE TABLE IF NOT EXISTS integration_sources (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES integration_drafts (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  ref TEXT,
  content TEXT,
  sha TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_sources_draft ON integration_sources (draft_id);

CREATE TABLE IF NOT EXISTS integration_validations (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES integration_drafts (id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_validations_draft ON integration_validations (draft_id);

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

CREATE INDEX IF NOT EXISTS connect_sessions_org ON connect_sessions (org_id);

ALTER TABLE integration_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE connect_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE integration_drafts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE integration_sources FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE integration_validations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE connect_sessions FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE integration_drafts TO service_role;
GRANT ALL ON TABLE integration_sources TO service_role;
GRANT ALL ON TABLE integration_validations TO service_role;
GRANT ALL ON TABLE connect_sessions TO service_role;
