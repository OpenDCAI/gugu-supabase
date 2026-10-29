-- Prefer a live target runtime, retaining delegated wake/delivery when it is offline.
CREATE OR REPLACE FUNCTION identity.assistant_work_outbox_claim(p_runtime_instance_id text,p_limit integer DEFAULT 20,p_lease_seconds integer DEFAULT 60)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := auth.uid()::text; v_result jsonb; v_coordinators text[]; v_device text;
    v_now timestamptz;
BEGIN
    v_device := identity.assistant_work_runtime(p_runtime_instance_id);
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 90 THEN
        RAISE EXCEPTION 'Invalid outbox lease parameters' USING ERRCODE = '22023';
    END IF;
    -- Lock each relevant assistant before taking the candidate snapshot. Doing
    -- this in a preceding statement gives READ COMMITTED a fresh snapshot after
    -- waiting for a move, rather than reusing a pre-move function snapshot.
    SELECT COALESCE(array_agg(locked.id),ARRAY[]::text[]) INTO v_coordinators FROM (
      SELECT u.id FROM identity.users u WHERE u.owner_user_id=v_owner AND EXISTS (
        SELECT 1 FROM identity.assistant_work w JOIN identity.assistant_work_events e
          ON e.owner_user_id=w.owner_user_id AND e.work_id=w.work_id
        WHERE w.owner_user_id=v_owner AND w.assistant_user_id=u.id AND e.kind<>'dispatch'
          AND ((e.delivery_state='pending' AND (e.available_at<=clock_timestamp() OR e.last_error_code='CLIENT_OUTDATED'))
            OR (e.delivery_state='claimed' AND e.lease_until<clock_timestamp()))
      ) ORDER BY u.id FOR SHARE OF u
    ) locked;
    -- Expiry belongs to the account, even when the delivery device never returns.
    -- Do not borrow its lease or interrupt a delivery whose current lease is live.
    v_now := clock_timestamp();
    WITH expired AS MATERIALIZED (
      SELECT e.seq FROM identity.assistant_work_events e
      WHERE e.owner_user_id=v_owner AND e.platform_received_at<=v_now-interval '24 hours'
        AND (e.delivery_state='pending' OR (e.delivery_state='claimed' AND e.lease_until<=v_now))
      ORDER BY e.seq FOR UPDATE SKIP LOCKED LIMIT 100
    )
    UPDATE identity.assistant_work_events e SET delivery_state='abandoned',
      lease_token=NULL,lease_instance_id=NULL,lease_until=NULL,abandoned_at=v_now,
      abandoned_reason_code='DELIVERY_EXPIRED'
    FROM expired x WHERE e.seq=x.seq;
    -- The existing business-change trigger broadcasts abandonment once; lease
    -- maintenance is quiet, and a repeated sweep changes no already-abandoned row.
    WITH candidates AS MATERIALIZED (
      SELECT e.seq FROM identity.assistant_work_events e
      CROSS JOIN LATERAL (SELECT CASE WHEN e.kind='dispatch' THEN e.to_device_id
        ELSE identity.assistant_work_coordinator(e.owner_user_id,e.work_id)->>'device_id' END AS device_id) target
      WHERE e.owner_user_id = v_owner
        AND e.platform_received_at>v_now-interval '24 hours'
        AND (target.device_id=v_device OR NOT EXISTS (
          SELECT 1 FROM identity.runtime_instances r
            JOIN identity.gugu_devices d ON d.device_id=r.device_id AND d.user_id=r.owner_user_id
          WHERE r.owner_user_id::text=v_owner AND r.device_id=target.device_id
            AND r.last_heartbeat_at>v_now-interval '90 seconds'))
        AND (e.kind='dispatch' OR (
          EXISTS(SELECT 1 FROM identity.assistant_work w WHERE w.owner_user_id=e.owner_user_id
            AND w.work_id=e.work_id AND w.assistant_user_id=ANY(v_coordinators))
          AND identity.assistant_work_coordinator(e.owner_user_id,e.work_id) IS NOT NULL))
        AND NOT EXISTS (
          SELECT 1 FROM identity.assistant_work_events older WHERE older.owner_user_id=e.owner_user_id AND older.work_id=e.work_id
            AND older.seq<e.seq AND older.delivery_state IN ('pending','claimed') AND (
              (e.kind<>'dispatch' AND older.kind<>'dispatch') OR (e.kind='dispatch' AND older.kind='dispatch' AND older.to_device_id=e.to_device_id AND older.to_session_id=e.to_session_id))
        )
        AND ((e.delivery_state = 'pending' AND (e.available_at <= clock_timestamp()
          OR (e.last_error_code='CLIENT_OUTDATED' AND target.device_id=v_device)))
          OR (e.delivery_state = 'claimed' AND e.lease_until < clock_timestamp()))
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

-- CLIENT_OUTDATED rejects the requesting client, not delivery at the recipient.
CREATE OR REPLACE FUNCTION identity.assistant_work_outbox_settle(
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
          available_at = clock_timestamp() + make_interval(secs => CASE WHEN p_error_code='CLIENT_OUTDATED'
            THEN LEAST(300,GREATEST(30,p_retry_after_seconds)) ELSE p_retry_after_seconds END),last_error_code = p_error_code,
          failed_attempts = failed_attempts + CASE WHEN p_error_code='CLIENT_OUTDATED' THEN 0 ELSE 1 END WHERE seq = v_event.seq;
        IF p_error_code='CLIENT_OUTDATED' THEN
            PERFORM chat.send_user_event('{}'::jsonb,'assistant_work_changed','gugu:user:'||v_owner||':events',true);
        END IF;
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

-- Keep the existing verified-notice path and expose only the owned device's label.
CREATE OR REPLACE FUNCTION identity.assistant_work_abandoned(p_runtime_instance_id text,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_events jsonb;
BEGIN
    PERFORM identity.assistant_work_runtime(p_runtime_instance_id);
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid abandoned-event page' USING ERRCODE = '22023'; END IF;
    SELECT COALESCE(jsonb_agg((to_jsonb(e) - ARRAY['operation_hash','event_hash','lease_token','lease_instance_id','notice_wake_attempts','notice_wake_available_at','notice_wake_token','notice_wake_instance_id','notice_wake_until'])
      || jsonb_build_object('seq',e.seq::text,'terminal_version',e.terminal_version::text,'assistant_user_id',w.assistant_user_id,
        'to_device_label',COALESCE(NULLIF(btrim(d.label),''),NULLIF(btrim(d.hostname),''))) ORDER BY e.seq),'[]') INTO v_events
      FROM (SELECT e.* FROM identity.assistant_work_events e WHERE e.owner_user_id = auth.uid()::text
        AND e.delivery_state = 'abandoned' AND e.abandonment_notified_at IS NULL AND EXISTS (
          SELECT 1 FROM identity.assistant_work_notice_pending(auth.uid()::text) g WHERE g.work_id=e.work_id
            AND g.reason_code=identity.assistant_work_notice_reason(e.abandoned_reason_code)
            AND g.notice_kind=(CASE WHEN e.kind='completed' THEN 'completed' ELSE 'handoff' END) AND g.pending AND NOT g.notified) ORDER BY e.seq LIMIT p_limit) e
      JOIN identity.assistant_work w ON w.owner_user_id = e.owner_user_id AND w.work_id = e.work_id
      LEFT JOIN identity.gugu_devices d ON d.user_id::text=e.owner_user_id AND d.device_id=CASE WHEN e.kind='dispatch'
        THEN e.to_device_id ELSE identity.assistant_work_coordinator(e.owner_user_id,e.work_id)->>'device_id' END;
    RETURN jsonb_build_object('events',v_events);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_abandoned(text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_abandoned(text,integer) TO authenticated;


-- Wake affected account pumps after releasing pre-upgrade delays, rather than waiting
-- for their five-minute safety scan. Keep historical failure counters: the last
-- error cannot prove every preceding failure had the same cause.
DO $recovery$
DECLARE recipient text;
BEGIN
  FOR recipient IN
    WITH pending AS (
      UPDATE identity.assistant_work_events SET available_at=LEAST(available_at,clock_timestamp())
        WHERE delivery_state='pending' AND last_error_code='CLIENT_OUTDATED'
        RETURNING owner_user_id
    ), foreign_leases AS (
      -- Reclaim with the same message ID; already admitted recipients deduplicate it.
      UPDATE identity.assistant_work_events e SET delivery_state='pending',available_at=clock_timestamp(),
        lease_token=NULL,lease_instance_id=NULL,lease_until=NULL
        WHERE e.delivery_state='claimed' AND EXISTS (
          SELECT 1 FROM identity.runtime_instances target_runtime
            JOIN identity.gugu_devices d ON d.device_id=target_runtime.device_id AND d.user_id=target_runtime.owner_user_id
          WHERE target_runtime.owner_user_id::text=e.owner_user_id
            AND target_runtime.device_id=CASE WHEN e.kind='dispatch' THEN e.to_device_id
              ELSE identity.assistant_work_coordinator(e.owner_user_id,e.work_id)->>'device_id' END
            AND target_runtime.last_heartbeat_at>clock_timestamp()-interval '90 seconds'
        ) AND (
          SELECT r.device_id FROM identity.runtime_instances r
            WHERE r.instance_id=e.lease_instance_id AND r.owner_user_id::text=e.owner_user_id
        ) IS DISTINCT FROM CASE WHEN e.kind='dispatch' THEN e.to_device_id
          ELSE identity.assistant_work_coordinator(e.owner_user_id,e.work_id)->>'device_id' END
        RETURNING e.owner_user_id
    ) SELECT owner_user_id FROM pending UNION SELECT owner_user_id FROM foreign_leases
  LOOP
    PERFORM chat.send_user_event('{}'::jsonb,'assistant_work_changed','gugu:user:'||recipient||':events',true);
  END LOOP;
END;
$recovery$;
