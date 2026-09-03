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

ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE credentials FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE connectors FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE capabilities FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE custom_tools FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE webhook_deliveries FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE credentials TO service_role;
GRANT ALL ON TABLE connectors TO service_role;
GRANT ALL ON TABLE capabilities TO service_role;
GRANT ALL ON TABLE custom_tools TO service_role;
GRANT ALL ON TABLE webhook_deliveries TO service_role;
