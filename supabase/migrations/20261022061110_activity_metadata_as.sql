-- One message-visibility rule for every actor-scoped message reader, and chat activity metadata by time.
--
-- 1. chat.message_visible_at is the visibility rule for a message once the actor's history floor in its chat
--    is known: the message is not before that floor, and a whisper names the actor as sender or recipient.
--    chat.message_visible_to (one message) is now that rule applied to chat.history_floor. The list readers
--    message_history_as, message_search_as and list_topics_of_chat used to restate the two halves inline so
--    the floor is computed once per query; they now call message_visible_at with that floor, which the planner
--    inlines, so a rule added there reaches every reader at once. Deletion stays the readers' own condition:
--    it is about whether the message exists, and the deletion broadcast still needs to address the actors
--    who could see the deleted message. "Delete for me" is not part of visibility here, as before: the row
--    policy, can_read_message and these readers all still let that person read the message; only the
--    human list and unread views hide it.
--
-- 2. chat.activity_metadata_as, for a person or one of their agents: when which message appeared in which
--    of their chats, never what it said. An assistant reads the context separately through
--    message_history_as. Account revisions are written for human accounts only
--    (20261021130331_human_user_events), so this reads chat.messages rather than the actor's revision
--    journal: an agent's answer is never an empty journal. Each event is a message the actor can see now
--    by the rule above: without p_chat_id over its own membership rows (topics included), with p_chat_id
--    under the same floor as message_history_as. Only identifiers and times are returned: never content,
--    previews, recipients or attachment references. Membership, read, reaction and delivery changes are
--    not covered. Asking about a chat the actor cannot see is an error, not an empty page. Paging follows
--    the message ingest sequence under a fixed watermark: the first page fixes through_revision,
--    next_revision continues after the last returned event, and messages that arrive later appear in a
--    new query.

