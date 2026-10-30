-- Reply authors need the original privacy flag; read it through the same actor-scoped history entry point.
-- Keep the existing recipients, visibility predicate, paging, permissions and send behavior unchanged.
DROP FUNCTION chat.message_history_as(text, text, text, bigint, integer);
CREATE FUNCTION chat.message_history_as(p_chat_id text, p_as_user_id text DEFAULT NULL::text, p_thread_root_id text DEFAULT NULL::text, p_before_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 20) RETURNS TABLE(id text, seq bigint, sender_user_id text, sender_name text, to_user_ids text[], content text, content_type text, reply_to_message_id text, thread_root_id text, created_at timestamp with time zone, file_item_id uuid, file_version integer, is_whisper boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := COALESCE(NULLIF(trim(COALESCE(p_as_user_id, '')), ''), (SELECT auth.uid()::text));
BEGIN
    IF v_actor IS NULL OR NOT chat.is_acting_as(v_actor) THEN
        RAISE EXCEPTION 'Not allowed to act as %', v_actor;
    END IF;
    RETURN QUERY
    SELECT m.id, m.seq::BIGINT, m.sender_user_id, COALESCE(u.display_name, '未知用户'), m.to_user_ids, m.content,
           m.content_type, m.reply_to_message_id, m.thread_root_id, m.created_at, m.file_item_id, m.file_version, m.is_whisper
      FROM chat.messages m
      LEFT JOIN identity.users u ON u.id = m.sender_user_id
     WHERE m.chat_id = p_chat_id
       AND m.deleted_at IS NULL
       AND m.thread_root_id IS NOT DISTINCT FROM NULLIF(p_thread_root_id, '')
       AND (p_before_seq IS NULL OR m.seq < p_before_seq)
       AND chat.message_visible_at((SELECT chat.history_floor(p_chat_id, v_actor)),
             m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, v_actor)
     ORDER BY m.seq DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
END;
$$;
REVOKE ALL ON FUNCTION chat.message_history_as(text, text, text, bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.message_history_as(text, text, text, bigint, integer) TO authenticated, service_role;
