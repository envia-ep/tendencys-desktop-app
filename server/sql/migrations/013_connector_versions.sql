-- First-class connector + capability versions for the Integration OS. Each
-- attach that changes the spec creates an immutable snapshot row instead of
-- mutating a live connector under running tasks, mirroring agent_versions.
-- tool_invocations reference the exact versions they executed against.
-- Service-role only, matching migrations 008-012.

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

CREATE INDEX IF NOT EXISTS connector_versions_org ON connector_versions (org_id);
CREATE INDEX IF NOT EXISTS capability_versions_org ON capability_versions (org_id);

ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS connector_version_id TEXT;
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS capability_version_id TEXT;

ALTER TABLE connector_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability_versions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE connector_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE capability_versions FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE connector_versions TO service_role;
GRANT ALL ON TABLE capability_versions TO service_role;
