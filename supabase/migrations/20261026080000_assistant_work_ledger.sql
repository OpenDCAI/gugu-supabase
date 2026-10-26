-- Account-owned work and collaboration. Events are the sole delivery outbox.
-- No runtime status, token stream or tool transcript is copied into these tables.
CREATE TABLE identity.assistant_work (
    owner_user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    work_id uuid NOT NULL,
    assistant_user_id text NOT NULL,
    created_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
    coordinator_session_id text NOT NULL,
    coordinator_device_id text NOT NULL,
    executors jsonb NOT NULL CHECK (jsonb_typeof(executors) = 'array'),
    initial_task jsonb NOT NULL,
    source_link text,
    outcome text NOT NULL DEFAULT 'active' CHECK (outcome IN ('active','completed','cancelled','failed')),
    executor_outcomes jsonb NOT NULL DEFAULT '{}',
    terminal_version bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_user_id,work_id)
);
CREATE INDEX assistant_work_account_list ON identity.assistant_work(owner_user_id,assistant_user_id,created_seq DESC);

CREATE TABLE identity.assistant_work_events (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_user_id text NOT NULL,
    work_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    operation_hash text NOT NULL,
    message_id uuid NOT NULL,
    event_hash text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('dispatch','progress','question','completed','cancelled','failed','blocked')),
    from_session_id text NOT NULL,
    from_device_id text NOT NULL,
    to_session_id text NOT NULL,
    to_device_id text NOT NULL,
    executor_session_id text NOT NULL,
    content text,
    attachment_refs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attachment_refs) = 'array'),
    source_chat_id text,
    source_message_id text,
    reason_code text,
    terminal_origin text CHECK (terminal_origin IN ('executor','coordinator')),
    terminal_version bigint NOT NULL DEFAULT 0,
    platform_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    delivery_state text NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','claimed','admitted','abandoned')),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_token uuid,
    lease_instance_id text,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    failed_attempts integer NOT NULL DEFAULT 0,
    last_error_code text,
    executor_admitted_at timestamptz,
    assistant_admitted_at timestamptz,
    owner_delivered_at timestamptz,
    owner_chat_id text,
    owner_message_id text,
    abandoned_at timestamptz,
    abandoned_reason_code text,
    abandonment_notified_at timestamptz,
    abandonment_notice_chat_id text,
    abandonment_notice_message_id text,
    UNIQUE (owner_user_id,message_id),
    FOREIGN KEY (owner_user_id,work_id) REFERENCES identity.assistant_work(owner_user_id,work_id) ON DELETE CASCADE,
    CHECK ((source_chat_id IS NULL) = (source_message_id IS NULL)),
    CHECK ((content IS NOT NULL) <> (source_message_id IS NOT NULL)),
    CHECK ((delivery_state = 'claimed') = (lease_until IS NOT NULL))
);
CREATE INDEX assistant_work_events_history ON identity.assistant_work_events(owner_user_id,work_id,seq);
CREATE INDEX assistant_work_events_operation ON identity.assistant_work_events(owner_user_id,operation_id);
CREATE INDEX assistant_work_events_pending ON identity.assistant_work_events(owner_user_id,available_at,seq) WHERE delivery_state <> 'admitted';
ALTER TABLE identity.assistant_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.assistant_work_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.assistant_work,identity.assistant_work_events FROM PUBLIC,anon,authenticated;
-- Bodies with cloud references must pass the original visibility rule through the RPC.

