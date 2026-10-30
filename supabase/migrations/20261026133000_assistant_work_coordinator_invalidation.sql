-- Current addresses expire when the assistant leaves a device. Returning to a
-- former home requires a fresh attestation; original addresses remain historical.
CREATE OR REPLACE FUNCTION identity.assistant_work_coordinator(p_owner text,p_work uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT CASE WHEN w.current_coordinator_device_id=u.device_id AND w.current_coordinator_session_id IS NOT NULL
    THEN jsonb_build_object('session_id',w.current_coordinator_session_id,'device_id',u.device_id)
    ELSE NULL END
  FROM identity.assistant_work w JOIN identity.users u ON u.id=w.assistant_user_id AND u.owner_user_id=w.owner_user_id
  WHERE w.owner_user_id=p_owner AND w.work_id=p_work;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_coordinator(text,uuid) FROM PUBLIC,anon,authenticated;

-- Seed only an unchanged original home. All later inserts, including legacy
-- imports, follow the same rule; a moved original address never becomes current.
UPDATE identity.assistant_work w SET current_coordinator_session_id=w.coordinator_session_id,
  current_coordinator_device_id=w.coordinator_device_id
FROM identity.users u WHERE u.id=w.assistant_user_id AND u.owner_user_id=w.owner_user_id
  AND u.device_id=w.coordinator_device_id AND w.current_coordinator_session_id IS NULL
  AND w.current_coordinator_device_id IS NULL;

CREATE FUNCTION identity.assistant_work_coordinator_initial() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.current_coordinator_session_id IS NULL AND NEW.current_coordinator_device_id IS NULL
    AND EXISTS(SELECT 1 FROM identity.users WHERE id=NEW.assistant_user_id AND owner_user_id=NEW.owner_user_id AND device_id=NEW.coordinator_device_id) THEN
    NEW.current_coordinator_session_id:=NEW.coordinator_session_id;
    NEW.current_coordinator_device_id:=NEW.coordinator_device_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_coordinator_initial() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER assistant_work_coordinator_initial BEFORE INSERT ON identity.assistant_work
  FOR EACH ROW EXECUTE FUNCTION identity.assistant_work_coordinator_initial();

CREATE FUNCTION identity.assistant_work_coordinator_left() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_changed boolean;
BEGIN
  UPDATE identity.assistant_work SET current_coordinator_session_id=NULL,current_coordinator_device_id=NULL
    WHERE assistant_user_id=NEW.id AND owner_user_id=NEW.owner_user_id
      AND (current_coordinator_session_id IS NOT NULL OR current_coordinator_device_id IS NOT NULL);
  v_changed:=FOUND;
  -- A claim made before the move cannot later acknowledge delivery to the old
  -- seat. Preserve the payload and attempt count, and invalidate only its lease.
  UPDATE identity.assistant_work_events e SET delivery_state='pending',available_at=clock_timestamp(),
    lease_until=NULL,lease_token=NULL,lease_instance_id=NULL
  FROM identity.assistant_work w WHERE w.owner_user_id=e.owner_user_id AND w.work_id=e.work_id
    AND w.assistant_user_id=NEW.id AND w.owner_user_id=NEW.owner_user_id
    AND e.kind<>'dispatch' AND e.delivery_state='claimed';
  IF v_changed THEN
    PERFORM chat.send_user_event(jsonb_build_object('assistantId',NEW.id),'assistant_work_changed','gugu:user:'||NEW.owner_user_id||':events',true);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_coordinator_left() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER assistant_work_coordinator_left AFTER UPDATE OF device_id ON identity.users
  FOR EACH ROW WHEN (NEW.type='agent' AND OLD.device_id IS DISTINCT FROM NEW.device_id)
  EXECUTE FUNCTION identity.assistant_work_coordinator_left();

CREATE OR REPLACE FUNCTION identity.assistant_work_coordinator_bind(p_assistant text,p_runtime_instance_id text,p_session_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_owner text:=identity.assistant_work_require_owner(p_assistant); v_device text:=identity.assistant_work_runtime(p_runtime_instance_id); v_count integer;
BEGIN
  IF COALESCE(p_session_id,'') !~ '^[a-zA-Z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'Invalid coordinator session' USING ERRCODE='22023'; END IF;
  -- Serialize home changes with binding. A move that follows this attestation
  -- clears it in the same user-row transaction instead of reviving it later.
  PERFORM 1 FROM identity.users WHERE id=p_assistant AND owner_user_id=v_owner AND device_id=v_device FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Coordinator binding requires the current assistant home runtime' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('assistant-work-coordinator:'||v_owner||':'||p_assistant,0));
  UPDATE identity.assistant_work SET current_coordinator_session_id=p_session_id,current_coordinator_device_id=v_device
    WHERE owner_user_id=v_owner AND assistant_user_id=p_assistant
      AND (current_coordinator_session_id,current_coordinator_device_id) IS DISTINCT FROM (p_session_id,v_device);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN
    PERFORM chat.send_user_event(jsonb_build_object('assistantId',p_assistant),'assistant_work_changed','gugu:user:'||v_owner||':events',true);
  END IF;
  RETURN jsonb_build_object('coordinator_current',jsonb_build_object('session_id',p_session_id,'device_id',v_device),'bound_count',v_count);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_coordinator_bind(text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_coordinator_bind(text,text,text) TO authenticated;

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
        AND (e.kind='dispatch' OR identity.assistant_work_coordinator(e.owner_user_id,e.work_id) IS NOT NULL)
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
