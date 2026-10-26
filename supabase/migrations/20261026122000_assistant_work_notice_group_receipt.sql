-- Preserve the original real owner message for a reason group, including late members.
CREATE OR REPLACE FUNCTION identity.assistant_work_owner_delivered(p_assistant text,p_runtime_instance_id text,p_message_id uuid,p_owner_chat_id text,p_owner_message_id text,p_receipt_kind text DEFAULT 'result')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := identity.assistant_work_require_owner(p_assistant); v_device text := identity.assistant_work_runtime(p_runtime_instance_id); v_event identity.assistant_work_events; v_notified identity.assistant_work_events;
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
        SELECT * INTO v_notified FROM identity.assistant_work_events e
          WHERE e.owner_user_id=v_owner AND e.work_id=v_event.work_id AND e.abandonment_notified_at IS NOT NULL
            AND identity.assistant_work_notice_reason(e.abandoned_reason_code)=identity.assistant_work_notice_reason(v_event.abandoned_reason_code)
          ORDER BY e.seq LIMIT 1;
        IF FOUND AND (v_notified.abandonment_notice_chat_id IS DISTINCT FROM p_owner_chat_id
          OR v_notified.abandonment_notice_message_id IS DISTINCT FROM p_owner_message_id) THEN
          RAISE EXCEPTION 'Notification group receipt reused for a different message' USING ERRCODE='22023';
        END IF;
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


