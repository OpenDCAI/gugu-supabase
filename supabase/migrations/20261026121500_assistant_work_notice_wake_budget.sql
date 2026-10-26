-- Notification wake reservations belong to the existing event, never to a second queue.
ALTER TABLE identity.assistant_work_events
  ADD COLUMN notice_wake_attempts integer NOT NULL DEFAULT 0 CHECK (notice_wake_attempts BETWEEN 0 AND 6),
  ADD COLUMN notice_wake_available_at timestamptz NOT NULL DEFAULT '-infinity',
  ADD COLUMN notice_wake_token uuid,
  ADD COLUMN notice_wake_instance_id text,
  ADD COLUMN notice_wake_until timestamptz;

CREATE FUNCTION identity.assistant_work_notice_reason(p_code text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE
    WHEN upper(p_code) IN ('EXECUTOR_ENDED_WITHOUT_REPORT','LEGACY_REPORT_MISSING') THEN 'REPORT_MISSING'
    WHEN upper(p_code)='EXECUTOR_FAILED' THEN 'EXECUTION_FAILED'
    WHEN upper(p_code) IN ('HOST_FAILURE','EXECUTOR_CANCELLED_WITHOUT_REPORT') THEN 'INTERRUPTED'
    WHEN upper(p_code)='SOURCE_UNAVAILABLE' THEN 'SOURCE_UNAVAILABLE'
    WHEN upper(p_code) IN ('DELIVERY_HOST_OUTDATED','UNKNOWN_METHOD','SESSION_DEVICE_OUTDATED') THEN 'INCOMPATIBLE'
    WHEN upper(p_code) IN ('DEVICE_UNREACHABLE','DEVICE_OFFLINE','SESSION_DEVICE_UNREACHABLE','SESSION_DEVICE_OFFLINE') THEN 'UNREACHABLE'
    WHEN upper(p_code) LIKE '%TIMEOUT%' OR upper(p_code)='DELIVERY_EXPIRED' THEN 'NO_RESPONSE'
    WHEN upper(p_code) LIKE '%AUTH%' OR upper(p_code) LIKE '%PERMISSION%' OR p_code='42501' THEN 'PERMISSION'
    ELSE 'DELIVERY_FAILED' END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_notice_reason(text) FROM PUBLIC,anon,authenticated;

-- Keep the earliest event as the anchor even after it was handled. A later event or
-- a HOST_FAILURE -> inferred-failed transition cannot reset the six-wake budget.
CREATE FUNCTION identity.assistant_work_notice_groups(p_owner text)
RETURNS TABLE(anchor_seq bigint,work_id uuid,reason_code text,pending boolean,notified boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT min(e.seq),e.work_id,
    identity.assistant_work_notice_reason(CASE WHEN e.delivery_state='abandoned' THEN e.abandoned_reason_code ELSE e.reason_code END),
    bool_or(
      ((e.delivery_state='abandoned' AND e.kind IN ('dispatch','question','completed','cancelled','failed'))
        OR (e.kind='failed' AND e.terminal_origin='coordinator' AND e.owner_delivered_at IS NULL)
        OR (e.kind='progress' AND e.reason_code='HOST_FAILURE' AND NOT EXISTS (
          SELECT 1 FROM identity.assistant_work_events inferred
          WHERE inferred.owner_user_id=e.owner_user_id AND inferred.work_id=e.work_id
            AND inferred.executor_session_id=e.executor_session_id AND inferred.kind='failed'
            AND inferred.terminal_origin='coordinator' AND inferred.reason_code='HOST_FAILURE')))
      AND e.abandonment_notified_at IS NULL
      AND NOT ((e.terminal_origin IS NOT DISTINCT FROM 'coordinator' OR e.reason_code IS NOT DISTINCT FROM 'HOST_FAILURE' OR e.kind IN ('dispatch','question'))
        AND (w.outcome IN ('completed','cancelled') OR COALESCE(w.executor_outcomes->e.executor_session_id->>'origin','')='executor'))
    ),bool_or(e.abandonment_notified_at IS NOT NULL)
  FROM identity.assistant_work_events e JOIN identity.assistant_work w USING(owner_user_id,work_id)
  WHERE e.owner_user_id=p_owner AND (e.kind IN ('dispatch','question','completed','cancelled','failed') OR e.reason_code='HOST_FAILURE')
  GROUP BY e.work_id,identity.assistant_work_notice_reason(CASE WHEN e.delivery_state='abandoned' THEN e.abandoned_reason_code ELSE e.reason_code END);
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_notice_groups(text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION identity.assistant_work_notice_wake_claim(p_runtime_instance_id text,p_limit integer DEFAULT 20,p_lease_seconds integer DEFAULT 60)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_owner text:=auth.uid()::text; v_device text:=identity.assistant_work_runtime(p_runtime_instance_id); v_items jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'Invalid notification lease parameters' USING ERRCODE='22023';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT e.seq,g.reason_code FROM identity.assistant_work_notice_groups(v_owner) g
    JOIN identity.assistant_work_events e ON e.seq=g.anchor_seq
    JOIN identity.assistant_work w ON w.owner_user_id=e.owner_user_id AND w.work_id=e.work_id
    JOIN identity.users assistant ON assistant.id=w.assistant_user_id AND assistant.owner_user_id=v_owner
    WHERE g.pending AND NOT g.notified AND assistant.device_id<>v_device
      AND e.notice_wake_attempts<6 AND e.notice_wake_available_at<=clock_timestamp()
      AND (e.notice_wake_until IS NULL OR e.notice_wake_until<clock_timestamp())
    ORDER BY e.seq FOR UPDATE OF e SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE identity.assistant_work_events e SET notice_wake_attempts=e.notice_wake_attempts+1,
      notice_wake_token=gen_random_uuid(),notice_wake_instance_id=p_runtime_instance_id,
      notice_wake_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      notice_wake_available_at=clock_timestamp()+make_interval(secs=>LEAST(900,30*(1<<e.notice_wake_attempts)))
    FROM candidates c WHERE e.seq=c.seq RETURNING e.*,c.reason_code AS notice_reason
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('anchor_message_id',c.message_id,'assistant_user_id',w.assistant_user_id,
      'work_id',w.work_id,'coordinator_device_id',assistant.device_id,'reason_code',c.notice_reason,
      'lease_token',c.notice_wake_token,'wake_attempts',c.notice_wake_attempts,
      'lease_remaining_ms',GREATEST(0,floor(extract(epoch FROM (c.notice_wake_until-clock_timestamp()))*1000))::bigint)
      ORDER BY c.seq),'[]') INTO v_items
    FROM claimed c JOIN identity.assistant_work w USING(owner_user_id,work_id) JOIN identity.users assistant ON assistant.id=w.assistant_user_id;
  RETURN jsonb_build_object('items',v_items);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_notice_wake_claim(text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_notice_wake_claim(text,integer,integer) TO authenticated;

CREATE FUNCTION identity.assistant_work_notice_wake_release(p_runtime_instance_id text,p_anchor_message_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM identity.assistant_work_runtime(p_runtime_instance_id);
  UPDATE identity.assistant_work_events SET notice_wake_until=NULL
    WHERE owner_user_id=auth.uid()::text AND message_id=p_anchor_message_id
      AND notice_wake_instance_id=p_runtime_instance_id AND notice_wake_token=p_lease_token
      AND notice_wake_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Notification lease token is no longer current' USING ERRCODE='42501'; END IF;
  -- Preserve the reservation and backoff; releasing is not a refunded wake.
  RETURN jsonb_build_object('anchor_message_id',p_anchor_message_id,'stage','released');
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_notice_wake_release(text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_notice_wake_release(text,uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION identity.assistant_work_owner_delivered(p_assistant text,p_runtime_instance_id text,p_message_id uuid,p_owner_chat_id text,p_owner_message_id text,p_receipt_kind text DEFAULT 'result')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := identity.assistant_work_require_owner(p_assistant); v_device text := identity.assistant_work_runtime(p_runtime_instance_id); v_event identity.assistant_work_events;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.users WHERE id = p_assistant AND device_id = v_device) THEN RAISE EXCEPTION 'Owner receipt requires the assistant home runtime' USING ERRCODE = '42501'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('assistant-work:' || v_owner || ':' || e.work_id,0))
      FROM identity.assistant_work_events e WHERE e.owner_user_id=v_owner AND e.message_id=p_message_id;
    SELECT e.* INTO v_event FROM identity.assistant_work_events e JOIN identity.assistant_work w USING(owner_user_id,work_id)
      WHERE e.owner_user_id = v_owner AND e.message_id = p_message_id AND w.assistant_user_id = p_assistant FOR UPDATE OF e;
    IF NOT FOUND OR p_receipt_kind IS NULL OR p_receipt_kind NOT IN ('result','abandonment_notice') THEN RAISE EXCEPTION 'Invalid owner receipt' USING ERRCODE = '22023'; END IF;
    IF p_receipt_kind = 'abandonment_notice' THEN
        PERFORM e.seq FROM identity.assistant_work_events e WHERE e.owner_user_id=v_owner AND e.work_id=v_event.work_id
          ORDER BY e.seq FOR UPDATE;
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
              abandonment_notice_message_id = p_owner_message_id
              WHERE owner_user_id=v_owner AND work_id=v_event.work_id AND delivery_state='abandoned'
                AND identity.assistant_work_notice_reason(abandoned_reason_code)=identity.assistant_work_notice_reason(v_event.abandoned_reason_code);
        ELSE
            UPDATE identity.assistant_work_events SET owner_delivered_at = clock_timestamp(),owner_chat_id = p_owner_chat_id,owner_message_id = p_owner_message_id WHERE seq = v_event.seq;
        END IF;
    END IF;
    RETURN jsonb_build_object('message_id',p_message_id,'stage',CASE WHEN p_receipt_kind = 'result' THEN 'owner_delivered' ELSE 'owner_notified' END);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_owner_delivered(text,text,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_owner_delivered(text,text,uuid,text,text,text) TO authenticated;


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
            AND (e.kind IN ('completed','cancelled','failed','question') OR (e.kind='dispatch' AND e.delivery_state='abandoned') OR (e.reason_code='HOST_FAILURE' AND NOT EXISTS (
              SELECT 1 FROM identity.assistant_work_events inferred WHERE inferred.owner_user_id=e.owner_user_id AND inferred.work_id=e.work_id
                AND inferred.executor_session_id=e.executor_session_id AND inferred.kind='failed' AND inferred.terminal_origin='coordinator' AND inferred.reason_code='HOST_FAILURE')))
            AND ((e.delivery_state<>'abandoned' AND e.owner_delivered_at IS NULL)
              OR (e.delivery_state='abandoned' AND e.abandonment_notified_at IS NULL AND NOT EXISTS (
                SELECT 1 FROM identity.assistant_work_notice_groups(v_owner) notified WHERE notified.work_id=e.work_id AND notified.notified
                  AND notified.reason_code=identity.assistant_work_notice_reason(e.abandoned_reason_code))))
            AND NOT ((COALESCE(e.terminal_origin='coordinator',false) OR COALESCE(e.reason_code='HOST_FAILURE',false))
              AND COALESCE(w.executor_outcomes->e.executor_session_id->>'origin','')='executor')
        ))
      ORDER BY created_seq DESC LIMIT p_limit + 1
    ) SELECT COALESCE(jsonb_agg((to_jsonb(p) - ARRAY['n','initial_task']) || jsonb_build_object('created_seq',created_seq::text,'terminal_version',terminal_version::text)
      ORDER BY created_seq DESC) FILTER (WHERE n <= p_limit),'[]'),CASE WHEN count(*) > p_limit THEN min(created_seq) FILTER (WHERE n <= p_limit)::text END
      INTO v_items,v_next FROM page p;
    RETURN jsonb_build_object('items',v_items,'next_before',v_next);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_list(text,bigint,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_list(text,bigint,integer,boolean) TO authenticated;


-- Return task routing with a pointed work history read; no host lookup or new writes.
CREATE OR REPLACE FUNCTION identity.assistant_work_history(p_assistant text,p_work_id uuid,p_after bigint DEFAULT 0,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := identity.assistant_work_require_owner(p_assistant); v_work identity.assistant_work; v_task jsonb; v_events jsonb := '[]'; v_event identity.assistant_work_events; v_count integer := 0; v_next text; v_body text;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR p_after IS NULL OR p_after < 0 THEN RAISE EXCEPTION 'Invalid history page' USING ERRCODE = '22023'; END IF;
    SELECT * INTO v_work FROM identity.assistant_work WHERE owner_user_id = v_owner AND work_id = p_work_id AND assistant_user_id = p_assistant;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Work is not available to this account' USING ERRCODE = '42501';
    END IF;
    v_task := (to_jsonb(v_work) - 'initial_task') || jsonb_build_object('created_seq',v_work.created_seq::text,'terminal_version',v_work.terminal_version::text);
    FOR v_event IN SELECT * FROM identity.assistant_work_events WHERE owner_user_id = v_owner AND work_id = p_work_id AND seq > p_after ORDER BY seq LIMIT p_limit + 1 LOOP
        IF v_count = p_limit THEN RETURN jsonb_build_object('work',v_task,'events',v_events,'next_after',v_next); END IF;
        v_body := CASE WHEN v_event.source_message_id IS NULL THEN v_event.content
          ELSE identity.assistant_work_source(v_event.source_chat_id,v_event.source_message_id,v_owner,false) END;
        v_events := v_events || jsonb_build_array((to_jsonb(v_event) - ARRAY['operation_hash','event_hash','lease_token','lease_instance_id','notice_wake_token','notice_wake_instance_id'])
          || jsonb_build_object('seq',v_event.seq::text,'terminal_version',v_event.terminal_version::text,'content',v_body,'source_available',v_body IS NOT NULL));
        v_next := v_event.seq::text; v_count := v_count + 1;
    END LOOP;
    RETURN jsonb_build_object('work',v_task,'events',v_events,'next_after',NULL);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_history(text,uuid,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_history(text,uuid,bigint,integer) TO authenticated;

CREATE OR REPLACE FUNCTION identity.assistant_work_abandoned(p_runtime_instance_id text,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_events jsonb;
BEGIN
    PERFORM identity.assistant_work_runtime(p_runtime_instance_id);
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid abandoned-event page' USING ERRCODE = '22023'; END IF;
    SELECT COALESCE(jsonb_agg((to_jsonb(e) - ARRAY['operation_hash','event_hash','lease_token','lease_instance_id','notice_wake_token','notice_wake_instance_id'])
      || jsonb_build_object('seq',e.seq::text,'terminal_version',e.terminal_version::text,'assistant_user_id',w.assistant_user_id) ORDER BY e.seq),'[]') INTO v_events
      FROM (SELECT e.* FROM identity.assistant_work_events e WHERE e.owner_user_id = auth.uid()::text
        AND e.delivery_state = 'abandoned' AND e.abandonment_notified_at IS NULL ORDER BY e.seq LIMIT p_limit) e
      JOIN identity.assistant_work w ON w.owner_user_id = e.owner_user_id AND w.work_id = e.work_id;
    RETURN jsonb_build_object('events',v_events);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_abandoned(text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_abandoned(text,integer) TO authenticated;


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
          SELECT 1 FROM identity.assistant_work_events older
          WHERE older.owner_user_id=e.owner_user_id AND older.work_id=e.work_id
            AND older.to_device_id=e.to_device_id AND older.to_session_id=e.to_session_id
            AND older.seq<e.seq AND older.delivery_state IN ('pending','claimed')
        )
        AND ((e.delivery_state = 'pending' AND e.available_at <= clock_timestamp()) OR (e.delivery_state = 'claimed' AND e.lease_until < clock_timestamp()))
      ORDER BY e.seq FOR UPDATE SKIP LOCKED LIMIT p_limit
    ), claimed AS (
      UPDATE identity.assistant_work_events e SET delivery_state = 'claimed',lease_token = gen_random_uuid(),lease_instance_id = p_runtime_instance_id,
        lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),attempts = attempts + 1
      FROM candidates c WHERE e.seq = c.seq RETURNING e.*
    ) SELECT COALESCE(jsonb_agg((to_jsonb(c) - ARRAY['operation_hash','event_hash','notice_wake_token','notice_wake_instance_id']) || jsonb_build_object('seq',c.seq::text,'terminal_version',c.terminal_version::text,
      'content',CASE WHEN c.source_message_id IS NULL THEN c.content ELSE identity.assistant_work_source(c.source_chat_id,c.source_message_id,v_owner,false) END,
      'source_available',c.source_message_id IS NULL OR identity.assistant_work_source(c.source_chat_id,c.source_message_id,v_owner,false) IS NOT NULL,
      'assistant_user_id',w.assistant_user_id,'work_outcome',w.outcome,'work_terminal_version',w.terminal_version::text,
      'work_executor_outcomes',w.executor_outcomes,
      'lease_remaining_ms',GREATEST(0,floor(extract(epoch FROM (c.lease_until-clock_timestamp()))*1000))::bigint,
      'age_ms',GREATEST(0,floor(extract(epoch FROM (clock_timestamp()-c.platform_received_at))*1000))::bigint) ORDER BY c.seq),'[]') INTO v_result FROM claimed c
      JOIN identity.assistant_work w ON w.owner_user_id = c.owner_user_id AND w.work_id = c.work_id;
    RETURN jsonb_build_object('events',v_result);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_outbox_claim(text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_outbox_claim(text,integer,integer) TO authenticated;
