-- Terminal failure remains visible without permanently blocking later turns.
-- Forward-only follow-up: the original release has already been published.
ALTER TABLE identity.assistant_panel_changes ADD COLUMN terminal_at timestamptz;

-- A leased home may finish a bounded failed attempt without falsely claiming
-- application. The explanatory notice is durable, idempotent, and nonblocking.
CREATE FUNCTION identity.assistant_panel_reject(p_assistant text, p_runtime_instance_id text, p_operation_id uuid, p_error_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text; v_device text; v_change identity.assistant_panel_changes%ROWTYPE; v_notice uuid; v_payload jsonb;
BEGIN
    v_owner := identity.assistant_panel_lock(p_assistant);
    v_device := identity.assistant_panel_runtime(p_assistant,p_runtime_instance_id,true);
    IF p_error_code IS NULL OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
        RAISE EXCEPTION 'Application failure requires a non-sensitive error code' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_change FROM identity.assistant_panel_changes WHERE operation_id = p_operation_id
      AND assistant_user_id = p_assistant AND owner_user_id = v_owner AND source = 'panel' AND operation <> 'notice';
    IF NOT FOUND THEN RAISE EXCEPTION 'Assistant panel change not found' USING ERRCODE = 'P0002'; END IF;
    IF v_change.status IN ('applied','superseded') OR v_change.terminal_at IS NOT NULL THEN
        RETURN jsonb_build_object('operationId',p_operation_id,'revision',v_change.revision::text,'status',v_change.status,
            'terminal',v_change.terminal_at IS NOT NULL,'errorCode',v_change.error_code);
    END IF;
    IF EXISTS (SELECT 1 FROM identity.assistant_panel_changes WHERE assistant_user_id = p_assistant AND source = 'panel'
      AND operation <> 'notice' AND status IN ('pending','failed') AND terminal_at IS NULL AND revision < v_change.revision) THEN
        RAISE EXCEPTION 'Earlier assistant panel changes must be settled first' USING ERRCODE = '55000';
    END IF;
    UPDATE identity.assistant_panel_changes SET status = 'failed',error_code = p_error_code,
        terminal_at = clock_timestamp(),applied_at = NULL,applied_device_id = NULL WHERE operation_id = p_operation_id;
    v_notice := gen_random_uuid();
    v_payload := jsonb_build_object('failure',jsonb_build_object('operationId',p_operation_id,'domain',v_change.domain,
        'resourceKey',v_change.resource_key,'operation',v_change.operation,'errorCode',p_error_code));
    INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,domain,resource_key,
        device_id,source,operation,expected_item_revision,request_hash,payload,status)
      VALUES(v_notice,p_assistant,v_owner,'notice',jsonb_build_array('application-failure',p_operation_id)::text,
        v_device,'panel','notice',0,encode(sha256(convert_to(v_payload::text,'UTF8')),'hex'),v_payload,'pending');
    PERFORM identity.assistant_panel_prune(p_assistant,v_owner);
    PERFORM chat.send_user_event(jsonb_build_object('assistantId',p_assistant,'operationId',p_operation_id,'applicationStatus','failed'),
        'assistant_panel_changed','gugu:user:' || v_owner || ':events',true);
    RETURN jsonb_build_object('operationId',p_operation_id,'revision',v_change.revision::text,'status','failed',
        'terminal',true,'errorCode',p_error_code);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_reject(text,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_panel_reject(text,text,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION identity.assistant_panel_snapshot(p_assistant text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := auth.uid()::text; v_result jsonb;
BEGIN
    IF NOT COALESCE(identity.assistant_panel_is_owner(p_assistant,v_owner),false) THEN
        RAISE EXCEPTION 'Personal assistant is not available to this account' USING ERRCODE = '42501';
    END IF;
    SELECT jsonb_build_object('version',1,'revision',COALESCE((SELECT revision::text FROM identity.assistant_panel_items
        WHERE assistant_user_id = p_assistant AND domain = 'control' AND resource_key = '__head__'),'0'),
        'items',COALESCE((SELECT jsonb_agg(to_jsonb(i) || jsonb_build_object('revision',i.revision::text) ORDER BY domain,resource_key) FROM identity.assistant_panel_items i
            WHERE assistant_user_id = p_assistant AND domain <> 'control' AND deleted_at IS NULL AND stale_at IS NULL),'[]'::jsonb),
        'application',COALESCE((SELECT jsonb_agg(jsonb_build_object('operationId',operation_id,'revision',revision::text,
            'domain',domain,'resourceKey',resource_key,'status',status,'errorCode',error_code,'terminal',terminal_at IS NOT NULL) ORDER BY revision)
            FROM identity.assistant_panel_changes WHERE assistant_user_id = p_assistant AND source = 'panel' AND operation <> 'notice' AND status IN ('pending','failed')),'[]'::jsonb)) INTO v_result;
    IF octet_length(v_result::text) > 16777216 THEN
        RAISE EXCEPTION 'Assistant panel snapshot exceeds the complete response budget' USING ERRCODE = '54000';
    END IF;
    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION identity.assistant_panel_pending(p_assistant text, p_runtime_instance_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text; v_result jsonb;
BEGIN
    v_owner := identity.assistant_panel_lock(p_assistant);
    PERFORM identity.assistant_panel_runtime(p_assistant,p_runtime_instance_id,true);
    PERFORM identity.assistant_panel_prune(p_assistant,v_owner);
    SELECT jsonb_build_object('revision',h.revision::text,'changes',COALESCE((SELECT jsonb_agg(to_jsonb(c) ||
        jsonb_build_object('revision',c.revision::text,'expected_item_revision',c.expected_item_revision::text) ORDER BY revision)
        FROM identity.assistant_panel_changes c WHERE assistant_user_id = p_assistant AND source = 'panel' AND operation <> 'notice' AND status IN ('pending','failed') AND terminal_at IS NULL),'[]'::jsonb),
      'notices',COALESCE((SELECT jsonb_agg(to_jsonb(c) || jsonb_build_object('revision',c.revision::text,'expected_item_revision',c.expected_item_revision::text) ORDER BY revision)
        FROM identity.assistant_panel_changes c WHERE assistant_user_id = p_assistant AND operation = 'notice' AND status = 'pending'),'[]'::jsonb))
      INTO v_result FROM identity.assistant_panel_items h
      WHERE assistant_user_id = p_assistant AND domain = 'control' AND resource_key = '__head__';
    IF octet_length((v_result - 'notices')::text) > 16777216 THEN
        RAISE EXCEPTION 'Assistant pending changes exceed the complete response budget' USING ERRCODE = '54000';
    END IF;
    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION identity.assistant_panel_ack(p_assistant text, p_runtime_instance_id text, p_operation_id uuid, p_error_code text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text; v_device text; v_change identity.assistant_panel_changes%ROWTYPE;
BEGIN
    v_owner := identity.assistant_panel_lock(p_assistant);
    v_device := identity.assistant_panel_runtime(p_assistant,p_runtime_instance_id,true);
    SELECT * INTO v_change FROM identity.assistant_panel_changes WHERE operation_id = p_operation_id
        AND assistant_user_id = p_assistant AND owner_user_id = v_owner AND source = 'panel';
    IF NOT FOUND THEN RAISE EXCEPTION 'Assistant panel change not found' USING ERRCODE = 'P0002'; END IF;
    IF v_change.terminal_at IS NOT NULL THEN
        RETURN jsonb_build_object('operationId',p_operation_id,'status',v_change.status,'revision',v_change.revision::text,
            'terminal',true,'errorCode',v_change.error_code);
    END IF;
    IF v_change.operation = 'notice' THEN
        IF v_change.status = 'pending' AND p_error_code IS NULL THEN
            UPDATE identity.assistant_panel_changes SET status = 'applied',applied_at = clock_timestamp(),applied_device_id = v_device
              WHERE operation_id = p_operation_id;
            v_change.status := 'applied';
        END IF;
        PERFORM identity.assistant_panel_prune(p_assistant,v_owner);
        RETURN jsonb_build_object('operationId',p_operation_id,'status',v_change.status,'revision',v_change.revision::text);
    END IF;
    IF p_error_code IS NOT NULL AND p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
        RAISE EXCEPTION 'Application failure requires a non-sensitive error code' USING ERRCODE = '22023';
    END IF;
    IF v_change.status IN ('applied','superseded') THEN
        RETURN jsonb_build_object('operationId',p_operation_id,'status',v_change.status,'revision',v_change.revision::text);
    END IF;
    IF EXISTS (SELECT 1 FROM identity.assistant_panel_changes WHERE assistant_user_id = p_assistant
        AND source = 'panel' AND operation <> 'notice' AND status IN ('pending','failed') AND terminal_at IS NULL AND revision < v_change.revision) THEN
        RAISE EXCEPTION 'Earlier assistant panel changes must be applied first' USING ERRCODE = '55000';
    END IF;
    UPDATE identity.assistant_panel_changes SET status = CASE WHEN p_error_code IS NULL THEN 'applied' ELSE 'failed' END,
        applied_at = CASE WHEN p_error_code IS NULL THEN clock_timestamp() END,
        applied_device_id = CASE WHEN p_error_code IS NULL THEN v_device END,error_code = p_error_code WHERE operation_id = p_operation_id;
    PERFORM identity.assistant_panel_prune(p_assistant,v_owner);
    PERFORM chat.send_user_event(jsonb_build_object('assistantId',p_assistant,'operationId',p_operation_id,
        'applicationStatus',CASE WHEN p_error_code IS NULL THEN 'applied' ELSE 'failed' END),
        'assistant_panel_changed','gugu:user:' || v_owner || ':events',true);
    RETURN jsonb_build_object('operationId',p_operation_id,'revision',v_change.revision::text,
        'status',CASE WHEN p_error_code IS NULL THEN 'applied' ELSE 'failed' END,
        'domain',v_change.domain,'resourceKey',v_change.resource_key,'errorCode',p_error_code);
END;
$$;

CREATE OR REPLACE FUNCTION identity.assistant_panel_admit(p_assistant text, p_runtime_instance_id text, p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text; v_revision bigint; v_change identity.assistant_panel_changes%ROWTYPE;
BEGIN
    v_owner := identity.assistant_panel_lock(p_assistant);
    PERFORM identity.assistant_panel_runtime(p_assistant,p_runtime_instance_id,true);
    SELECT revision INTO v_revision FROM identity.assistant_panel_items
      WHERE assistant_user_id = p_assistant AND domain = 'control' AND resource_key = '__head__';
    IF p_expected_revision IS NULL OR v_revision <> p_expected_revision THEN
        RAISE EXCEPTION 'Assistant panel changed before admission; apply current changes' USING ERRCODE = '40001';
    END IF;
    SELECT * INTO v_change FROM identity.assistant_panel_changes WHERE assistant_user_id = p_assistant
        AND source = 'panel' AND operation <> 'notice' AND status IN ('pending','failed') AND terminal_at IS NULL ORDER BY revision LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('admitted',false,'revision',v_revision::text,'operationId',v_change.operation_id,
            'domain',v_change.domain,'resourceKey',v_change.resource_key,'errorCode',v_change.error_code);
    END IF;
    RETURN jsonb_build_object('admitted',true,'revision',v_revision::text);
END;
$$;

CREATE OR REPLACE FUNCTION identity.assistant_panel_prune(p_assistant text, p_owner text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_receipt identity.assistant_panel_changes%ROWTYPE; v_body uuid;
BEGIN
    -- Metadata hints are best-effort recent context, never required intent.
    -- Retain at most 64 pending notices for seven days, independent of budgets.
    UPDATE identity.assistant_panel_changes SET status = 'superseded',payload = '{}',applied_at = clock_timestamp()
      WHERE assistant_user_id = p_assistant AND operation = 'notice' AND status = 'pending'
        AND (created_at < clock_timestamp() - interval '7 days' OR operation_id IN (
          SELECT operation_id FROM identity.assistant_panel_changes WHERE assistant_user_id = p_assistant
            AND operation = 'notice' AND status = 'pending' ORDER BY revision DESC OFFSET 64));
    FOR v_receipt IN SELECT * FROM identity.assistant_panel_changes
      WHERE assistant_user_id = p_assistant AND (status IN ('applied','superseded') OR terminal_at IS NOT NULL)
        AND COALESCE(applied_at,terminal_at,created_at) < clock_timestamp() - interval '30 days'
      ORDER BY cleanup_attempted_at NULLS FIRST,revision LIMIT 100
    LOOP
        BEGIN
            v_body := (v_receipt.payload->>'bodyItemId')::uuid;
            IF v_body IS NOT NULL AND NOT EXISTS (SELECT 1 FROM identity.assistant_panel_items WHERE body_item_id = v_body)
              AND NOT EXISTS (SELECT 1 FROM identity.assistant_panel_changes
                WHERE operation_id <> v_receipt.operation_id AND payload->>'bodyItemId' = v_body::text) THEN
                UPDATE identity.assistant_panel_changes SET payload = payload - 'bodyItemId' - 'bodySha256'
                  WHERE operation_id = v_receipt.operation_id;
                IF EXISTS (SELECT 1 FROM chat.workspace_items WHERE id = v_body) THEN
                    PERFORM chat.workspace_delete_as(v_body::text,p_owner);
                END IF;
            END IF;
            DELETE FROM identity.assistant_panel_changes WHERE operation_id = v_receipt.operation_id;
        EXCEPTION WHEN OTHERS THEN
            -- Preserve only this receipt/reference for a later attempt. Cleanup
            -- never rolls back other receipts or an application acknowledgement.
            UPDATE identity.assistant_panel_changes SET cleanup_attempted_at = clock_timestamp()
              WHERE operation_id = v_receipt.operation_id;
        END;
    END LOOP;
END;
$$;

-- Restore explicit API grants after the installation DDL privilege guard.
REVOKE ALL ON FUNCTION identity.assistant_panel_snapshot(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_panel_snapshot(text) TO authenticated;
REVOKE ALL ON FUNCTION identity.assistant_panel_pending(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_panel_pending(text,text) TO authenticated;
REVOKE ALL ON FUNCTION identity.assistant_panel_ack(text,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_panel_ack(text,text,uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION identity.assistant_panel_admit(text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_panel_admit(text,text,bigint) TO authenticated;
REVOKE ALL ON FUNCTION identity.assistant_panel_prune(text,text) FROM PUBLIC,anon,authenticated;
