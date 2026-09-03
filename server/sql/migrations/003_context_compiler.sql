ALTER TABLE runs ADD COLUMN IF NOT EXISTS task_id TEXT REFERENCES tasks (id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding VECTOR(32);

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
