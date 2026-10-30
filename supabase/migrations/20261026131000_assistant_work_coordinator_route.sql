-- Preserve original work/event addresses. The current owned home explicitly
-- publishes its local Gugu session; provider session IDs are never routing IDs.
ALTER TABLE identity.assistant_work
  ADD COLUMN current_coordinator_session_id text,
  ADD COLUMN current_coordinator_device_id text;

CREATE FUNCTION identity.assistant_work_coordinator(p_owner text,p_work uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT CASE
    WHEN w.current_coordinator_device_id=u.device_id AND w.current_coordinator_session_id IS NOT NULL
      THEN jsonb_build_object('session_id',w.current_coordinator_session_id,'device_id',u.device_id)
    WHEN w.coordinator_device_id=u.device_id
      THEN jsonb_build_object('session_id',w.coordinator_session_id,'device_id',u.device_id)
    ELSE NULL END
  FROM identity.assistant_work w JOIN identity.users u ON u.id=w.assistant_user_id AND u.owner_user_id=w.owner_user_id
  WHERE w.owner_user_id=p_owner AND w.work_id=p_work;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_coordinator(text,uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION identity.assistant_work_coordinator_bind(p_assistant text,p_runtime_instance_id text,p_session_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_owner text:=identity.assistant_work_require_owner(p_assistant); v_device text:=identity.assistant_work_runtime(p_runtime_instance_id); v_count integer;
BEGIN
  IF COALESCE(p_session_id,'') !~ '^[a-zA-Z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'Invalid coordinator session' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM identity.users WHERE id=p_assistant AND owner_user_id=v_owner AND device_id=v_device) THEN
    RAISE EXCEPTION 'Coordinator binding requires the current assistant home runtime' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('assistant-work-coordinator:'||v_owner||':'||p_assistant,0));
  UPDATE identity.assistant_work SET current_coordinator_session_id=p_session_id,current_coordinator_device_id=v_device
    WHERE owner_user_id=v_owner AND assistant_user_id=p_assistant
      AND (COALESCE(current_coordinator_session_id,coordinator_session_id),COALESCE(current_coordinator_device_id,coordinator_device_id)) IS DISTINCT FROM (p_session_id,v_device);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN
    PERFORM chat.send_user_event(jsonb_build_object('assistantId',p_assistant),'assistant_work_changed','gugu:user:'||v_owner||':events',true);
  END IF;
  RETURN jsonb_build_object('coordinator_current',jsonb_build_object('session_id',p_session_id,'device_id',v_device),'bound_count',v_count);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_coordinator_bind(text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_coordinator_bind(text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION identity.assistant_work_attachment(p_ref jsonb,p_event jsonb,p_work identity.assistant_work)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_target text; v_sender text; v_current jsonb:=identity.assistant_work_coordinator(p_work.owner_user_id,p_work.work_id);
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
    IF (p_event->>'to_session_id' = p_work.coordinator_session_id OR p_event->>'to_session_id' = v_current->>'session_id') THEN v_target := p_work.assistant_user_id;
    ELSE SELECT x->>'agent_user_id' INTO v_target FROM jsonb_array_elements(p_work.executors) x WHERE x->>'session_id' = p_event->>'to_session_id';
    END IF;
    IF (p_event->>'from_session_id' = p_work.coordinator_session_id OR p_event->>'from_session_id' = v_current->>'session_id') THEN v_sender := p_work.assistant_user_id;
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
    v_status text; v_terminal boolean; v_outcome text; v_origin text; v_current jsonb;
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
        v_current:=identity.assistant_work_coordinator(v_owner,p_work_id);
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
            IF v_current IS NULL OR v_event->>'from_session_id' <> v_current->>'session_id' OR v_device <> v_current->>'device_id'
              OR v_event->>'to_session_id' <> v_subject OR v_event->>'to_device_id' <> v_target->>'device_id' THEN
                RAISE EXCEPTION 'Dispatch endpoint does not match stored target' USING ERRCODE = '42501';
            END IF;
        ELSIF NOT ((v_event->>'from_session_id' = v_subject AND v_device = v_target->>'device_id')
          OR (v_kind IN ('failed','blocked') AND v_current IS NOT NULL AND v_event->>'from_session_id' = v_current->>'session_id' AND v_device = v_current->>'device_id'))
          OR NOT ((v_event->>'to_session_id' = v_work.coordinator_session_id AND v_event->>'to_device_id' = v_work.coordinator_device_id)
            OR (v_current IS NOT NULL AND v_event->>'to_session_id' = v_current->>'session_id' AND v_event->>'to_device_id' = v_current->>'device_id')) THEN
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

CREATE OR REPLACE FUNCTION identity.assistant_work_list(p_assistant text,p_before bigint DEFAULT NULL,p_limit integer DEFAULT 50,p_reconcile_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := identity.assistant_work_require_owner(p_assistant); v_items jsonb; v_next text;
BEGIN
    IF p_reconcile_only IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_before <= 0 THEN RAISE EXCEPTION 'Invalid work list page' USING ERRCODE = '22023'; END IF;
    WITH page AS MATERIALIZED (
      SELECT w.*,row_number() OVER (ORDER BY created_seq DESC) AS n FROM identity.assistant_work w
      WHERE owner_user_id = v_owner AND assistant_user_id = p_assistant AND (p_before IS NULL OR created_seq < p_before)
        AND (NOT p_reconcile_only OR w.outcome='active' OR EXISTS (
          SELECT 1 FROM identity.assistant_work_events e WHERE e.owner_user_id=w.owner_user_id AND e.work_id=w.work_id
            AND e.kind IN ('completed','cancelled','failed','question') AND e.delivery_state<>'abandoned' AND e.owner_delivered_at IS NULL
            AND NOT ((e.terminal_origin IS NOT DISTINCT FROM 'coordinator' OR e.kind='question')
              AND (w.outcome IN ('completed','cancelled') OR COALESCE(w.executor_outcomes->e.executor_session_id->>'origin','')='executor'))
        ) OR EXISTS (
          SELECT 1 FROM identity.assistant_work_notice_pending(v_owner) g WHERE g.work_id=w.work_id AND g.pending AND NOT g.notified
        ))
      ORDER BY created_seq DESC LIMIT p_limit + 1
    ) SELECT COALESCE(jsonb_agg((to_jsonb(p) - ARRAY['n','initial_task','current_coordinator_session_id','current_coordinator_device_id']) || jsonb_build_object('created_seq',created_seq::text,'terminal_version',terminal_version::text,'coordinator_current',identity.assistant_work_coordinator(owner_user_id,work_id))
      ORDER BY created_seq DESC) FILTER (WHERE n <= p_limit),'[]'),CASE WHEN count(*) > p_limit THEN min(created_seq) FILTER (WHERE n <= p_limit)::text END
      INTO v_items,v_next FROM page p;
    RETURN jsonb_build_object('items',v_items,'next_before',v_next);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_list(text,bigint,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_list(text,bigint,integer,boolean) TO authenticated;



CREATE OR REPLACE FUNCTION identity.assistant_work_history(p_assistant text,p_work_id uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := identity.assistant_work_require_owner(p_assistant); v_work identity.assistant_work; v_task jsonb; v_events jsonb := '[]'; v_event identity.assistant_work_events; v_count integer := 0; v_next text; v_body text;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR p_after IS NULL OR p_after < 0 THEN RAISE EXCEPTION 'Invalid history page' USING ERRCODE = '22023'; END IF;
    SELECT * INTO v_work FROM identity.assistant_work WHERE owner_user_id = v_owner AND work_id = p_work_id AND assistant_user_id = p_assistant;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Work is not available to this account' USING ERRCODE = '42501';
    END IF;
    v_task := (to_jsonb(v_work) - ARRAY['initial_task','current_coordinator_session_id','current_coordinator_device_id']) || jsonb_build_object('created_seq',v_work.created_seq::text,'terminal_version',v_work.terminal_version::text,'coordinator_current',identity.assistant_work_coordinator(v_owner,p_work_id));
    FOR v_event IN SELECT * FROM identity.assistant_work_events WHERE owner_user_id = v_owner AND work_id = p_work_id AND seq > p_after ORDER BY seq LIMIT p_limit + 1 LOOP
        IF v_count = p_limit THEN RETURN jsonb_build_object('work',v_task,'events',v_events,'next_after',v_next); END IF;
        v_body := CASE WHEN v_event.source_message_id IS NULL THEN v_event.content
          ELSE identity.assistant_work_source(v_event.source_chat_id,v_event.source_message_id,v_owner,false) END;
        v_events := v_events || jsonb_build_array((to_jsonb(v_event) - ARRAY['operation_hash','event_hash','lease_token','lease_instance_id','notice_wake_attempts','notice_wake_available_at','notice_wake_token','notice_wake_instance_id','notice_wake_until'])
          || jsonb_build_object('seq',v_event.seq::text,'terminal_version',v_event.terminal_version::text,'content',v_body,'source_available',v_body IS NOT NULL,'coordinator_current',identity.assistant_work_coordinator(v_owner,p_work_id),
            'delivery_target',CASE WHEN v_event.kind='dispatch' THEN jsonb_build_object('session_id',v_event.to_session_id,'device_id',v_event.to_device_id) ELSE identity.assistant_work_coordinator(v_owner,p_work_id) END));
        v_next := v_event.seq::text; v_count := v_count + 1;
    END LOOP;
    RETURN jsonb_build_object('work',v_task,'events',v_events,'next_after',NULL);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_history(text,uuid,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_history(text,uuid,bigint,integer) TO authenticated;


CREATE OR REPLACE FUNCTION identity.assistant_work_outbox_claim(p_runtime_instance_id text,p_limit integer DEFAULT 20,p_lease_seconds integer DEFAULT 60)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := auth.uid()::text; v_result jsonb;
BEGIN
    PERFORM identity.assistant_work_runtime(p_runtime_instance_id);
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 90 THEN
        RAISE EXCEPTION 'Invalid outbox lease parameters' USING ERRCODE = '22023';
    END IF;
    WITH candidates AS MATERIALIZED (
      SELECT e.seq FROM identity.assistant_work_events e WHERE e.owner_user_id = v_owner
        AND NOT EXISTS (
          SELECT 1 FROM identity.assistant_work_events older WHERE older.owner_user_id=e.owner_user_id AND older.work_id=e.work_id
            AND older.seq<e.seq AND older.delivery_state IN ('pending','claimed') AND (
              (e.kind<>'dispatch' AND older.kind<>'dispatch') OR (e.kind='dispatch' AND older.kind='dispatch' AND older.to_device_id=e.to_device_id AND older.to_session_id=e.to_session_id))
        )
        AND ((e.delivery_state = 'pending' AND e.available_at <= clock_timestamp()) OR (e.delivery_state = 'claimed' AND e.lease_until < clock_timestamp()))
      ORDER BY e.seq FOR UPDATE SKIP LOCKED LIMIT p_limit
    ), claimed AS (
      UPDATE identity.assistant_work_events e SET delivery_state = 'claimed',lease_token = gen_random_uuid(),lease_instance_id = p_runtime_instance_id,
        lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),attempts = attempts + 1
      FROM candidates c WHERE e.seq = c.seq RETURNING e.*
    ) SELECT COALESCE(jsonb_agg((to_jsonb(c) - ARRAY['operation_hash','event_hash','notice_wake_attempts','notice_wake_available_at','notice_wake_token','notice_wake_instance_id','notice_wake_until']) || jsonb_build_object('seq',c.seq::text,'terminal_version',c.terminal_version::text,
      'content',CASE WHEN c.source_message_id IS NULL THEN c.content ELSE identity.assistant_work_source(c.source_chat_id,c.source_message_id,v_owner,false) END,
      'source_available',c.source_message_id IS NULL OR identity.assistant_work_source(c.source_chat_id,c.source_message_id,v_owner,false) IS NOT NULL,
      'assistant_user_id',w.assistant_user_id,'work_outcome',w.outcome,'work_terminal_version',w.terminal_version::text,
      'work_executor_outcomes',w.executor_outcomes,'coordinator_current',identity.assistant_work_coordinator(w.owner_user_id,w.work_id),
      'delivery_target',CASE WHEN c.kind='dispatch' THEN jsonb_build_object('session_id',c.to_session_id,'device_id',c.to_device_id) ELSE identity.assistant_work_coordinator(w.owner_user_id,w.work_id) END,
      'lease_remaining_ms',GREATEST(0,floor(extract(epoch FROM (c.lease_until-clock_timestamp()))*1000))::bigint,
      'age_ms',GREATEST(0,floor(extract(epoch FROM (clock_timestamp()-c.platform_received_at))*1000))::bigint) ORDER BY c.seq),'[]') INTO v_result FROM claimed c
      JOIN identity.assistant_work w ON w.owner_user_id = c.owner_user_id AND w.work_id = c.work_id;
    RETURN jsonb_build_object('events',v_result);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_outbox_claim(text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_outbox_claim(text,integer,integer) TO authenticated;
