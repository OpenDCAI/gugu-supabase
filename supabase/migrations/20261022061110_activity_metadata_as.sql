-- One message-visibility rule for every function that reads messages for an actor, and chat activity metadata
-- by time.
--
-- 1. chat.message_visible_at is the visibility rule for a message once the actor's floor in its chat is known:
--    the message is not before that floor, and a whisper names the actor as sender or recipient. The functions
--    below restated the two halves inline; they now all call this rule, which the planner inlines, so a rule
--    added there reaches all of them at once.
--    - Under chat.history_floor: message_visible_to (one message), message_history_as, message_search_as,
--      list_topics_of_chat (the floor computed once per query or topic, so it stays an index condition), and
--      get_agent_join_context. The join context used the agent's own membership row, so in a topic it left out
--      lines the agent can page back to through the source chat; it now counts what the history shows.
--    - Under the member's own floor in the chat (unread starts at their own boundary there; for a group this is
--      chat.history_floor): list_unread_locators and mark_unread. mark_unread applied no floor, so it marked a
--      stream unread whose every message the member cannot see, and the locator had no message to point at.
--    The row policy messages_select_member keeps its own form. It runs as the caller, who may not compute
--    another actor's floor, and a policy that calls a floor function per row read a member's chat page about 25
--    times slower. The answer-sheet test oneWhisperRule6835 holds it to the same answers as these functions.
--    Deletion stays each reader's own condition: it is about whether the message exists, and the deletion
--    broadcast still needs to address the actors who could see the deleted message. "Delete for me" is not part
--    of visibility, as before: the row policy, can_read_message and the actor readers still let that person read
--    the message; only the human list and unread views hide it.
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

