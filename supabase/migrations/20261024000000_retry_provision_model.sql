-- An explicit owner retry may correct a failed single-agent model without
-- minting another identity. Slot accounting and preparation remain authoritative.
CREATE FUNCTION identity.retry_agent_provision_model(p_provision_id uuid, p_model text)
RETURNS identity.agent_provisions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO identity, pg_catalog
AS $$
DECLARE
  v_owner text := (SELECT auth.uid()::text);
  v_model text := NULLIF(btrim(p_model), '');
  v_snapshot identity.agent_provisions;
  v_row identity.agent_provisions;
  v_op identity.agent_provision_operations;
  v_status text;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM identity.assert_provision_owner_live(v_owner);
  IF v_model IS NOT NULL AND (length(v_model) > 200 OR v_model !~ '^[A-Za-z0-9._:/@+-]+$') THEN
    RAISE EXCEPTION 'model must be a model id from the create list';
  END IF;
  SELECT * INTO v_snapshot FROM identity.agent_provisions WHERE id = p_provision_id;
  IF NOT FOUND OR v_snapshot.owner_user_id <> v_owner THEN
    RAISE EXCEPTION 'provision not found for caller';
  END IF;
  -- Match prepare/settle/removal: identity, command, then operation/member.
  PERFORM 1 FROM identity.users WHERE id IN (v_owner, v_snapshot.agent_user_id) ORDER BY id FOR KEY SHARE;
  IF v_snapshot.agent_user_id IS NULL OR v_snapshot.provisioned_agent_user_id IS NULL
     OR v_snapshot.agent_user_id <> v_snapshot.provisioned_agent_user_id::text
     OR NOT EXISTS (SELECT 1 FROM identity.users WHERE id = v_snapshot.agent_user_id AND type = 'agent' AND owner_user_id = v_owner) THEN
    RAISE EXCEPTION 'provision has no live owned immutable agent binding';
  END IF;
  SELECT status INTO v_status FROM identity.gugu_device_commands WHERE id = v_snapshot.create_command_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'error' THEN
    RAISE EXCEPTION 'retry requires the prior create command to be in error';
  END IF;
  SELECT * INTO v_op FROM identity.agent_provision_operations WHERE id = v_snapshot.operation_id FOR UPDATE;
  IF NOT FOUND OR v_op.owner_user_id <> v_owner OR v_op.kind <> 'single'
     OR v_op.phase NOT IN ('failed', 'provisioning_members') THEN
    RAISE EXCEPTION 'operation is not retryable';
  END IF;
  SELECT * INTO v_row FROM identity.agent_provisions WHERE id = p_provision_id FOR UPDATE;
  IF v_row IS DISTINCT FROM v_snapshot THEN
    RAISE EXCEPTION 'provision changed while acquiring retry locks';
  END IF;
  -- A lost response can replay the same already-granted retry. It cannot change
  -- parameters again, reset a terminal record, or bypass the capacity grant.
  IF v_row.phase = 'preparing' AND v_row.model IS NOT DISTINCT FROM v_model THEN
    RETURN v_row;
  END IF;
  IF v_row.phase <> 'failed' THEN RAISE EXCEPTION 'only a failed provision can change model and retry'; END IF;
  UPDATE identity.agent_provisions SET model = v_model, updated_at = now() WHERE id = p_provision_id;
  SELECT * INTO v_row FROM identity.claim_provision_slots(v_row.operation_id, 1, ARRAY[p_provision_id]) WHERE id = p_provision_id;
  IF NOT FOUND THEN
    -- Roll back the model change as well; never report a successful unclaimed retry.
    RAISE EXCEPTION 'retry has no available provision slot';
  END IF;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION identity.retry_agent_provision_model(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.retry_agent_provision_model(uuid, text) TO authenticated;
