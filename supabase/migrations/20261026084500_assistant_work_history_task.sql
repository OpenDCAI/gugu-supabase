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
        v_events := v_events || jsonb_build_array((to_jsonb(v_event) - ARRAY['operation_hash','event_hash','lease_token','lease_instance_id'])
          || jsonb_build_object('seq',v_event.seq::text,'terminal_version',v_event.terminal_version::text,'content',v_body,'source_available',v_body IS NOT NULL));
        v_next := v_event.seq::text; v_count := v_count + 1;
    END LOOP;
    RETURN jsonb_build_object('work',v_task,'events',v_events,'next_after',NULL);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_history(text,uuid,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_work_history(text,uuid,bigint,integer) TO authenticated;
