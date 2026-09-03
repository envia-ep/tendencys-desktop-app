ALTER TABLE agents ADD COLUMN IF NOT EXISTS handle TEXT;
UPDATE agents SET handle = lower(split_part(name, ' ', 1)) WHERE handle IS NULL OR handle = '';
ALTER TABLE agents ALTER COLUMN handle SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agents_org_handle_uidx ON agents (org_id, handle);
