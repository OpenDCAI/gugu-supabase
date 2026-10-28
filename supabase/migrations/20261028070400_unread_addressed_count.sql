-- 未读里「叫到你的」那一部分(owner 10-28,经管家定口径):项目行与「项目」页签只数叫到你的未读 —— 项目群主线(含回复串)照旧全算,
-- 从项目群开出来的话题只算叫到你的那几条。agent 开话题时会把它的主人自动拉成成员(topicOwnerEnrollment),
-- 主人没说过话、没被点名,agent 之间每来一条都进了他的角标和系统通知;客户端拿不到「这条叫没叫到你」,所以由这里给。
-- 「叫到你」= to_user_ids 里有你、有 @all('*'),或者这条回复的是你说的那条(与 agent 被叫醒的回复路由同一判据)。
-- unread_count 不变:话题自己的页签 / 列表行照旧数全部未读。返回列只在末尾加 addressed_count;sync_snapshot 的 unread 直接带出它。

DROP FUNCTION chat.list_unread_locators(text);

CREATE FUNCTION chat.list_unread_locators(p_chat_id text DEFAULT NULL::text) RETURNS TABLE(chat_id text, stream_id text, stream_kind text, thread_root_id text, message_id text, message_seq bigint, unread_count bigint, cursor_seq bigint, version integer, is_marked_unread boolean, addressed_count bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
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
           -- 叫到你的:点名你、@all、或回复你说过的那条(同 agent 被叫醒的回复路由 message_reply_routing_target)。
           COUNT(message.id) FILTER (
             WHERE v_user = ANY (message.to_user_ids) OR '*' = ANY (message.to_user_ids)
                OR chat.message_reply_routing_target(message.reply_to_message_id) = v_user
           )::BIGINT AS addressed_count,
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
            AND NOT chat.is_pending_delivery(reply.id, reply.content_type, reply.sender_user_id, reply.client_message_id)
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
     AND NOT chat.is_pending_delivery(message.id, message.content_type, message.sender_user_id, message.client_message_id)
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
         streams.last_read_seq, streams.version, streams.is_marked_unread,
         -- 手动标未读是自己叫自己:同未读数一样至少算 1。
         GREATEST(streams.addressed_count, CASE WHEN streams.is_marked_unread THEN 1 ELSE 0 END)
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
      AND NOT chat.is_pending_delivery(message.id, message.content_type, message.sender_user_id, message.client_message_id)
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
