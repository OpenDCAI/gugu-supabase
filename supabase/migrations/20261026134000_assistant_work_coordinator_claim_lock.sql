-- Serialize report claims with home changes, without altering message payloads.
CREATE OR REPLACE FUNCTION identity.assistant_work_outbox_claim(p_runtime_instance_id text,p_limit integer DEFAULT 20,p_lease_seconds integer DEFAULT 60)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := auth.uid()::text; v_result jsonb; v_coordinators text[];
BEGIN
    PERFORM identity.assistant_work_runtime(p_runtime_instance_id);
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
          AND ((e.delivery_state='pending' AND e.available_at<=clock_timestamp())
            OR (e.delivery_state='claimed' AND e.lease_until<clock_timestamp()))
      ) ORDER BY u.id FOR SHARE OF u
    ) locked;
    WITH candidates AS MATERIALIZED (
      SELECT e.seq FROM identity.assistant_work_events e WHERE e.owner_user_id = v_owner
        AND (e.kind='dispatch' OR (
          EXISTS(SELECT 1 FROM identity.assistant_work w WHERE w.owner_user_id=e.owner_user_id
            AND w.work_id=e.work_id AND w.assistant_user_id=ANY(v_coordinators))
          AND identity.assistant_work_coordinator(e.owner_user_id,e.work_id) IS NOT NULL))
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
