-- Two hot read paths paid for rows they never return. Results, visibility and grants are unchanged.
--
-- 1. identity.pull_agent_inbox_v2 joined the reply preview (chat.can_read_message, about 0.3 ms a call)
--    for every message after the agent's read cursor, before the wake / receipt / block filters threw
--    almost all of them away. An idle pull of an agent with a long backlog spent seconds on it.
--    Now the page is chosen first (wake check first, it is the most selective), and only the rows of
--    that page are joined to their reply preview and sender.
--
-- 2. chat.messages_view joined chat.message_reply_preview_for laterally, so every scanned row called it
--    even when the query never selects the reply columns. The chat-list preview (`chat_id=in.(...)`,
--    `order=seq.desc`, `limit=4n`, computed column `preview`) reads every visible row of those chats
--    and sorts them, so it paid one call per message in the chat. The reply columns are now scalar
--    subqueries: unselected, they are never evaluated; selected, only for the rows the query returns
--    (after the sort and limit).
--
-- 3. messages_select_member probed chat_members once per row, and that probe ran the chat_members row
--    policy (chat.is_member, another lookup) once per row as well. The common case - a member without a
--    history floor - is now one set of chat ids per query, which the planner hashes; members with a
--    floor keep the correlated check exactly as before.

CREATE OR REPLACE FUNCTION identity.pull_agent_inbox_v2(p_agent_user_id text, p_chat_id text DEFAULT NULL::text, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 80, p_scan_after jsonb DEFAULT NULL::jsonb, p_scan_max_ingest_seq bigint DEFAULT NULL::bigint) RETURNS TABLE(chat_id text, chat_kind text, chat_public_id integer, chat_name text, chat_creator_user_id text, listen_mode text, notification_level text, last_read_seq bigint, id text, seq bigint, sender_user_id text, sender_type text, sender_display_name text, sender_gugu_number integer, content text, content_type text, to_user_ids text[], is_whisper boolean, reply_to_message_id text, reply_to_sender_user_id text, reply_to_content text, thread_root_id text, is_thread_root boolean, created_at timestamp with time zone, scan_max_ingest_seq bigint, via_app text, file_item_id uuid, file_version integer, file_blob_id uuid)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'chat', 'identity', 'public'
    AS $$
 DECLARE
     -- 这一次扫描的上界:首页取序列此刻的位置并随行返回,后续页原样传回。❌ 墙钟(#6327)。
     v_fence BIGINT;
 BEGIN
     -- 授权镜像 chat.can_act_as 的身份半边(fail-closed):调用者是该 agent 本人,或拥有该 agent。
     IF (SELECT auth.uid()) IS NULL THEN
         RAISE EXCEPTION 'not authenticated';
     END IF;
     IF NOT (
         p_agent_user_id = (SELECT auth.uid()::text)
         OR EXISTS (
             SELECT 1 FROM identity.users u
             WHERE u.id = p_agent_user_id
               AND u.type = 'agent'
               AND u.owner_user_id = (SELECT auth.uid()::text)
         )
     ) THEN
         RAISE EXCEPTION 'not authorized to pull unread for %', p_agent_user_id;
     END IF;

     v_fence := COALESCE(
         p_scan_max_ingest_seq,
         pg_sequence_last_value(pg_get_serial_sequence('chat.messages', 'ingest_seq')::regclass),
         0
     );

     IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id = p_agent_user_id AND u.session_archived_at IS NOT NULL) THEN RETURN; END IF;

     RETURN QUERY
     SELECT
         page.chat_id,
         page.kind,
         page.public_id,
         page.name,
         page.creator_user_id,
         page.listen_mode,
         page.notification_level,
         page.last_read_seq,
         page.id,
         page.seq,
         page.sender_user_id,
         su.type,
         su.display_name,
         su.gugu_number,
         page.content,
         page.content_type,
         page.to_user_ids,
         page.is_whisper,
         page.reply_to_message_id,
         rm.sender_user_id,
         rm.content,
         page.thread_root_id,
         page.is_thread_root,
         page.created_at,
         v_fence,
         page.via_app,
         -- ◇ 附件指针(agent 拿它去 attachments/urls 取字节)。
         page.file_item_id,
         page.file_version,
         page.file_blob_id
     FROM (
         SELECT woken.*
         FROM (
             -- 候选:读游标之后、入群之后、本次扫描上界之内、这条消息叫醒了这个 agent。
             -- OFFSET 0 keeps this a separate plan step: the wake check (most selective) runs before the
             -- receipt and block checks below, which then only see messages that woke this agent.
             SELECT
                 m.chat_id, c.kind, c.public_id, c.name, c.creator_user_id,
                 cm.listen_mode, cm.notification_level, cm.last_read_seq,
                 m.id, m.seq, m.sender_user_id, m.content, m.content_type, m.to_user_ids, m.is_whisper,
                 m.reply_to_message_id, m.thread_root_id, m.is_thread_root, m.created_at, m.via_app,
                 m.file_item_id, m.file_version, m.file_blob_id
             FROM chat.chat_members cm
             JOIN chat.chats c    ON c.id = cm.chat_id
             JOIN chat.messages m ON m.chat_id = cm.chat_id
             WHERE cm.user_id = p_agent_user_id
               AND (p_chat_id IS NULL OR cm.chat_id = p_chat_id)
               AND c.status = 'active'
               AND m.deleted_at IS NULL
               -- A deregistered human/agent is not retroactively a system sender.
               AND (m.sender_user_id IS NOT NULL OR m.content_type = 'system')
               AND m.seq > GREATEST(cm.last_read_seq, COALESCE(p_after_seq, 0))
               -- #5258 入群门:只投递 agent 在场之后到达的消息。入群前的历史归它自己按需回看,
               -- ❌ 不当积压推。与 hide_history_before 那道门同形(`>=`,同一 now() 时钟)。
               AND m.ingest_seq > cm.joined_ingest_seq
               AND m.ingest_seq <= v_fence
               AND (p_scan_after IS NULL OR
                    (m.chat_id, m.seq) > (p_scan_after->>'chat_id', (p_scan_after->>'seq')::BIGINT))
               -- @@@6400 「叫醒谁」在消息写入那一刻定下(chat.message_agent_wakes),这里只读结果。
               -- ❌ 再拿此刻的 to_user_ids / 回复目标 / 档位重判:它们事后会变(删 agent、注销、切档)。
               AND EXISTS (
                   SELECT 1 FROM chat.message_agent_wakes w
                   WHERE w.message_id = m.id
                     AND w.agent_user_id = p_agent_user_id
               )
             OFFSET 0
         ) woken
         WHERE NOT EXISTS (SELECT 1 FROM chat.message_agent_delivery_blocks b WHERE b.message_id = woken.id AND b.agent_user_id = p_agent_user_id)
           -- 已消费排除:水位可停滞(gap gate),精确读行才是逐条消费事实
           AND NOT EXISTS (
               SELECT 1 FROM chat.message_deliveries d
               WHERE d.message_id = woken.id
                 AND d.device_id = 'gugu-agent:' || p_agent_user_id
                 AND d.status = 'read'
           )
         ORDER BY woken.chat_id, woken.seq
         LIMIT GREATEST(COALESCE(p_limit, 80), 1)
     ) page
     -- 回复**预览**(给这个收件人看的上下文),按它的可读性裁剪;路由目标另算,见谓词的最后一个参数。
     -- Joined after the page is chosen: only returned rows pay for chat.can_read_message.
     LEFT JOIN chat.messages rm
            ON rm.id = page.reply_to_message_id
           AND rm.deleted_at IS NULL
           AND NOT rm.is_whisper
           -- @@@5856 **这个 agent** 读不读得到被回复的那一条:一条它入群前的消息被别人回复 + @ 它,
           -- 正文不许原样落到它主人的机器上。⚠️ 传 p_agent_user_id:auth.uid() 是调用方(主人),不是收件人。
           AND chat.can_read_message(rm.id, p_agent_user_id)
     LEFT JOIN identity.users su ON su.id = page.sender_user_id
     ORDER BY page.chat_id, page.seq;
 END;
 $$;

