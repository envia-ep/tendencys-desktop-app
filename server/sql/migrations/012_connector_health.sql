-- Connector operational health for the Integration OS resolver. One row per
-- connector (latest signal wins), updated by the layered validator and by
-- runtime execution failures. Service-role only, matching migrations 008–011.

CREATE TABLE IF NOT EXISTS connector_health (
  connector_id TEXT PRIMARY KEY REFERENCES connectors (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations (company_id),
  state TEXT NOT NULL DEFAULT 'READY',
  detail TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connector_health_org ON connector_health (org_id);

ALTER TABLE connector_health ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE connector_health FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE connector_health TO service_role;
