-- Upgrade existing, locally acknowledged work without replaying any historical delivery.
ALTER TABLE identity.assistant_work ADD COLUMN legacy_imported boolean NOT NULL DEFAULT false;
ALTER TABLE identity.assistant_work_events ADD COLUMN occurred_at timestamptz;

CREATE FUNCTION identity.assistant_work_import(p_assistant text,p_runtime_instance_id text,p_work_id uuid,p_task jsonb,p_events jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_owner text := identity.assistant_work_require_owner(p_assistant);
  v_device text := identity.assistant_work_runtime(p_runtime_instance_id);
  v_work identity.assistant_work; v_prior identity.assistant_work_events;
  v_event jsonb; v_target jsonb; v_subject text; v_kind text; v_message uuid; v_at timestamptz;
  v_seq bigint; v_status text; v_outcome text; v_ids jsonb := '[]';
  v_hash text; v_initial jsonb; v_first timestamptz;
BEGIN
  IF p_work_id IS NULL OR jsonb_typeof(p_task) IS DISTINCT FROM 'object'
    OR p_task - ARRAY['title','coordinator_session_id','coordinator_device_id','executors','source_link'] <> '{}'
    OR length(COALESCE(p_task->>'title','')) NOT BETWEEN 1 AND 500
    OR COALESCE(p_task->>'coordinator_session_id','') !~ '^[a-zA-Z0-9_-]{1,128}$'
    OR NOT EXISTS (SELECT 1 FROM identity.users WHERE id=p_assistant AND device_id=p_task->>'coordinator_device_id')
    OR jsonb_typeof(p_task->'executors') IS DISTINCT FROM 'array' OR jsonb_array_length(p_task->'executors') NOT BETWEEN 1 AND 32
    OR jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 32
    OR octet_length(p_events::text)>1048576 OR octet_length(p_task::text)>16384 THEN
    RAISE EXCEPTION 'Invalid historical work or events' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(DISTINCT x->>'session_id') FROM jsonb_array_elements(p_task->'executors') x) <> jsonb_array_length(p_task->'executors') THEN
    RAISE EXCEPTION 'Duplicate historical executor targets' USING ERRCODE='22023';
  END IF;
  FOR v_target IN SELECT value FROM jsonb_array_elements(p_task->'executors') LOOP
    IF COALESCE(v_target->>'session_id','') !~ '^[a-zA-Z0-9_-]{1,128}$' OR NOT EXISTS (
      SELECT 1 FROM identity.users u JOIN identity.gugu_devices d ON d.device_id=u.device_id AND d.user_id::text=u.owner_user_id
      WHERE u.id=v_target->>'agent_user_id' AND u.type='agent' AND u.owner_user_id=v_owner AND u.device_id=v_target->>'device_id'
    ) THEN RAISE EXCEPTION 'Historical executor is not owned' USING ERRCODE='42501'; END IF;
  END LOOP;
  -- A host may attest only a receipt it received, or its own successful outbound receipt.
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    IF v_event->>'receipt_kind'='received' THEN
      IF v_event->>'to_device_id' IS DISTINCT FROM v_device THEN RAISE EXCEPTION 'Receipt recipient runtime does not match' USING ERRCODE='42501'; END IF;
    ELSIF v_event->>'receipt_kind'='sent_admitted' THEN
      IF v_event->>'from_device_id' IS DISTINCT FROM v_device THEN RAISE EXCEPTION 'Receipt sender runtime does not match' USING ERRCODE='42501'; END IF;
    ELSE RAISE EXCEPTION 'A historical admission receipt is required' USING ERRCODE='22023'; END IF;
    v_at:=(v_event->>'occurred_at')::timestamptz;
    IF v_at IS NULL OR NOT isfinite(v_at) OR v_at>clock_timestamp()+interval '5 minutes' THEN RAISE EXCEPTION 'Invalid historical receipt time' USING ERRCODE='22023'; END IF;
    v_first:=LEAST(v_first,v_at);
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended('assistant-work:'||v_owner||':'||p_work_id,0));
  SELECT * INTO v_work FROM identity.assistant_work WHERE owner_user_id=v_owner AND work_id=p_work_id FOR UPDATE;
  v_initial:=p_task-'coordinator_device_id';
  IF NOT FOUND THEN
    INSERT INTO identity.assistant_work(owner_user_id,work_id,assistant_user_id,title,coordinator_session_id,coordinator_device_id,executors,initial_task,source_link,legacy_imported,created_at,updated_at)
      VALUES(v_owner,p_work_id,p_assistant,p_task->>'title',p_task->>'coordinator_session_id',p_task->>'coordinator_device_id',p_task->'executors',v_initial,p_task->>'source_link',true,v_first,v_first) RETURNING * INTO v_work;
  ELSIF v_work.assistant_user_id<>p_assistant OR v_work.coordinator_session_id<>p_task->>'coordinator_session_id'
    OR v_work.coordinator_device_id<>p_task->>'coordinator_device_id' THEN
    RAISE EXCEPTION 'Historical work coordinator conflicts with its ledger' USING ERRCODE='42501';
  END IF;
  FOR v_target IN SELECT value FROM jsonb_array_elements(p_task->'executors') LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_work.executors) x WHERE x->>'session_id'=v_target->>'session_id'
      AND x->>'device_id'=v_target->>'device_id' AND (x->>'agent_user_id' IS NULL OR x->>'agent_user_id'=v_target->>'agent_user_id')) THEN
      IF NOT v_work.legacy_imported OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_work.executors) x WHERE x->>'session_id'=v_target->>'session_id') THEN
        RAISE EXCEPTION 'Historical executor conflicts with stored assignment' USING ERRCODE='42501';
      END IF;
      v_work.executors:=v_work.executors||jsonb_build_array(v_target);
      v_work.outcome:='active';
      UPDATE identity.assistant_work SET executors=v_work.executors,outcome='active' WHERE owner_user_id=v_owner AND work_id=p_work_id;
    END IF;
  END LOOP;
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    v_message:=(v_event->>'message_id')::uuid; v_kind:=v_event->>'kind'; v_at:=(v_event->>'occurred_at')::timestamptz;
    IF v_message IS NULL OR v_kind IS NULL OR v_kind NOT IN ('dispatch','progress','question','completed','cancelled','failed')
      OR jsonb_typeof(v_event->'content') IS DISTINCT FROM 'string' OR v_event->>'source_message_id' IS NOT NULL
      OR v_event - ARRAY['message_id','kind','from_session_id','from_device_id','to_session_id','to_device_id','content','occurred_at','receipt_kind'] <> '{}' THEN
      RAISE EXCEPTION 'Invalid historical event' USING ERRCODE='22023';
    END IF;
    v_subject:=CASE WHEN v_kind='dispatch' THEN v_event->>'to_session_id' ELSE v_event->>'from_session_id' END;
    SELECT x INTO v_target FROM jsonb_array_elements(v_work.executors) x WHERE x->>'session_id'=v_subject;
    IF v_target IS NULL OR (v_kind='dispatch' AND (v_event->>'from_session_id' IS DISTINCT FROM v_work.coordinator_session_id
      OR v_event->>'from_device_id' IS DISTINCT FROM v_work.coordinator_device_id OR v_event->>'to_device_id' IS DISTINCT FROM v_target->>'device_id'))
      OR (v_kind<>'dispatch' AND (v_event->>'to_session_id' IS DISTINCT FROM v_work.coordinator_session_id
      OR v_event->>'to_device_id' IS DISTINCT FROM v_work.coordinator_device_id OR v_event->>'from_device_id' IS DISTINCT FROM v_target->>'device_id')) THEN
      RAISE EXCEPTION 'Historical event endpoints do not match its task' USING ERRCODE='42501';
    END IF;
    SELECT * INTO v_prior FROM identity.assistant_work_events WHERE owner_user_id=v_owner AND message_id=v_message;
    IF FOUND THEN
      IF v_prior.work_id<>p_work_id OR v_prior.kind<>v_kind OR v_prior.from_session_id<>v_event->>'from_session_id'
        OR v_prior.to_session_id<>v_event->>'to_session_id' OR v_prior.content IS DISTINCT FROM v_event->>'content' THEN
        RAISE EXCEPTION 'Historical message ID reused for different content' USING ERRCODE='22023';
      END IF;
      v_ids:=v_ids||jsonb_build_array(v_message::text); CONTINUE;
    END IF;
    v_status:=v_work.executor_outcomes->v_subject->>'status';
    IF v_kind IN ('completed','cancelled','failed') AND v_status IS NOT NULL
      AND COALESCE(v_work.executor_outcomes->v_subject->>'origin','executor')='executor' AND v_status<>v_kind THEN
      RAISE EXCEPTION 'Executor reported conflicting historical terminal results' USING ERRCODE='55000';
    END IF;
    v_hash:=encode(sha256(convert_to(jsonb_build_object('work',p_work_id,'event',v_event)::text,'UTF8')),'hex');
    INSERT INTO identity.assistant_work_events(owner_user_id,work_id,operation_id,operation_hash,message_id,event_hash,kind,
      from_session_id,from_device_id,to_session_id,to_device_id,executor_session_id,content,delivery_state,occurred_at,
      executor_admitted_at,assistant_admitted_at,terminal_origin)
      VALUES(v_owner,p_work_id,v_message,v_hash,v_message,v_hash,v_kind,v_event->>'from_session_id',v_event->>'from_device_id',
        v_event->>'to_session_id',v_event->>'to_device_id',v_subject,v_event->>'content','admitted',v_at,
        CASE WHEN v_kind='dispatch' THEN v_at END,CASE WHEN v_kind<>'dispatch' THEN v_at END,CASE WHEN v_kind IN ('completed','cancelled','failed') THEN 'executor' END) RETURNING seq INTO v_seq;
    v_work.updated_at:=GREATEST(v_work.updated_at,v_at);
    IF v_kind IN ('completed','cancelled','failed') THEN
      v_work.executor_outcomes:=v_work.executor_outcomes||jsonb_build_object(v_subject,jsonb_build_object('status',v_kind,'origin','executor','message_id',v_message,'version',v_seq::text));
      v_outcome:='active';
      IF (SELECT count(*) FROM jsonb_object_keys(v_work.executor_outcomes))=jsonb_array_length(v_work.executors) THEN
        SELECT CASE WHEN bool_or(value->>'status'='failed') THEN 'failed' WHEN bool_or(value->>'status'='cancelled') THEN 'cancelled' ELSE 'completed' END INTO v_outcome FROM jsonb_each(v_work.executor_outcomes);
      END IF;
      UPDATE identity.assistant_work SET executor_outcomes=v_work.executor_outcomes,outcome=v_outcome,terminal_version=v_seq,updated_at=v_work.updated_at
        WHERE owner_user_id=v_owner AND work_id=p_work_id RETURNING * INTO v_work;
      UPDATE identity.assistant_work_events SET terminal_version=v_work.terminal_version WHERE seq=v_seq;
    ELSE
      UPDATE identity.assistant_work SET updated_at=v_work.updated_at WHERE owner_user_id=v_owner AND work_id=p_work_id;
    END IF;
    v_ids:=v_ids||jsonb_build_array(v_message::text);
  END LOOP;
  RETURN jsonb_build_object('work_id',p_work_id,'event_ids',v_ids,'outcome',v_work.outcome,'terminal_version',v_work.terminal_version::text);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_import(text,text,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_import(text,text,uuid,jsonb,jsonb) TO authenticated;