-- The function-DDL guard closes authenticated execution even on replacement. Restore the existing grant.
GRANT EXECUTE ON FUNCTION identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)
  TO authenticated, service_role;

-- Same columns, names, types and order; the reply preview is computed only where a column is read.
-- message_reply_preview_for returns at most one row (it looks a message up by id), so a scalar
-- subquery yields exactly what the lateral left join yielded: that row's values, or NULL.
CREATE OR REPLACE VIEW chat.messages_view WITH (security_invoker = true) AS
 SELECT m.id,
    m.chat_id,
    m.sender_user_id,
    m.to_user_ids,
    COALESCE(su.display_name, '未知用户'::text) AS sender_name,
    su.avatar AS sender_avatar,
    m.seq,
    m.content,
    m.content_type,
    m.reply_to_message_id,
    ( SELECT rp.reply_to_sender_user_id
        FROM chat.message_reply_preview_for(m.reply_to_message_id, ( SELECT (auth.uid())::text AS uid)) rp) AS reply_to_sender_user_id,
    ( SELECT rp.reply_to_sender_name
        FROM chat.message_reply_preview_for(m.reply_to_message_id, ( SELECT (auth.uid())::text AS uid)) rp) AS reply_to_sender_name,
    ( SELECT rp.reply_to_content
        FROM chat.message_reply_preview_for(m.reply_to_message_id, ( SELECT (auth.uid())::text AS uid)) rp) AS reply_to_content,
    m.deleted_at,
    m.deleted_for_user_ids,
    m.retracted_at,
    m.created_at,
    m.forwarded_from_message_id,
    m.thread_root_id,
    m.edited_at,
    m.is_whisper,
    m.is_thread_root,
    m.client_message_id,
    COALESCE((m.client_message_id ~ '^session-import-root:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text), false) AS is_imported_history_root,
    m.via_app,
    m.file_item_id,
    m.file_version,
    m.sent_by_agent,
        CASE
            WHEN (m.sender_user_id = ( SELECT (auth.uid())::text AS uid)) THEN ( SELECT jsonb_build_object('id', a.agent_user_id, 'name', a.agent_name) AS jsonb_build_object
               FROM chat.message_agent_sends a
              WHERE ((a.message_id = m.id) AND (a.owner_user_id = ( SELECT (auth.uid())::text AS uid))))
            ELSE NULL::jsonb
        END AS agent_sender,
    m.file_blob_id
   FROM (chat.messages m
     LEFT JOIN identity.users su ON ((su.id = m.sender_user_id)));

-- The chats in which the caller is a member without a history floor. The row policy's old EXISTS read
-- chat_members as the caller, and members_select_peer (chat.is_member) admits every committed row of
-- the caller's own, so reading them as the owner returns the same rows - without one is_member call
-- per membership row on every message query.
CREATE FUNCTION chat.caller_member_chats_without_floor() RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
    SELECT cm.chat_id
      FROM chat.chat_members cm
     WHERE cm.user_id = (SELECT auth.uid()::text)
       AND cm.hide_history_before IS NULL;
$$;
COMMENT ON FUNCTION chat.caller_member_chats_without_floor() IS 'messages_select_member 的成员半边(无入群前历史门):调用者自己是成员、且没有 hide_history_before 的会话。每条查询算一次、由规划器哈希,❌ 逐行探 chat_members。';
REVOKE ALL ON FUNCTION chat.caller_member_chats_without_floor() FROM PUBLIC, anon;
-- Row policies run with the caller's privileges.
GRANT EXECUTE ON FUNCTION chat.caller_member_chats_without_floor() TO authenticated;

-- Same rule as before: (member AND (no floor OR at/after the floor)) OR topic visibility, AND whisper rule.
-- The membership half is split on the floor. (chat_id, user_id) is the key of chat_members, so a caller
-- has at most one membership row per chat and the two halves never disagree with the original EXISTS.
ALTER POLICY messages_select_member ON chat.messages USING (
  (deleted_at IS NULL)
  AND (
    (chat_id IN (SELECT chat.caller_member_chats_without_floor()))
    OR (EXISTS (
      SELECT 1 FROM chat.chat_members cm
       WHERE cm.chat_id = messages.chat_id
         AND cm.user_id = ( SELECT (auth.uid())::text AS uid)
         AND messages.created_at >= cm.hide_history_before))
    OR chat.can_see_topic_message(chat_id, created_at, ( SELECT (auth.uid())::text AS uid))
  )
  AND chat.whisper_visible_to(is_whisper, sender_user_id, to_user_ids, ( SELECT (auth.uid())::text AS uid))
);