CREATE FUNCTION chat.message_visible_at(p_floor timestamptz, p_created_at timestamptz, p_is_whisper boolean, p_sender_user_id text, p_to_user_ids text[], p_actor text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
    -- An unknown floor (not a member) admits nothing. Each argument is used once, so the planner inlines this
    -- into list readers and the floor stays an index condition.
    SELECT p_created_at OPERATOR(pg_catalog.>=) COALESCE(p_floor, 'infinity'::pg_catalog.timestamptz)
       AND chat.whisper_visible_to(p_is_whisper, p_sender_user_id, p_to_user_ids, p_actor)
$$;
REVOKE ALL ON FUNCTION chat.message_visible_at(timestamptz, timestamptz, boolean, text, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.message_visible_at(timestamptz, timestamptz, boolean, text, text[], text) TO service_role;

CREATE OR REPLACE FUNCTION chat.message_visible_to(p_chat_id text, p_created_at timestamp with time zone, p_is_whisper boolean, p_sender_user_id text, p_to_user_ids text[], p_actor text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
    RETURN chat.message_visible_at(chat.history_floor(p_chat_id, p_actor),
        p_created_at, p_is_whisper, p_sender_user_id, p_to_user_ids, p_actor);
END;
$$;
REVOKE ALL ON FUNCTION chat.message_visible_to(text, timestamptz, boolean, text, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.message_visible_to(text, timestamptz, boolean, text, text[], text) TO service_role;

CREATE OR REPLACE FUNCTION chat.message_history_as(p_chat_id text, p_as_user_id text DEFAULT NULL::text, p_thread_root_id text DEFAULT NULL::text, p_before_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 20) RETURNS TABLE(id text, seq bigint, sender_user_id text, sender_name text, to_user_ids text[], content text, content_type text, reply_to_message_id text, thread_root_id text, created_at timestamp with time zone)
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
           m.content_type, m.reply_to_message_id, m.thread_root_id, m.created_at
      FROM chat.messages m
      LEFT JOIN identity.users u ON u.id = m.sender_user_id
     WHERE m.chat_id = p_chat_id
       AND m.deleted_at IS NULL
       AND m.thread_root_id IS NOT DISTINCT FROM NULLIF(p_thread_root_id, '')
       AND (p_before_seq IS NULL OR m.seq < p_before_seq)
       -- The one visibility rule; the actor's history floor is computed once per query.
       AND chat.message_visible_at((SELECT chat.history_floor(p_chat_id, v_actor)),
             m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, v_actor)
     ORDER BY m.seq DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
END;
$$;
REVOKE ALL ON FUNCTION chat.message_history_as(text, text, text, bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.message_history_as(text, text, text, bigint, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION chat.message_search_as(p_chat_id text, p_query text, p_as_user_id text DEFAULT NULL::text, p_before_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 20) RETURNS TABLE(id text, seq bigint, sender_user_id text, sender_name text, content text, content_type text, thread_root_id text, created_at timestamp with time zone)
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
    RETURN QUERY
    SELECT m.id, m.seq::BIGINT, m.sender_user_id, COALESCE(u.display_name, '未知用户'), m.content,
           m.content_type, m.thread_root_id, m.created_at
      FROM chat.messages m
      LEFT JOIN identity.users u ON u.id = m.sender_user_id
     WHERE m.chat_id = p_chat_id
       AND m.deleted_at IS NULL
       AND m.content ILIKE v_pattern
       AND (p_before_seq IS NULL OR m.seq < p_before_seq)
       -- The one visibility rule; the actor's history floor is computed once per query.
       AND chat.message_visible_at((SELECT chat.history_floor(p_chat_id, v_actor)),
             m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, v_actor)
     ORDER BY m.seq DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
END;
$$;
REVOKE ALL ON FUNCTION chat.message_search_as(text, text, text, bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.message_search_as(text, text, text, bigint, integer) TO authenticated, service_role;

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
        -- The one visibility rule; the floor is computed once per topic.
        (SELECT count(*) FROM chat.messages m
          WHERE m.chat_id = t.id AND m.deleted_at IS NULL
            AND chat.message_visible_at((SELECT chat.history_floor(t.id, v_actor)),
                  m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, v_actor)),
        (SELECT count(*) FROM chat.chat_members cm WHERE cm.chat_id = t.id),
        chat.is_chat_member(t.id, v_actor)
    FROM chat.chats t
    WHERE t.kind = 'topic'
      AND t.source_chat_id = p_source_chat_id
    ORDER BY t.last_message_at DESC NULLS LAST, t.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION chat.list_topics_of_chat(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_topics_of_chat(text, text) TO authenticated, service_role;

CREATE INDEX idx_messages_chat_created_alive ON chat.messages USING btree (chat_id, created_at) WHERE (deleted_at IS NULL);

CREATE FUNCTION chat.activity_metadata_as(
    p_as_user_id text,
    p_since timestamptz,
    p_until timestamptz,
    p_chat_id text DEFAULT NULL,
    p_after_revision bigint DEFAULT 0,
    p_through_revision bigint DEFAULT NULL,
    p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_head bigint;
    v_through bigint;
    v_events jsonb;
    v_next bigint;
BEGIN
    IF p_as_user_id IS NULL OR NOT chat.is_acting_as(p_as_user_id) THEN
        RAISE EXCEPTION 'Not allowed to read activity as %', p_as_user_id USING ERRCODE = '42501';
    END IF;
    IF p_since IS NULL OR p_until IS NULL OR NOT isfinite(p_since) OR NOT isfinite(p_until) OR p_since >= p_until THEN
        RAISE EXCEPTION 'Activity requires a finite, increasing time range' USING ERRCODE = '22023';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 OR p_after_revision IS NULL OR p_after_revision < 0 THEN
        RAISE EXCEPTION 'Invalid activity page size or cursor' USING ERRCODE = '22023';
    END IF;
    IF p_chat_id IS NOT NULL AND chat.history_floor(p_chat_id, p_as_user_id) IS NULL THEN
        RAISE EXCEPTION 'Not allowed to read activity of chat % as %', p_chat_id, p_as_user_id USING ERRCODE = '42501';
    END IF;
    v_head := COALESCE(pg_sequence_last_value(pg_get_serial_sequence('chat.messages', 'ingest_seq')::regclass), 0);
    v_through := COALESCE(p_through_revision, v_head);
    IF v_through < p_after_revision OR v_through > v_head THEN
        RAISE EXCEPTION 'Activity cursor is outside the message sequence' USING ERRCODE = '22023';
    END IF;

    WITH visible_chats AS (
        SELECT c.chat_id, chat.history_floor(c.chat_id, p_as_user_id) AS floor
          FROM (SELECT p_chat_id AS chat_id WHERE p_chat_id IS NOT NULL
                UNION
                SELECT cm.chat_id FROM chat.chat_members cm
                 WHERE p_chat_id IS NULL AND cm.user_id = p_as_user_id) c
    ), eligible AS (
        SELECT m.ingest_seq, m.chat_id, m.id, m.sender_user_id, m.thread_root_id, m.created_at
          FROM visible_chats v
          JOIN chat.messages m ON m.chat_id = v.chat_id
         WHERE m.deleted_at IS NULL
           AND m.created_at >= p_since AND m.created_at < p_until
           AND m.ingest_seq > p_after_revision AND m.ingest_seq <= v_through
           AND chat.message_visible_at(v.floor, m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, p_as_user_id)
         ORDER BY m.ingest_seq
         LIMIT p_limit + 1
    ), numbered AS (
        SELECT e.*, row_number() OVER (ORDER BY e.ingest_seq) AS page_rank FROM eligible e
    )
    SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'revision', n.ingest_seq, 'kind', 'message_created', 'occurred_at', n.created_at,
               'chat_id', n.chat_id, 'message_id', n.id, 'sender_user_id', n.sender_user_id,
               'thread_root_id', n.thread_root_id)) ORDER BY n.ingest_seq) FILTER (WHERE n.page_rank <= p_limit), '[]'::jsonb),
           CASE WHEN count(*) > p_limit THEN max(n.ingest_seq) FILTER (WHERE n.page_rank <= p_limit) END
      INTO v_events, v_next
      FROM numbered n;

    RETURN jsonb_build_object('events', v_events, 'next_revision', v_next, 'through_revision', v_through,
        'coverage', jsonb_strip_nulls(jsonb_build_object(
            'scope', 'actor_visible_chat_messages', 'actor_user_id', p_as_user_id, 'chat_id', p_chat_id,
            'queried_at', now(),
            'note', 'Message creation only, at its database time. Current membership, history floor and whisper visibility are rechecked; deleted or no longer visible messages are omitted. Membership, read, reaction and delivery changes are not included. Messages that arrive after the first page appear in a new query.')));
END;
$function$;
REVOKE ALL ON FUNCTION chat.activity_metadata_as(text, timestamptz, timestamptz, text, bigint, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.activity_metadata_as(text, timestamptz, timestamptz, text, bigint, bigint, integer) TO authenticated, service_role;
