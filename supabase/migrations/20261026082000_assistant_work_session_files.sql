-- Work delivery uses the existing native session-file receipt, not a workspace
-- copy. Keep its original sender, addressed recipient, hash and byte count.
CREATE FUNCTION identity.assistant_work_attachment(p_ref jsonb,p_event jsonb,p_work identity.assistant_work)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_target text; v_sender text;
BEGIN
    IF p_work.owner_user_id IS DISTINCT FROM auth.uid()::text OR jsonb_typeof(p_ref) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Attachment reference is not visible to this account' USING ERRCODE = '42501';
    END IF;
    IF p_ref ? 'item_id' AND p_ref - 'item_id' = '{}' THEN
        IF NOT EXISTS (SELECT 1 FROM chat.workspace_items i WHERE i.id::text = p_ref->>'item_id'
          AND chat.history_floor(i.chat_id,p_work.owner_user_id) IS NOT NULL) THEN
            RAISE EXCEPTION 'Attachment reference is not visible to this account' USING ERRCODE = '42501';
        END IF;
        RETURN;
    END IF;
    IF p_ref - ARRAY['attachment_id','file_name','sha256','size_bytes','content_type'] <> '{}'
      OR COALESCE(p_ref->>'attachment_id','') !~ '^[0-9a-fA-F-]{36}$'
      OR COALESCE(p_ref->>'sha256','') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(p_ref->'size_bytes') IS DISTINCT FROM 'number'
      OR COALESCE(p_ref->>'size_bytes','') !~ '^[0-9]{1,18}$'
      OR jsonb_typeof(p_ref->'file_name') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_ref->'content_type') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Invalid session attachment metadata' USING ERRCODE = '22023';
    END IF;
    IF p_event->>'to_session_id' = p_work.coordinator_session_id THEN v_target := p_work.assistant_user_id;
    ELSE SELECT x->>'agent_user_id' INTO v_target FROM jsonb_array_elements(p_work.executors) x WHERE x->>'session_id' = p_event->>'to_session_id';
    END IF;
    IF p_event->>'from_session_id' = p_work.coordinator_session_id THEN v_sender := p_work.assistant_user_id;
    ELSE SELECT x->>'agent_user_id' INTO v_sender FROM jsonb_array_elements(p_work.executors) x WHERE x->>'session_id' = p_event->>'from_session_id';
    END IF;
    IF v_target IS NULL OR NOT EXISTS (
      SELECT 1 FROM chat.session_attachments a JOIN chat.file_blobs b ON b.id = a.blob_id
      WHERE a.id = (p_ref->>'attachment_id')::uuid AND a.owner_user_id = p_work.owner_user_id
        AND a.revoked_at IS NULL AND b.state = 'live'
        AND a.sender_session_id = p_event->>'from_session_id'
        AND (v_sender IS NULL OR a.sender_user_id = v_sender)
        AND v_target = ANY(a.recipient_user_ids)
        AND a.file_name = p_ref->>'file_name' AND b.sha256 = p_ref->>'sha256'
        AND b.size_bytes = (p_ref->>'size_bytes')::bigint AND b.content_type = p_ref->>'content_type'
    ) THEN RAISE EXCEPTION 'Session attachment metadata or addressed recipient is not valid' USING ERRCODE = '42501'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_attachment(jsonb,jsonb,identity.assistant_work) FROM PUBLIC,anon,authenticated;