CREATE FUNCTION identity.assistant_work_require_owner(p_assistant text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := auth.uid()::text;
BEGIN
    IF v_owner IS NULL OR NOT EXISTS (
        SELECT 1 FROM identity.users u JOIN identity.agent_provisions p ON p.agent_user_id = u.id
        WHERE u.id = p_assistant AND u.owner_user_id = v_owner AND u.type = 'agent'
          AND p.owner_user_id = v_owner AND p.member_key = 'assistant' AND p.phase IN ('ready','completed')
    ) THEN RAISE EXCEPTION 'Assistant is not available to this account' USING ERRCODE = '42501'; END IF;
    RETURN v_owner;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_require_owner(text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION identity.assistant_work_runtime(p_instance text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_device text;
BEGIN
    SELECT i.device_id INTO v_device FROM identity.runtime_instances i
      JOIN identity.gugu_devices d ON d.device_id = i.device_id AND d.user_id = i.owner_user_id
      WHERE i.instance_id = p_instance AND i.owner_user_id = auth.uid()
        AND i.last_heartbeat_at > clock_timestamp() - interval '90 seconds';
    IF v_device IS NULL THEN RAISE EXCEPTION 'A current owned runtime lease is required' USING ERRCODE = '42501'; END IF;
    RETURN v_device;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_runtime(text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION identity.assistant_work_source(p_chat text,p_message text,p_owner text,p_required boolean DEFAULT true) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_content text;
BEGIN
    SELECT m.content INTO v_content FROM chat.messages m
      WHERE m.id = p_message AND m.chat_id = p_chat AND m.deleted_at IS NULL
        AND chat.message_visible_at(chat.history_floor(p_chat,p_owner),m.created_at,m.is_whisper,m.sender_user_id,m.to_user_ids,p_owner);
    IF NOT FOUND AND p_required THEN RAISE EXCEPTION 'Source message is not visible to this account' USING ERRCODE = '42501'; END IF;
    RETURN v_content;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_source(text,text,text,boolean) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION identity.assistant_work_commit(
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
            IF jsonb_typeof(v_ref) <> 'object' OR v_ref - ARRAY['item_id'] <> '{}' OR NOT EXISTS (
              SELECT 1 FROM chat.workspace_items i
              WHERE i.id::text = v_ref->>'item_id' AND chat.history_floor(i.chat_id,v_owner) IS NOT NULL
            ) THEN RAISE EXCEPTION 'Attachment reference is not visible to this account' USING ERRCODE = '42501'; END IF;
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

CREATE FUNCTION identity.assistant_work_list(p_assistant text,p_before bigint DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := identity.assistant_work_require_owner(p_assistant); v_items jsonb; v_next text;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_before <= 0 THEN RAISE EXCEPTION 'Invalid work list page' USING ERRCODE = '22023'; END IF;
    WITH page AS MATERIALIZED (
      SELECT w.*,row_number() OVER (ORDER BY created_seq DESC) AS n FROM identity.assistant_work w
      WHERE owner_user_id = v_owner AND assistant_user_id = p_assistant AND (p_before IS NULL OR created_seq < p_before)
      ORDER BY created_seq DESC LIMIT p_limit + 1
    ) SELECT COALESCE(jsonb_agg((to_jsonb(p) - ARRAY['n','initial_task']) || jsonb_build_object('created_seq',created_seq::text,'terminal_version',terminal_version::text)
      ORDER BY created_seq DESC) FILTER (WHERE n <= p_limit),'[]'),CASE WHEN count(*) > p_limit THEN min(created_seq) FILTER (WHERE n <= p_limit)::text END
      INTO v_items,v_next FROM page p;
    RETURN jsonb_build_object('items',v_items,'next_before',v_next);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_list(text,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_list(text,bigint,integer) TO authenticated;

CREATE FUNCTION identity.assistant_work_history(p_assistant text,p_work_id uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := identity.assistant_work_require_owner(p_assistant); v_events jsonb := '[]'; v_event identity.assistant_work_events; v_count integer := 0; v_next text; v_body text;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR p_after IS NULL OR p_after < 0 THEN RAISE EXCEPTION 'Invalid history page' USING ERRCODE = '22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM identity.assistant_work WHERE owner_user_id = v_owner AND work_id = p_work_id AND assistant_user_id = p_assistant) THEN
        RAISE EXCEPTION 'Work is not available to this account' USING ERRCODE = '42501';
    END IF;
    FOR v_event IN SELECT * FROM identity.assistant_work_events WHERE owner_user_id = v_owner AND work_id = p_work_id AND seq > p_after ORDER BY seq LIMIT p_limit + 1 LOOP
        IF v_count = p_limit THEN RETURN jsonb_build_object('events',v_events,'next_after',v_next); END IF;
        v_body := CASE WHEN v_event.source_message_id IS NULL THEN v_event.content
          ELSE identity.assistant_work_source(v_event.source_chat_id,v_event.source_message_id,v_owner,false) END;
        v_events := v_events || jsonb_build_array((to_jsonb(v_event) - ARRAY['operation_hash','event_hash','lease_token','lease_instance_id'])
          || jsonb_build_object('seq',v_event.seq::text,'terminal_version',v_event.terminal_version::text,'content',v_body,'source_available',v_body IS NOT NULL));
        v_next := v_event.seq::text; v_count := v_count + 1;
    END LOOP;
    RETURN jsonb_build_object('events',v_events,'next_after',NULL);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_history(text,uuid,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_history(text,uuid,bigint,integer) TO authenticated;

CREATE FUNCTION identity.assistant_work_outbox_claim(p_runtime_instance_id text,p_limit integer DEFAULT 20,p_lease_seconds integer DEFAULT 60)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := auth.uid()::text; v_result jsonb;
BEGIN
    PERFORM identity.assistant_work_runtime(p_runtime_instance_id);
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 90 THEN
        RAISE EXCEPTION 'Invalid outbox lease parameters' USING ERRCODE = '22023';
    END IF;
    WITH candidates AS MATERIALIZED (
      SELECT e.seq FROM identity.assistant_work_events e WHERE e.owner_user_id = v_owner
        AND ((e.delivery_state = 'pending' AND e.available_at <= clock_timestamp()) OR (e.delivery_state = 'claimed' AND e.lease_until < clock_timestamp()))
      ORDER BY e.seq FOR UPDATE SKIP LOCKED LIMIT p_limit
    ), claimed AS (
      UPDATE identity.assistant_work_events e SET delivery_state = 'claimed',lease_token = gen_random_uuid(),lease_instance_id = p_runtime_instance_id,
        lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),attempts = attempts + 1
      FROM candidates c WHERE e.seq = c.seq RETURNING e.*
    ) SELECT COALESCE(jsonb_agg((to_jsonb(c) - ARRAY['operation_hash','event_hash']) || jsonb_build_object('seq',c.seq::text,'terminal_version',c.terminal_version::text,
      'content',CASE WHEN c.source_message_id IS NULL THEN c.content ELSE identity.assistant_work_source(c.source_chat_id,c.source_message_id,v_owner,false) END,
      'source_available',c.source_message_id IS NULL OR identity.assistant_work_source(c.source_chat_id,c.source_message_id,v_owner,false) IS NOT NULL,
      'assistant_user_id',w.assistant_user_id,'work_outcome',w.outcome,'work_terminal_version',w.terminal_version::text,
      'work_executor_outcomes',w.executor_outcomes) ORDER BY c.seq),'[]') INTO v_result FROM claimed c
      JOIN identity.assistant_work w ON w.owner_user_id = c.owner_user_id AND w.work_id = c.work_id;
    RETURN jsonb_build_object('events',v_result);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_outbox_claim(text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_outbox_claim(text,integer,integer) TO authenticated;

CREATE FUNCTION identity.assistant_work_outbox_settle(
    p_runtime_instance_id text,p_message_id uuid,p_lease_token uuid,p_stage text,p_error_code text DEFAULT NULL,
    p_retry_after_seconds integer DEFAULT 5,p_receipt jsonb DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := auth.uid()::text; v_event identity.assistant_work_events; v_work identity.assistant_work;
BEGIN
    PERFORM identity.assistant_work_runtime(p_runtime_instance_id);
    IF p_stage IS NULL OR p_stage NOT IN ('executor_admitted','assistant_admitted','retry','abandoned')
      OR p_retry_after_seconds IS NULL OR p_retry_after_seconds NOT BETWEEN 1 AND 3600
      OR (p_error_code IS NOT NULL AND p_error_code !~ '^[A-Z0-9_]{1,80}$')
      OR (p_stage = 'abandoned' AND p_error_code IS NULL) OR jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Invalid outbox settlement' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_event FROM identity.assistant_work_events WHERE owner_user_id = v_owner AND message_id = p_message_id FOR UPDATE;
    IF NOT FOUND OR v_event.lease_token IS DISTINCT FROM p_lease_token OR p_lease_token IS NULL
      OR v_event.lease_instance_id IS DISTINCT FROM p_runtime_instance_id THEN RAISE EXCEPTION 'Outbox lease token does not match' USING ERRCODE = '55000'; END IF;
    IF v_event.delivery_state = 'admitted' AND ((p_stage = 'executor_admitted' AND v_event.executor_admitted_at IS NOT NULL)
      OR (p_stage = 'assistant_admitted' AND v_event.assistant_admitted_at IS NOT NULL)) THEN
        RETURN jsonb_build_object('message_id',p_message_id,'stage',p_stage);
    END IF;
    IF v_event.delivery_state = 'abandoned' AND p_stage = 'abandoned' AND v_event.abandoned_reason_code = p_error_code THEN
        RETURN jsonb_build_object('message_id',p_message_id,'stage',p_stage);
    END IF;
    IF v_event.delivery_state <> 'claimed' OR v_event.lease_until <= clock_timestamp() THEN RAISE EXCEPTION 'Outbox lease expired or was released' USING ERRCODE = '55000'; END IF;
    IF p_stage = 'abandoned' THEN
        UPDATE identity.assistant_work_events SET delivery_state = 'abandoned',lease_until = NULL,
          abandoned_at = clock_timestamp(),abandoned_reason_code = p_error_code,last_error_code = p_error_code,
          failed_attempts = failed_attempts + CASE WHEN p_receipt->>'failure_observed' = 'true' THEN 1 ELSE 0 END WHERE seq = v_event.seq;
    ELSIF p_stage = 'retry' THEN
        UPDATE identity.assistant_work_events SET delivery_state = 'pending',lease_until = NULL,lease_token = NULL,lease_instance_id = NULL,
          available_at = clock_timestamp() + make_interval(secs => p_retry_after_seconds),last_error_code = p_error_code,
          failed_attempts = failed_attempts + 1 WHERE seq = v_event.seq;
    ELSE
        IF (p_stage = 'executor_admitted') <> (v_event.kind = 'dispatch') THEN RAISE EXCEPTION 'Admission stage does not match event' USING ERRCODE = '22023'; END IF;
        IF p_receipt ? 'agent_user_id' THEN
            IF p_stage <> 'executor_admitted' OR NOT EXISTS (SELECT 1 FROM identity.users WHERE id = p_receipt->>'agent_user_id'
              AND owner_user_id = v_owner AND type = 'agent' AND device_id = v_event.to_device_id) THEN
                RAISE EXCEPTION 'Executor receipt agent is not owned on target device' USING ERRCODE = '42501';
            END IF;
            SELECT * INTO v_work FROM identity.assistant_work WHERE owner_user_id = v_owner AND work_id = v_event.work_id FOR UPDATE;
            IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_work.executors) x WHERE x->>'session_id' = v_event.to_session_id AND x ? 'agent_user_id'
              AND x->>'agent_user_id' <> p_receipt->>'agent_user_id') THEN RAISE EXCEPTION 'Executor receipt conflicts with bound agent' USING ERRCODE = '22023'; END IF;
            UPDATE identity.assistant_work SET executors = (SELECT jsonb_agg(CASE WHEN x->>'session_id' = v_event.to_session_id
              THEN x || jsonb_build_object('agent_user_id',p_receipt->>'agent_user_id') ELSE x END) FROM jsonb_array_elements(executors) x)
              WHERE owner_user_id = v_owner AND work_id = v_event.work_id;
        END IF;
        UPDATE identity.assistant_work_events SET delivery_state = 'admitted',lease_until = NULL,
          executor_admitted_at = CASE WHEN p_stage = 'executor_admitted' THEN clock_timestamp() ELSE executor_admitted_at END,
          assistant_admitted_at = CASE WHEN p_stage = 'assistant_admitted' THEN clock_timestamp() ELSE assistant_admitted_at END WHERE seq = v_event.seq;
    END IF;
    RETURN jsonb_build_object('message_id',p_message_id,'stage',p_stage);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_outbox_settle(text,uuid,uuid,text,text,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_outbox_settle(text,uuid,uuid,text,text,integer,jsonb) TO authenticated;

CREATE FUNCTION identity.assistant_work_owner_delivered(p_assistant text,p_runtime_instance_id text,p_message_id uuid,p_owner_chat_id text,p_owner_message_id text,p_receipt_kind text DEFAULT 'result')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := identity.assistant_work_require_owner(p_assistant); v_device text := identity.assistant_work_runtime(p_runtime_instance_id); v_event identity.assistant_work_events;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.users WHERE id = p_assistant AND device_id = v_device) THEN RAISE EXCEPTION 'Owner receipt requires the assistant home runtime' USING ERRCODE = '42501'; END IF;
    SELECT e.* INTO v_event FROM identity.assistant_work_events e JOIN identity.assistant_work w USING(owner_user_id,work_id)
      WHERE e.owner_user_id = v_owner AND e.message_id = p_message_id AND w.assistant_user_id = p_assistant FOR UPDATE OF e;
    IF NOT FOUND OR p_receipt_kind IS NULL OR p_receipt_kind NOT IN ('result','abandonment_notice') THEN RAISE EXCEPTION 'Invalid owner receipt' USING ERRCODE = '22023'; END IF;
    IF p_receipt_kind = 'abandonment_notice' THEN
        IF v_event.delivery_state <> 'abandoned' THEN RAISE EXCEPTION 'Event has not been abandoned' USING ERRCODE = '55000'; END IF;
        IF v_event.abandonment_notified_at IS NOT NULL THEN
            IF v_event.abandonment_notice_chat_id IS DISTINCT FROM p_owner_chat_id OR v_event.abandonment_notice_message_id IS DISTINCT FROM p_owner_message_id THEN
                RAISE EXCEPTION 'Abandonment notice receipt reused for a different message' USING ERRCODE = '22023';
            END IF;
            RETURN jsonb_build_object('message_id',p_message_id,'stage','owner_notified');
        END IF;
    ELSIF v_event.assistant_admitted_at IS NULL THEN RAISE EXCEPTION 'Report has no assistant admission receipt' USING ERRCODE = '55000';
    END IF;
    IF p_receipt_kind = 'result' AND v_event.owner_delivered_at IS NOT NULL THEN
        IF v_event.owner_chat_id IS DISTINCT FROM p_owner_chat_id OR v_event.owner_message_id IS DISTINCT FROM p_owner_message_id THEN
            RAISE EXCEPTION 'Owner receipt reused for a different message' USING ERRCODE = '22023';
        END IF;
    ELSE
        PERFORM identity.assistant_work_source(p_owner_chat_id,p_owner_message_id,v_owner);
        IF NOT EXISTS (SELECT 1 FROM chat.messages WHERE id = p_owner_message_id AND chat_id = p_owner_chat_id AND sender_user_id = p_assistant) THEN
            RAISE EXCEPTION 'Owner delivery message was not committed by the assistant' USING ERRCODE = '42501';
        END IF;
        IF p_receipt_kind = 'abandonment_notice' THEN
            UPDATE identity.assistant_work_events SET abandonment_notified_at = clock_timestamp(),abandonment_notice_chat_id = p_owner_chat_id,
              abandonment_notice_message_id = p_owner_message_id WHERE seq = v_event.seq;
        ELSE
            UPDATE identity.assistant_work_events SET owner_delivered_at = clock_timestamp(),owner_chat_id = p_owner_chat_id,owner_message_id = p_owner_message_id WHERE seq = v_event.seq;
        END IF;
    END IF;
    RETURN jsonb_build_object('message_id',p_message_id,'stage',CASE WHEN p_receipt_kind = 'result' THEN 'owner_delivered' ELSE 'owner_notified' END);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_owner_delivered(text,text,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_owner_delivered(text,text,uuid,text,text,text) TO authenticated;

-- After a pump restart, failures still requiring an owner notice remain discoverable.
-- Use a deterministic message key for that notice; its receipt never means result delivery.
CREATE FUNCTION identity.assistant_work_abandoned(p_runtime_instance_id text,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_events jsonb;
BEGIN
    PERFORM identity.assistant_work_runtime(p_runtime_instance_id);
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid abandoned-event page' USING ERRCODE = '22023'; END IF;
    SELECT COALESCE(jsonb_agg((to_jsonb(e) - ARRAY['operation_hash','event_hash','lease_token','lease_instance_id'])
      || jsonb_build_object('seq',e.seq::text,'terminal_version',e.terminal_version::text,'assistant_user_id',w.assistant_user_id) ORDER BY e.seq),'[]') INTO v_events
      FROM (SELECT e.* FROM identity.assistant_work_events e WHERE e.owner_user_id = auth.uid()::text
        AND e.delivery_state = 'abandoned' AND e.abandonment_notified_at IS NULL ORDER BY e.seq LIMIT p_limit) e
      JOIN identity.assistant_work w ON w.owner_user_id = e.owner_user_id AND w.work_id = e.work_id;
    RETURN jsonb_build_object('events',v_events);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_abandoned(text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_abandoned(text,integer) TO authenticated;

-- Only committed collaboration and receipts invalidate account readers.
-- Claim/renew/retry bookkeeping does not produce activity or list churn.
CREATE FUNCTION identity.assistant_work_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_assistant text;
BEGIN
    SELECT assistant_user_id INTO v_assistant FROM identity.assistant_work
      WHERE owner_user_id = NEW.owner_user_id AND work_id = NEW.work_id;
    PERFORM chat.send_user_event(jsonb_build_object('assistantId',v_assistant,'workId',NEW.work_id,'sequence',NEW.seq::text),
      'assistant_work_changed','gugu:user:' || NEW.owner_user_id || ':events',true);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_changed() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER assistant_work_changed AFTER INSERT OR UPDATE OF executor_admitted_at,assistant_admitted_at,owner_delivered_at,abandoned_at,abandonment_notified_at
  ON identity.assistant_work_events FOR EACH ROW EXECUTE FUNCTION identity.assistant_work_changed();
