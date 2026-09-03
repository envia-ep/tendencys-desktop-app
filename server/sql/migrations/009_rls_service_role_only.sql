-- Service-role only. Desktop never queries Supabase; Hono uses the service role
-- (bypasses RLS). No anon/authenticated policies — default deny.

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', r.tablename);
  END LOOP;
END $$;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

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
SET search_path = public
AS $$
BEGIN
  UPDATE runs
  SET lease_expires_at = now() + (p_lease_ms || ' milliseconds')::interval
  WHERE id = p_run_id
    AND worker_id = p_worker_id;
  RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION claim_jarvis_run(TEXT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION renew_jarvis_lease(TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_jarvis_run(TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION renew_jarvis_lease(TEXT, TEXT, INT) TO service_role;
