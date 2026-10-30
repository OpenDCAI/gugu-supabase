-- 车道 queued-status(owner 10-27):宿主替 agent 落的「还在等它接走」系统行(turn-failure 的 notAdmitted / undelivered)客户端不再画成一行,
-- 改为挂在等待的那几条消息的气泡上。这两种行因此也不该算未读、不该当会话列表的预览 —— 否则角标上是一条点进去找不到的未读。
-- 判据只有这一处:未读(list_unread_locators)与快照预览(sync_snapshot)都调它。行的格式见 gugu packages/core/src/shared/ui/systemNotice.ts
-- (client_message_id = turn-failure:<本行 id>:<原因>,发送者是那个 agent);客户端画与不画用同一格式的 isPendingDelivery。
-- 其它系统行(入群、话题、配额等真正的失败)照旧计未读、照旧当预览。

CREATE FUNCTION chat.is_pending_delivery(p_id text, p_content_type text, p_sender_user_id text, p_client_message_id text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  SELECT p_content_type = 'system' AND p_sender_user_id IS NOT NULL
     AND p_client_message_id IN ('turn-failure:' || p_id || ':notAdmitted', 'turn-failure:' || p_id || ':undelivered')
$$;
REVOKE ALL ON FUNCTION chat.is_pending_delivery(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.is_pending_delivery(text, text, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION chat.list_unread_locators(p_chat_id text DEFAULT NULL::text) RETURNS TABLE(chat_id text, stream_id text, stream_kind text, thread_root_id text, message_id text, message_seq bigint, unread_count bigint, cursor_seq bigint, version integer, is_marked_unread boolean)
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

CREATE OR REPLACE FUNCTION chat.sync_snapshot() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY INVOKER
    SET search_path = pg_catalog
AS $$
DECLARE
    viewer text := auth.uid()::text;
    result jsonb;
    response_bytes integer;
    -- A response is complete or an explicit error; never silently truncate rows.
    max_response_bytes CONSTANT integer := 16777216;
BEGIN
    IF viewer IS NULL THEN
        RAISE EXCEPTION 'authenticated account is required' USING ERRCODE = '42501';
    END IF;

    WITH conversations AS MATERIALIZED (
        SELECT c.id, c.public_id, c.kind, c.status, c.name, c.avatar_url,
               c.created_at, c.next_message_seq, c.pinned_message_id,
               c.source_chat_id, c.source_message_id
          FROM chat.chats c
          JOIN chat.chat_members own ON own.chat_id = c.id AND own.user_id = viewer
         WHERE own.inbox_published_at IS NOT NULL
           AND c.status IN ('active', 'stopped', 'paused')
    ), members AS MATERIALIZED (
        SELECT m.chat_id, m.user_id, m.last_read_seq, m.is_marked_unread, m.version,
               m.notification_level, m.is_pinned, m.updated_at, m.joined_at,
               m.inbox_published_at, m.role
          FROM chat.chat_members m JOIN conversations c ON c.id = m.chat_id
    ), identity_ids AS (
        SELECT viewer AS id UNION SELECT user_id FROM members
        UNION SELECT CASE WHEN f.user_a_id = viewer THEN f.user_b_id ELSE f.user_a_id END
                FROM identity.friendships f
               WHERE viewer IN (f.user_a_id, f.user_b_id)
        UNION SELECT u.id FROM identity.users u WHERE u.owner_user_id = viewer
    ), identities AS MATERIALIZED (
        SELECT u.id, u.gugu_number, u.display_name, u.avatar, u.bio, u.type,
               u.owner_user_id, u.agent_public, u.desired_status, u.device_id,
               u.category, u.is_official, u.local_path, u.created_at, u.updated_at
          FROM identity.users u JOIN identity_ids ids ON ids.id = u.id
    ), previews AS (
        SELECT c.id AS chat_id, p.id, p.created_at, p.preview, p.seq,
               p.content_type, p.sender_user_id, p.client_message_id
          FROM conversations c
          LEFT JOIN LATERAL (
              SELECT v.id, v.created_at, chat.preview(v) AS preview, v.seq, v.content_type,
                     v.sender_user_id, v.client_message_id
                FROM chat.messages_view v
               WHERE v.chat_id = c.id AND v.is_whisper = false
                 AND NOT chat.is_pending_delivery(v.id, v.content_type, v.sender_user_id, v.client_message_id)
               ORDER BY v.seq DESC LIMIT 1
          ) p ON true
    )
    SELECT jsonb_build_object(
        'account_id', viewer,
        'revision', COALESCE((SELECT h.revision FROM chat.account_revision_heads h
                              WHERE h.user_id = viewer), 0)::text,
        'chats', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM conversations c), '[]'::jsonb),
        'memberships', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.chat_id, m.user_id) FROM members m), '[]'::jsonb),
        'identities', COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM identities u), '[]'::jsonb),
        'previews', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.chat_id) FROM previews p), '[]'::jsonb),
        'unread', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.chat_id, r.stream_id)
                            FROM chat.list_unread_locators(NULL) r), '[]'::jsonb),
        'overrides', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'target_kind', o.target_kind, 'target_id', o.target_id,
            'contact_user_id', o.contact_user_id, 'alias', o.alias) ORDER BY o.target_kind, o.target_id)
            FROM identity.contact_overrides o WHERE o.owner_user_id = viewer), '[]'::jsonb),
        'presence', COALESCE((SELECT jsonb_object_agg(u.id, identity.get_agent_presence(u.id))
            FROM identities u WHERE u.type = 'agent' AND identity.can_view_agent_runtime_state(u.id)), '{}'::jsonb)
    ) INTO result;

    response_bytes := octet_length(result::text);
    IF response_bytes > max_response_bytes THEN
        RAISE EXCEPTION 'account snapshot requires % bytes; response budget is % bytes',
            response_bytes, max_response_bytes USING ERRCODE = '54000';
    END IF;
    RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION chat.sync_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.sync_snapshot() TO authenticated;
