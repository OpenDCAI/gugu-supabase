-- Topics are streams inside a source conversation. Group archival remains group-only.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION chat.archive_topic_as(p_chat_id TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_actor TEXT := chat.require_group_actor(p_as_user_id);
    v_topic chat.chats%ROWTYPE;
    v_role TEXT;
    v_source_kind TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.users WHERE id = v_actor AND type = 'human') THEN
        RAISE EXCEPTION 'Only a person can delete a topic' USING ERRCODE = '42501';
    END IF;
    -- Lock the source before the topic, as source membership removal does.
    -- Keep membership/role and source status stable until archival commits.
    SELECT m.role, s.kind INTO v_role, v_source_kind
      FROM chat.chats s JOIN chat.chat_members m ON m.chat_id = s.id
     WHERE s.id = (SELECT source_chat_id FROM chat.chats WHERE id = p_chat_id AND kind = 'topic')
       AND s.status <> 'archived' AND m.user_id = v_actor
     FOR SHARE OF s, m;
    SELECT * INTO v_topic FROM chat.chats WHERE id = p_chat_id AND kind = 'topic' FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Topic not found' USING ERRCODE = '22023';
    END IF;
    IF v_role IS NULL OR NOT (
        (v_source_kind = 'group' AND v_role IN ('owner', 'admin'))
        OR EXISTS (SELECT 1 FROM identity.users creator WHERE creator.id = v_topic.creator_user_id
                   AND (creator.id = v_actor OR (creator.type = 'agent' AND creator.owner_user_id = v_actor)))
    ) THEN
        RAISE EXCEPTION 'Only the topic creator or an owner/admin of its source conversation can delete this topic'
            USING ERRCODE = '42501';
    END IF;
    UPDATE chat.chats SET status = 'archived' WHERE id = p_chat_id AND status <> 'archived';
    RETURN jsonb_build_object('chat_id', p_chat_id, 'status', 'archived');
END;
$$;
REVOKE ALL ON FUNCTION chat.archive_topic_as(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.archive_topic_as(TEXT, TEXT) TO authenticated;

-- Reuse the existing source-member notification path for archival, including
-- readers who have never joined the topic's participant list.
DROP TRIGGER chats_publish_topic_to_source_line ON chat.chats;
CREATE TRIGGER chats_publish_topic_to_source_line AFTER INSERT OR UPDATE OF name, status ON chat.chats
FOR EACH ROW EXECUTE FUNCTION chat.publish_topic_created_to_source_line();

CREATE OR REPLACE FUNCTION chat.list_topics_of_chat(p_source_chat_id text, p_as_user_id text DEFAULT NULL::text) RETURNS TABLE(chat_id text, name text, source_message_id text, creator_user_id text, last_message_at timestamp with time zone, message_count bigint, participant_count bigint, is_participant boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_caller TEXT := (SELECT auth.uid()::text);
    v_actor TEXT;
    v_actor_owner TEXT;
    v_actor_is_agent BOOLEAN;
BEGIN
    v_actor := COALESCE(p_as_user_id, v_caller);
    SELECT u.type = 'agent', u.owner_user_id INTO v_actor_is_agent, v_actor_owner
      FROM identity.users u WHERE u.id = v_actor;
    IF v_actor IS DISTINCT FROM v_caller
       AND NOT (COALESCE(v_actor_is_agent, false) AND v_actor_owner = v_caller) THEN
        RAISE EXCEPTION 'Not allowed to act as %', v_actor;
    END IF;

    -- 与 create_topic 同形:actor 在来源线,**或** actor 是 agent 且主人在来源线。
    -- 两边不同形的后果是 agent 开得出话题却列不出来,而这个函数的用途正是
    -- 「开第二条之前先看看有没有」—— 它永远回「没有」,于是同一个问题被开成一串重复的线。
    IF NOT chat.is_chat_member(p_source_chat_id, v_actor)
       AND NOT (COALESCE(v_actor_is_agent, false)
                AND v_actor_owner IS NOT NULL
                AND chat.is_chat_member(p_source_chat_id, v_actor_owner)) THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        t.id,
        t.name,
        t.source_message_id,
        t.creator_user_id,
        t.last_message_at,
        -- 数的是 actor 读得到的条数:与 message_history_as 同一组条件(未删 + 可见下界 + 悄悄话规则);
        -- 下界每个话题只算一次,逐行只剩内联后的悄悄话规则。
        (SELECT count(*) FROM chat.messages m
          WHERE m.chat_id = t.id AND m.deleted_at IS NULL
            AND m.created_at >= (SELECT chat.history_floor(t.id, v_actor))
            AND chat.whisper_visible_to(m.is_whisper, m.sender_user_id, m.to_user_ids, v_actor)),
        (SELECT count(*) FROM chat.chat_members cm WHERE cm.chat_id = t.id),
        chat.is_chat_member(t.id, v_actor)
    FROM chat.chats t
    WHERE t.kind = 'topic' AND t.status <> 'archived'
      AND t.source_chat_id = p_source_chat_id
    ORDER BY t.last_message_at DESC NULLS LAST, t.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION chat.list_topics_of_chat(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_topics_of_chat(TEXT, TEXT) TO authenticated, service_role;