-- Keep the complete API definition reviewable; restore its caller grant after
-- the installation DDL guard has checked the replacement.
CREATE OR REPLACE FUNCTION identity.assistant_work_commit(
    p_assistant text,p_runtime_instance_id text,p_operation_id uuid,p_work_id uuid,p_task jsonb,p_events jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_owner text := identity.assistant_work_require_owner(p_assistant);
    v_device text := identity.assistant_work_runtime(p_runtime_instance_id);
    v_work identity.assistant_work;
    v_prior identity.assistant_work_events;
    v_event jsonb; v_target jsonb; v_ref jsonb; v_subject text; v_kind text; v_message uuid;
    v_hash text := encode(sha256(convert_to(jsonb_build_object('assistant',p_assistant,'work',p_work_id,'task',p_task,'events',p_events)::text,'UTF8')),'hex');
    v_event_hash text; v_seq bigint; v_ids jsonb := '[]'; v_created boolean := false;
    v_status text; v_terminal boolean; v_outcome text; v_origin text;
BEGIN
    IF p_operation_id IS NULL OR p_work_id IS NULL OR jsonb_typeof(p_events) IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 32 OR octet_length(p_events::text) > 1048576 THEN
        RAISE EXCEPTION 'Invalid work operation or events' USING ERRCODE = '22023';
    END IF;
    -- One account operation and one work item cannot be interleaved by retries.
    PERFORM pg_advisory_xact_lock(hashtextextended('assistant-work-op:' || v_owner || ':' || p_operation_id,0));
    PERFORM pg_advisory_xact_lock(hashtextextended('assistant-work:' || v_owner || ':' || p_work_id,0));
    SELECT * INTO v_prior FROM identity.assistant_work_events WHERE owner_user_id = v_owner AND operation_id = p_operation_id LIMIT 1;
    IF FOUND THEN
        IF v_prior.operation_hash <> v_hash OR v_prior.work_id <> p_work_id THEN
            RAISE EXCEPTION 'Operation ID reused for a different request' USING ERRCODE = '22023';
        END IF;
        SELECT * INTO STRICT v_work FROM identity.assistant_work WHERE owner_user_id = v_owner AND work_id = p_work_id AND assistant_user_id = p_assistant;
        SELECT jsonb_agg(message_id::text ORDER BY seq) INTO v_ids FROM identity.assistant_work_events WHERE owner_user_id = v_owner AND operation_id = p_operation_id;
        RETURN jsonb_build_object('work_id',p_work_id,'event_ids',v_ids,'outcome',v_work.outcome,'terminal_version',v_work.terminal_version::text);
    END IF;
    SELECT * INTO v_work FROM identity.assistant_work WHERE owner_user_id = v_owner AND work_id = p_work_id FOR UPDATE;
    IF FOUND THEN
        IF v_work.assistant_user_id <> p_assistant THEN RAISE EXCEPTION 'Work belongs to a different assistant' USING ERRCODE = '42501'; END IF;
        IF p_task IS NOT NULL AND p_task IS DISTINCT FROM v_work.initial_task THEN
            RAISE EXCEPTION 'Work ID reused for a different task' USING ERRCODE = '22023';
        END IF;
    ELSE
        IF p_task IS NULL OR jsonb_typeof(p_task) <> 'object' OR octet_length(p_task::text) > 16384
          OR p_task - ARRAY['title','coordinator_session_id','executors','source_link'] <> '{}'
          OR NOT (p_task->>'title' <> '')
          OR length(p_task->>'title') NOT BETWEEN 1 AND 500
          OR COALESCE(p_task->>'coordinator_session_id','') !~ '^[a-zA-Z0-9_-]{1,128}$'
          OR jsonb_typeof(p_task->'executors') IS DISTINCT FROM 'array' OR jsonb_array_length(p_task->'executors') NOT BETWEEN 1 AND 32 THEN
            RAISE EXCEPTION 'Invalid task or executor targets' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM identity.users WHERE id = p_assistant AND device_id = v_device) THEN
            RAISE EXCEPTION 'Dispatch coordinator must use the assistant home device' USING ERRCODE = '42501';
        END IF;
        IF (SELECT count(DISTINCT x->>'session_id') FROM jsonb_array_elements(p_task->'executors') x) <> jsonb_array_length(p_task->'executors') THEN
            RAISE EXCEPTION 'Duplicate executor targets' USING ERRCODE = '22023';
        END IF;
        FOR v_target IN SELECT value FROM jsonb_array_elements(p_task->'executors') LOOP
            IF COALESCE(v_target->>'session_id','') !~ '^[a-zA-Z0-9_-]{1,128}$'
              OR NOT EXISTS (SELECT 1 FROM identity.gugu_devices WHERE device_id = v_target->>'device_id' AND user_id::text = v_owner)
              OR (v_target ? 'agent_user_id' AND NOT EXISTS (SELECT 1 FROM identity.users WHERE id = v_target->>'agent_user_id'
                AND type = 'agent' AND owner_user_id = v_owner AND device_id = v_target->>'device_id')) THEN
                RAISE EXCEPTION 'Executor target device or agent is not owned' USING ERRCODE = '42501';
            END IF;
        END LOOP;
        INSERT INTO identity.assistant_work(owner_user_id,work_id,assistant_user_id,title,coordinator_session_id,coordinator_device_id,executors,initial_task,source_link)
          VALUES(v_owner,p_work_id,p_assistant,p_task->>'title',p_task->>'coordinator_session_id',v_device,p_task->'executors',p_task,p_task->>'source_link') RETURNING * INTO v_work;
        v_created := true;
    END IF;
    FOR v_event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
        v_kind := v_event->>'kind';
        v_message := (v_event->>'message_id')::uuid;
        IF v_message IS NULL OR v_kind IS NULL OR v_kind NOT IN ('dispatch','progress','question','completed','cancelled','failed','blocked')
          OR COALESCE(v_event->>'from_session_id','') !~ '^[a-zA-Z0-9_-]{1,128}$'
          OR COALESCE(v_event->>'to_session_id','') !~ '^[a-zA-Z0-9_-]{1,128}$'
          OR v_event->>'from_device_id' IS DISTINCT FROM v_device
          OR ((v_event->>'content' IS NOT NULL) = (v_event->>'source_message_id' IS NOT NULL))
          OR ((v_event->>'source_chat_id' IS NULL) <> (v_event->>'source_message_id' IS NULL))
          OR (v_event ? 'attachment_refs' AND (jsonb_typeof(v_event->'attachment_refs') <> 'array' OR jsonb_array_length(v_event->'attachment_refs') > 32))
          OR (v_event->>'reason_code' IS NOT NULL AND v_event->>'reason_code' !~ '^[A-Z0-9_]{1,80}$') THEN
            RAISE EXCEPTION 'Invalid event, sender runtime or endpoint' USING ERRCODE = '22023';
        END IF;
        v_subject := COALESCE(v_event->>'executor_session_id',CASE WHEN v_kind = 'dispatch' THEN v_event->>'to_session_id' ELSE v_event->>'from_session_id' END);
        SELECT value INTO v_target FROM jsonb_array_elements(v_work.executors) WHERE value->>'session_id' = v_subject;
        IF NOT FOUND THEN RAISE EXCEPTION 'Event executor endpoint is not part of this work' USING ERRCODE = '42501'; END IF;
        IF v_kind = 'dispatch' THEN
            IF v_event->>'from_session_id' <> v_work.coordinator_session_id OR v_device <> v_work.coordinator_device_id
              OR v_event->>'to_session_id' <> v_subject OR v_event->>'to_device_id' <> v_target->>'device_id' THEN
                RAISE EXCEPTION 'Dispatch endpoint does not match stored target' USING ERRCODE = '42501';
            END IF;
        ELSIF NOT ((v_event->>'from_session_id' = v_subject AND v_device = v_target->>'device_id')
          OR (v_kind IN ('failed','blocked') AND v_event->>'from_session_id' = v_work.coordinator_session_id AND v_device = v_work.coordinator_device_id))
          OR v_event->>'to_session_id' <> v_work.coordinator_session_id OR v_event->>'to_device_id' <> v_work.coordinator_device_id THEN
            RAISE EXCEPTION 'Report sender or recipient endpoint does not match this work' USING ERRCODE = '42501';
        END IF;
        IF v_event->>'source_message_id' IS NOT NULL THEN PERFORM identity.assistant_work_source(v_event->>'source_chat_id',v_event->>'source_message_id',v_owner); END IF;
        FOR v_ref IN SELECT value FROM jsonb_array_elements(COALESCE(v_event->'attachment_refs','[]')) LOOP
            PERFORM identity.assistant_work_attachment(v_ref,v_event,v_work);
        END LOOP;
        v_event_hash := encode(sha256(convert_to(jsonb_build_object('work',p_work_id,'event',v_event)::text,'UTF8')),'hex');
        SELECT * INTO v_prior FROM identity.assistant_work_events WHERE owner_user_id = v_owner AND message_id = v_message;
        IF FOUND THEN
            IF v_prior.event_hash <> v_event_hash THEN RAISE EXCEPTION 'Message ID reused for different work or content' USING ERRCODE = '22023'; END IF;
            v_ids := v_ids || jsonb_build_array(v_message::text); CONTINUE;
        END IF;
        v_terminal := v_kind IN ('completed','cancelled','failed');
        v_origin := CASE WHEN v_event->>'from_session_id' = v_subject AND v_device = v_target->>'device_id' THEN 'executor' ELSE 'coordinator' END;
        v_status := v_work.executor_outcomes->v_subject->>'status';
        IF v_terminal AND v_status IS NOT NULL AND v_origin = 'executor'
          AND COALESCE(v_work.executor_outcomes->v_subject->>'origin','executor') = 'executor' AND v_status <> v_kind THEN
            RAISE EXCEPTION 'Executor reported conflicting terminal results' USING ERRCODE = '55000';
        END IF;
        INSERT INTO identity.assistant_work_events(owner_user_id,work_id,operation_id,operation_hash,message_id,event_hash,kind,
          from_session_id,from_device_id,to_session_id,to_device_id,executor_session_id,content,attachment_refs,source_chat_id,source_message_id,reason_code,terminal_origin)
          VALUES(v_owner,p_work_id,p_operation_id,v_hash,v_message,v_event_hash,v_kind,v_event->>'from_session_id',v_device,
            v_event->>'to_session_id',v_event->>'to_device_id',v_subject,v_event->>'content',COALESCE(v_event->'attachment_refs','[]'),
            v_event->>'source_chat_id',v_event->>'source_message_id',v_event->>'reason_code',CASE WHEN v_terminal THEN v_origin END) RETURNING seq INTO v_seq;
        -- A reconciler's inference cannot suppress a later executor result or its files.
        -- Conversely, a later inference never changes an executor's authoritative outcome.
        IF v_terminal AND (v_status IS NULL OR v_origin = 'executor') THEN
            v_work.executor_outcomes := v_work.executor_outcomes || jsonb_build_object(v_subject,jsonb_build_object('status',v_kind,'origin',v_origin,'message_id',v_message,'version',v_seq::text));
            v_outcome := 'active';
            IF (SELECT count(*) FROM jsonb_object_keys(v_work.executor_outcomes)) = jsonb_array_length(v_work.executors) THEN
                SELECT CASE WHEN bool_or(value->>'status' = 'failed') THEN 'failed'
                  WHEN bool_or(value->>'status' = 'cancelled') THEN 'cancelled' ELSE 'completed' END INTO v_outcome FROM jsonb_each(v_work.executor_outcomes);
            END IF;
            UPDATE identity.assistant_work SET executor_outcomes = v_work.executor_outcomes,outcome = v_outcome,
              terminal_version = v_seq,updated_at = clock_timestamp() WHERE owner_user_id = v_owner AND work_id = p_work_id RETURNING * INTO v_work;
        END IF;
        IF v_terminal THEN UPDATE identity.assistant_work_events SET terminal_version = v_work.terminal_version WHERE seq = v_seq; END IF;
        v_ids := v_ids || jsonb_build_array(v_message::text);
    END LOOP;
    IF v_created AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_work.executors) x WHERE NOT EXISTS (
      SELECT 1 FROM identity.assistant_work_events e WHERE e.owner_user_id = v_owner AND e.work_id = p_work_id AND e.kind = 'dispatch' AND e.to_session_id = x->>'session_id'
    )) THEN RAISE EXCEPTION 'Every executor target requires an atomic dispatch event' USING ERRCODE = '22023'; END IF;
    RETURN jsonb_build_object('work_id',p_work_id,'event_ids',v_ids,'outcome',v_work.outcome,'terminal_version',v_work.terminal_version::text);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_commit(text,text,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_commit(text,text,uuid,uuid,jsonb,jsonb) TO authenticated;
