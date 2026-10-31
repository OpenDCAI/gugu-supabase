-- One message search for an actor: chat.message_search_as now searches every chat the actor is a member of when
-- p_chat_id is NULL (the client's global search), and still one chat when it is given. Each row says which chat it is
-- in. Visibility stays the one rule, chat.message_visible_at, with each chat's own history floor. No second function.
DROP FUNCTION chat.message_search_as(text, text, text, bigint, integer);
CREATE FUNCTION chat.message_search_as(p_chat_id text, p_query text, p_as_user_id text DEFAULT NULL::text, p_before_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 20) RETURNS TABLE(id text, seq bigint, sender_user_id text, sender_name text, content text, content_type text, thread_root_id text, created_at timestamp with time zone, file_item_id uuid, file_version integer, chat_id text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := COALESCE(NULLIF(trim(COALESCE(p_as_user_id, '')), ''), (SELECT auth.uid()::text));
    v_pattern TEXT := '%' || replace(replace(replace(COALESCE(p_query, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
BEGIN
    IF v_actor IS NULL OR NOT chat.is_acting_as(v_actor) THEN
        RAISE EXCEPTION 'Not allowed to act as %', v_actor;
    END IF;
    IF p_chat_id IS NULL AND p_before_seq IS NOT NULL THEN
        RAISE EXCEPTION 'p_before_seq pages one chat; a search across chats has no single sequence';
    END IF;
    RETURN QUERY
    SELECT m.id, m.seq::BIGINT, m.sender_user_id, COALESCE(u.display_name, '未知用户'), m.content,
           m.content_type, m.thread_root_id, m.created_at, m.file_item_id, m.file_version, m.chat_id
      FROM chat.messages m
      JOIN LATERAL (SELECT chat.history_floor(m.chat_id, v_actor) AS floor) h ON true
      LEFT JOIN identity.users u ON u.id = m.sender_user_id
     WHERE (CASE WHEN p_chat_id IS NULL
                 THEN m.chat_id IN (SELECT cm.chat_id FROM chat.active_members cm WHERE cm.user_id = v_actor)
                 ELSE m.chat_id = p_chat_id END)
       AND m.deleted_at IS NULL
       AND m.content ILIKE v_pattern
       AND (p_before_seq IS NULL OR m.seq < p_before_seq)
       -- The one visibility rule, against the chat's own history floor for the actor.
       AND chat.message_visible_at(h.floor, m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, v_actor)
     ORDER BY (CASE WHEN p_chat_id IS NULL THEN m.created_at END) DESC, m.seq DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
END;
$$;
REVOKE ALL ON FUNCTION chat.message_search_as(text, text, text, bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.message_search_as(text, text, text, bigint, integer) TO authenticated, service_role;
