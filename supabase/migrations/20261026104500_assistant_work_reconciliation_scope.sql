-- Add queue budgets computed by the database, never by a device wall clock.
-- The optional reconciliation selector preserves the ordinary list and its pagination.
CREATE INDEX assistant_work_events_owner_receipt_pending ON identity.assistant_work_events(owner_user_id,work_id)
  WHERE owner_delivered_at IS NULL AND delivery_state<>'abandoned'
    AND (kind IN ('completed','cancelled','failed','question') OR reason_code='HOST_FAILURE');
CREATE INDEX assistant_work_events_abandonment_notice_pending ON identity.assistant_work_events(owner_user_id,work_id)
  WHERE delivery_state='abandoned' AND abandonment_notified_at IS NULL
    AND (kind IN ('completed','cancelled','failed','question') OR reason_code='HOST_FAILURE');

-- Replacing the old signature avoids ambiguous default-argument overloads in PostgREST.
DROP FUNCTION identity.assistant_work_list(text,bigint,integer);
CREATE FUNCTION identity.assistant_work_list(p_assistant text,p_before bigint DEFAULT NULL,p_limit integer DEFAULT 50,p_reconcile_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := identity.assistant_work_require_owner(p_assistant); v_items jsonb; v_next text;
BEGIN
    IF p_reconcile_only IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_before <= 0 THEN RAISE EXCEPTION 'Invalid work list page' USING ERRCODE = '22023'; END IF;
    WITH page AS MATERIALIZED (
      SELECT w.*,row_number() OVER (ORDER BY created_seq DESC) AS n FROM identity.assistant_work w
      WHERE owner_user_id = v_owner AND assistant_user_id = p_assistant AND (p_before IS NULL OR created_seq < p_before)
        AND (NOT p_reconcile_only OR w.outcome='active' OR EXISTS (
          SELECT 1 FROM identity.assistant_work_events e WHERE e.owner_user_id=w.owner_user_id AND e.work_id=w.work_id
            AND (e.kind IN ('completed','cancelled','failed','question') OR e.reason_code='HOST_FAILURE')
            AND ((e.delivery_state<>'abandoned' AND e.owner_delivered_at IS NULL)
              OR (e.delivery_state='abandoned' AND e.abandonment_notified_at IS NULL))
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
    ) SELECT COALESCE(jsonb_agg((to_jsonb(c) - ARRAY['operation_hash','event_hash']) || jsonb_build_object('seq',c.seq::text,'terminal_version',c.terminal_version::text,
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
