ALTER TABLE objectives ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE objectives ADD COLUMN IF NOT EXISTS project_unit_id TEXT REFERENCES organizational_units (id);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by_principal_id TEXT REFERENCES principals (id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_unit_id TEXT REFERENCES organizational_units (id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result_summary TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS task_events (
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

CREATE TABLE IF NOT EXISTS context_compilations (
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
