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

REVOKE EXECUTE ON FUNCTION claim_jarvis_run(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_jarvis_run(TEXT, INT) TO service_role;
