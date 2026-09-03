ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS nonce TEXT;
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

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
       status IN ('waiting_for_local_tool', 'waiting_for_approval')
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

CREATE OR REPLACE FUNCTION renew_jarvis_lease(
  p_run_id TEXT,
  p_worker_id TEXT,
  p_lease_ms INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE runs
  SET lease_expires_at = now() + (p_lease_ms || ' milliseconds')::interval
  WHERE id = p_run_id
    AND worker_id = p_worker_id;
  RETURN FOUND;
END;
$$;

GRANT ALL ON TABLE used_nonces TO service_role;
GRANT ALL ON TABLE idempotency_keys TO service_role;
GRANT EXECUTE ON FUNCTION claim_jarvis_run(TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION renew_jarvis_lease(TEXT, TEXT, INT) TO service_role;
