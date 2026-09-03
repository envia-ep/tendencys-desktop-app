-- Platform-wide "how to connect" recipe library for the Integration OS. Shared
-- across orgs: a recipe carries only the connection SHAPE (auth method, base
-- URL, credential field schema, docs, steps, proposed operations) — never any
-- secret value — so the next user gets the path that actually worked. Keyed by
-- product slug. Service-role only, matching migrations 008-013. No org column
-- and no org RLS by design: this is non-sensitive shared metadata.

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

ALTER TABLE integration_recipes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE integration_recipes FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE integration_recipes TO service_role;