CREATE OR REPLACE FUNCTION chat.list_unread_locators(p_chat_id text DEFAULT NULL::text) RETURNS TABLE(chat_id text, stream_id text, stream_kind text, thread_root_id text, message_id text, message_seq bigint, unread_count bigint, cursor_seq bigint, version integer, is_marked_unread boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'public', 'pg_catalog'
    AS $_$
DECLARE
  v_user TEXT := (SELECT auth.uid()::text);
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_chat_id IS NOT NULL AND NOT chat.can_act_as(v_user, p_chat_id) THEN
    RAISE EXCEPTION 'not authorized to read unread locator for chat %', p_chat_id;
  END IF;

  RETURN QUERY
  WITH streams AS (
    SELECT source.chat_id, source.stream_id, source.stream_kind, source.thread_root_id,
           source.last_read_seq, source.is_marked_unread, source.version,
           COUNT(message.id)::BIGINT AS unread_count,
           MIN(message.seq) AS first_seq,
           (ARRAY_AGG(message.id ORDER BY message.seq, message.id)
             FILTER (WHERE message.id IS NOT NULL))[1] AS first_id
    FROM (
      SELECT member.chat_id, 'main:' || member.chat_id AS stream_id, 'main'::TEXT AS stream_kind,
             NULL::TEXT AS thread_root_id, member.last_read_seq, member.is_marked_unread,
             member.version, member.hide_history_before
      FROM chat.chat_members member
      JOIN chat.chats conversation ON conversation.id = member.chat_id
      WHERE member.user_id = v_user
        AND member.inbox_published_at IS NOT NULL
        AND conversation.status IN ('active', 'stopped', 'paused')
        AND (p_chat_id IS NULL OR member.chat_id = p_chat_id)
      UNION ALL
      SELECT stream.chat_id, stream.stream_id, stream.stream_kind, stream.thread_root_id,
             stream.last_read_seq, stream.is_marked_unread, stream.version, member.hide_history_before
      FROM chat.chat_member_stream_read_state stream
      JOIN chat.chat_members member
        ON member.chat_id = stream.chat_id AND member.user_id = stream.user_id
      JOIN chat.chats conversation ON conversation.id = stream.chat_id
      WHERE stream.user_id = v_user
        AND stream.stream_kind = 'thread'
        AND member.inbox_published_at IS NOT NULL
        AND conversation.status IN ('active', 'stopped', 'paused')
        AND (p_chat_id IS NULL OR stream.chat_id = p_chat_id)
      UNION ALL
      SELECT root.chat_id, 'thread:' || root.chat_id || ':' || root.id, 'thread'::TEXT, root.id,
             0, false, 0, member.hide_history_before
      FROM chat.messages root
      JOIN chat.chat_members member ON member.chat_id = root.chat_id AND member.user_id = v_user
      JOIN chat.chats conversation ON conversation.id = root.chat_id
      WHERE root.thread_root_id IS NULL
        AND root.is_thread_root = true
        AND NOT COALESCE(
          root.client_message_id ~ '^session-import-root:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          false
        )
        AND root.deleted_at IS NULL
        AND member.inbox_published_at IS NOT NULL
        AND conversation.kind = 'group'
        AND conversation.status IN ('active', 'stopped', 'paused')
        AND (p_chat_id IS NULL OR root.chat_id = p_chat_id)
        AND EXISTS (
          SELECT 1 FROM chat.messages reply
          WHERE reply.chat_id = root.chat_id
            AND reply.thread_root_id = root.id
            AND reply.deleted_at IS NULL
            AND NOT (reply.deleted_for_user_ids @> jsonb_build_array(v_user))
            AND reply.seq > 0
            AND reply.sender_user_id <> v_user
            AND chat.message_visible_at(COALESCE(member.hide_history_before, '-infinity'::timestamptz),
                  reply.created_at, reply.is_whisper, reply.sender_user_id, reply.to_user_ids, v_user)
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat.chat_member_stream_read_state existing
          WHERE existing.chat_id = root.chat_id
            AND existing.user_id = v_user
            AND existing.stream_id = 'thread:' || root.chat_id || ':' || root.id
        )
    ) source
    LEFT JOIN chat.messages message
      ON message.chat_id = source.chat_id
     AND message.deleted_at IS NULL
     AND NOT (message.deleted_for_user_ids @> jsonb_build_array(v_user))
     AND message.seq > source.last_read_seq
     AND message.sender_user_id <> v_user
     AND chat.message_visible_at(COALESCE(source.hide_history_before, '-infinity'::timestamptz),
           message.created_at, message.is_whisper, message.sender_user_id, message.to_user_ids, v_user)
     AND ((source.stream_kind = 'main' AND message.thread_root_id IS NULL)
       OR (source.stream_kind = 'thread' AND message.thread_root_id = source.thread_root_id))
    GROUP BY source.chat_id, source.stream_id, source.stream_kind, source.thread_root_id,
             source.last_read_seq, source.is_marked_unread, source.version, source.hide_history_before
  )
  SELECT streams.chat_id, streams.stream_id, streams.stream_kind, streams.thread_root_id,
         COALESCE(streams.first_id, manual.message_id),
         COALESCE(streams.first_seq, manual.message_seq),
         GREATEST(streams.unread_count, CASE WHEN streams.is_marked_unread THEN 1 ELSE 0 END),
         streams.last_read_seq, streams.version, streams.is_marked_unread
  FROM streams
  LEFT JOIN LATERAL (
    SELECT message.id AS message_id, message.seq AS message_seq
    FROM chat.messages message
    JOIN chat.chat_members member
      ON member.chat_id = streams.chat_id AND member.user_id = v_user
    WHERE streams.is_marked_unread
      AND streams.first_id IS NULL
      AND message.chat_id = streams.chat_id
      AND message.deleted_at IS NULL
      AND NOT (message.deleted_for_user_ids @> jsonb_build_array(v_user))
      AND chat.message_visible_at(COALESCE(member.hide_history_before, '-infinity'::timestamptz),
            message.created_at, message.is_whisper, message.sender_user_id, message.to_user_ids, v_user)
      AND ((streams.stream_kind = 'main' AND message.thread_root_id IS NULL)
        OR (streams.stream_kind = 'thread' AND message.thread_root_id = streams.thread_root_id))
    ORDER BY message.seq DESC, message.id DESC
    LIMIT 1
  ) manual ON true
  WHERE streams.unread_count > 0 OR manual.message_id IS NOT NULL
  ORDER BY COALESCE(streams.first_seq, manual.message_seq), streams.stream_id;
END;
$_$;
REVOKE ALL ON FUNCTION chat.list_unread_locators(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_unread_locators(text) TO authenticated;

CREATE OR REPLACE FUNCTION chat.mark_unread(p_chat_id text, p_user_id text DEFAULT NULL::text) RETURNS TABLE(last_read_seq bigint, is_marked_unread boolean, version integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'public', 'pg_catalog'
    AS $$
DECLARE
  v_actor TEXT := COALESCE(NULLIF(p_user_id, ''), (SELECT auth.uid()::text));
BEGIN
  IF NOT chat.can_act_as(v_actor, p_chat_id) THEN
    RAISE EXCEPTION 'not authorized to mark unread for % in chat %', v_actor, p_chat_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM chat.messages m
    JOIN chat.chat_members member ON member.chat_id = m.chat_id AND member.user_id = v_actor
    WHERE m.chat_id = p_chat_id
      AND m.thread_root_id IS NULL
      AND m.deleted_at IS NULL
      AND NOT (m.deleted_for_user_ids @> jsonb_build_array(v_actor))
      -- The unread locator's floor: a stream marked unread always has a message the locator can point at.
      AND chat.message_visible_at(COALESCE(member.hide_history_before, '-infinity'::timestamptz),
            m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, v_actor)
  ) THEN
    RAISE EXCEPTION 'cannot mark an empty main stream unread for chat %', p_chat_id;
  END IF;

  RETURN QUERY
  UPDATE chat.chat_members AS member
  SET is_marked_unread = true,
      version = member.version + 1,
      updated_at = now()
  WHERE member.chat_id = p_chat_id AND member.user_id = v_actor
  RETURNING member.last_read_seq, member.is_marked_unread, member.version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat member % not found in chat %', v_actor, p_chat_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION chat.mark_unread(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.mark_unread(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION identity.get_agent_join_context(p_agent_user_id text, p_chat_id text) RETURNS TABLE(joined_at timestamp with time zone, skipped_before_join bigint, before_seq bigint, first_pull boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'identity', 'public'
    AS $$
DECLARE
    v_auth_uid       TEXT := auth.uid()::text;
    v_agent_type     TEXT;
    v_joined_at      TIMESTAMPTZ;
    v_last_read_seq  BIGINT;
    v_join_context_shown_at TIMESTAMPTZ;
    v_skipped        BIGINT;
    v_last_pre_seq   BIGINT;
    v_before_seq     BIGINT;
    v_next_seq       BIGINT;
BEGIN
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'not authenticated';
    END IF;
    IF NOT (
        p_agent_user_id = v_auth_uid
        OR EXISTS (
            SELECT 1
            FROM identity.users u
            WHERE u.id = p_agent_user_id
              AND u.type = 'agent'
              AND u.owner_user_id = v_auth_uid
        )
    ) THEN
        RAISE EXCEPTION 'not authorized to read join context for %', p_agent_user_id;
    END IF;

    SELECT u.type INTO v_agent_type
    FROM identity.users u
    WHERE u.id = p_agent_user_id;
    IF v_agent_type IS DISTINCT FROM 'agent' THEN
        RETURN;
    END IF;

    SELECT cm.joined_at, cm.last_read_seq, cm.join_context_shown_at, c.next_message_seq
      INTO v_joined_at, v_last_read_seq, v_join_context_shown_at, v_next_seq
      FROM chat.chat_members cm
      JOIN chat.chats c ON c.id = cm.chat_id
     WHERE cm.chat_id = p_chat_id
       AND cm.user_id = p_agent_user_id
     FOR UPDATE OF cm;
    IF NOT FOUND OR COALESCE(v_last_read_seq, 0) <> 0 OR v_join_context_shown_at IS NOT NULL THEN
        RETURN;
    END IF;

    -- The reader's rule under the reader's floor (message_history_as): only what this agent can page back
    -- to is claimed as recoverable context, including a topic's lines it reads through the source chat.
    SELECT COUNT(*)::BIGINT, MAX(m.seq)
      INTO v_skipped, v_last_pre_seq
      FROM chat.messages m
     WHERE m.chat_id = p_chat_id
       AND m.deleted_at IS NULL
       AND m.sender_user_id <> p_agent_user_id
       AND m.created_at < v_joined_at
       AND chat.message_visible_at((SELECT chat.history_floor(p_chat_id, p_agent_user_id)),
             m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, p_agent_user_id);
    IF COALESCE(v_skipped, 0) = 0 THEN
        UPDATE chat.chat_members
           SET join_context_shown_at = now()
         WHERE chat_id = p_chat_id AND user_id = p_agent_user_id;
        RETURN;
    END IF;

    v_before_seq := COALESCE(v_last_pre_seq + 1, v_next_seq, 1);
    UPDATE chat.chat_members
       SET join_context_shown_at = now()
     WHERE chat_id = p_chat_id AND user_id = p_agent_user_id;
    RETURN QUERY SELECT v_joined_at, v_skipped, v_before_seq, TRUE;
END;
$$;
REVOKE ALL ON FUNCTION identity.get_agent_join_context(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.get_agent_join_context(text, text) TO authenticated;

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

    -- Materialized: each chat's floor is computed once, whichever join the planner picks for the messages.
    WITH visible_chats AS MATERIALIZED (
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
