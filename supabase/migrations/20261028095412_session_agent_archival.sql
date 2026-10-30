-- Session archival is reversible. Identity removal remains a separate operation.
-- Local hosts archive offline and synchronize their original intervals afterwards.
ALTER TABLE identity.users
  ADD COLUMN session_archived_at timestamptz,
  ADD COLUMN session_lifecycle_revision bigint NOT NULL DEFAULT 0 CHECK (session_lifecycle_revision >= 0),
  ADD COLUMN session_lifecycle_operation_id uuid,
  ADD COLUMN session_lifecycle_operation_hash text;
GRANT SELECT (session_archived_at, session_lifecycle_revision, session_lifecycle_operation_id)
  ON identity.users TO authenticated;

CREATE TABLE identity.agent_session_archive_intervals (
  agent_user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  archived_at timestamptz NOT NULL,
  restored_at timestamptz,
  PRIMARY KEY (agent_user_id, id),
  CHECK (restored_at IS NULL OR restored_at >= archived_at)
);
ALTER TABLE identity.agent_session_archive_intervals ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON identity.agent_session_archive_intervals TO authenticated;
CREATE POLICY agent_session_archive_intervals_owner ON identity.agent_session_archive_intervals
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM identity.users u WHERE u.id = agent_user_id AND u.owner_user_id = auth.uid()::text
  ));

-- A terminal refusal is not a read receipt and must survive restoration.
CREATE TABLE chat.message_agent_delivery_blocks (
  message_id text NOT NULL REFERENCES chat.messages(id) ON DELETE CASCADE,
  agent_user_id text NOT NULL,
  reason text NOT NULL DEFAULT 'agent_archived' CHECK (reason = 'agent_archived'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, agent_user_id)
);
CREATE INDEX message_agent_delivery_blocks_agent ON chat.message_agent_delivery_blocks(agent_user_id, message_id);
ALTER TABLE chat.message_agent_delivery_blocks ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON chat.message_agent_delivery_blocks TO authenticated;
CREATE POLICY message_agent_delivery_blocks_visible ON chat.message_agent_delivery_blocks
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM chat.messages m WHERE m.id = message_agent_delivery_blocks.message_id
  ));

CREATE FUNCTION chat.broadcast_agent_delivery_block() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE target_chat text;
BEGIN
  SELECT chat_id INTO target_chat FROM chat.messages WHERE id = NEW.message_id AND deleted_at IS NULL;
  IF target_chat IS NOT NULL THEN
    PERFORM chat.broadcast_to_chat_member_user_events(target_chat, 'delivery_changed',
      jsonb_build_object('receipt', jsonb_build_object('chat_id', target_chat,
        'message_id', NEW.message_id, 'device_id', 'gugu-agent:' || NEW.agent_user_id,
        'agent_user_id', NEW.agent_user_id, 'status', 'blocked', 'reason', NEW.reason)));
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION chat.broadcast_agent_delivery_block() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER message_agent_delivery_blocks_changed AFTER INSERT ON chat.message_agent_delivery_blocks
  FOR EACH ROW EXECUTE FUNCTION chat.broadcast_agent_delivery_block();

CREATE FUNCTION identity.set_agent_session_archival(
  p_agent_user_id text, p_device_id text, p_operation_id uuid, p_revision bigint,
  p_archived_at timestamptz, p_intervals jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  agent identity.users%ROWTYPE;
  item jsonb;
  interval_id uuid;
  starts timestamptz;
  ends timestamptz;
  prior identity.agent_session_archive_intervals%ROWTYPE;
  operation_hash text;
  viewer text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_operation_id IS NULL OR p_revision IS NULL OR p_revision <= 0
    OR jsonb_typeof(p_intervals) IS DISTINCT FROM 'array' OR jsonb_array_length(p_intervals) > 256 THEN
    RAISE EXCEPTION 'Invalid session archival operation' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO agent FROM identity.users
    WHERE id = p_agent_user_id AND type = 'agent' AND owner_user_id = auth.uid()::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agent is not owned by current user' USING ERRCODE = '42501'; END IF;
  IF agent.device_id IS DISTINCT FROM p_device_id OR NOT EXISTS (
    SELECT 1 FROM identity.gugu_devices d WHERE d.device_id = p_device_id AND d.user_id = auth.uid()
  ) THEN RAISE EXCEPTION 'Agent archival device does not match its owner' USING ERRCODE = '42501'; END IF;

  -- Admission runs after the message broadcast has acquired its revision heads.
  -- Take the same heads, globally ordered across all affected chats, before the
  -- state transition. No message path needs an identity lock for admission.
  FOR viewer IN
    SELECT DISTINCT v.id FROM (
      SELECT agent.id AS id UNION SELECT agent.owner_user_id
      UNION SELECT CASE WHEN f.user_a_id = agent.id THEN f.user_b_id ELSE f.user_a_id END
        FROM identity.friendships f WHERE agent.id IN (f.user_a_id, f.user_b_id)
      UNION SELECT peer.user_id FROM chat.chat_members mine
        JOIN chat.chat_members peer ON peer.chat_id = mine.chat_id
        WHERE mine.user_id = agent.id
      UNION SELECT peer.user_id FROM chat.chat_members mine
        JOIN chat.chats c ON c.id = mine.chat_id AND c.kind = 'topic'
        JOIN chat.chat_members peer ON peer.chat_id = c.source_chat_id
        WHERE mine.user_id = agent.id
    ) v WHERE v.id IS NOT NULL ORDER BY v.id
  LOOP
    INSERT INTO chat.account_revision_heads(user_id) VALUES(viewer) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM chat.account_revision_heads WHERE user_id = viewer FOR NO KEY UPDATE;
  END LOOP;
  SELECT * INTO agent FROM identity.users
    WHERE id = p_agent_user_id AND type = 'agent' AND owner_user_id = auth.uid()::text FOR NO KEY UPDATE;
  IF NOT FOUND OR agent.device_id IS DISTINCT FROM p_device_id THEN
    RAISE EXCEPTION 'Agent archival ownership changed' USING ERRCODE = '42501';
  END IF;
  operation_hash := md5(jsonb_build_object('device_id', p_device_id, 'revision', p_revision,
    'archived_at', extract(epoch FROM p_archived_at), 'intervals', p_intervals)::text);
  IF agent.session_lifecycle_operation_id = p_operation_id THEN
    IF agent.session_lifecycle_operation_hash IS DISTINCT FROM operation_hash THEN
      RAISE EXCEPTION 'Session archival operation payload changed' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('agent_user_id', agent.id, 'archived_at', agent.session_archived_at,
      'revision', agent.session_lifecycle_revision, 'operation_id', p_operation_id);
  END IF;
  IF p_revision <= agent.session_lifecycle_revision THEN
    RAISE EXCEPTION 'Stale session archival revision' USING ERRCODE = '40001';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_intervals) LOOP
    interval_id := (item->>'id')::uuid;
    starts := (item->>'archived_at')::timestamptz;
    ends := (item->>'restored_at')::timestamptz;
    IF interval_id IS NULL OR starts IS NULL OR (ends IS NOT NULL AND ends < starts) THEN
      RAISE EXCEPTION 'Invalid session archive interval' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO prior FROM identity.agent_session_archive_intervals
      WHERE agent_user_id = agent.id AND id = interval_id;
    IF FOUND AND (prior.archived_at <> starts OR (prior.restored_at IS NOT NULL AND prior.restored_at IS DISTINCT FROM ends)) THEN
      RAISE EXCEPTION 'A settled session archive interval cannot change' USING ERRCODE = '22023';
    END IF;
    INSERT INTO identity.agent_session_archive_intervals(agent_user_id, id, archived_at, restored_at)
      VALUES(agent.id, interval_id, starts, ends)
      ON CONFLICT(agent_user_id, id) DO UPDATE SET restored_at = EXCLUDED.restored_at;
  END LOOP;

  -- Every open interval must agree with the current state. Otherwise a restore
  -- could leave an unbounded interval that incorrectly refuses future messages.
  IF (SELECT count(*) FROM identity.agent_session_archive_intervals
      WHERE agent_user_id = agent.id AND restored_at IS NULL) <>
      (CASE WHEN p_archived_at IS NULL THEN 0 ELSE 1 END)
    OR (p_archived_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM identity.agent_session_archive_intervals
      WHERE agent_user_id = agent.id AND restored_at IS NULL AND archived_at = p_archived_at
    )) THEN
    RAISE EXCEPTION 'Session archive intervals do not match current state' USING ERRCODE = '22023';
  END IF;

  UPDATE identity.users SET session_archived_at = p_archived_at,
    session_lifecycle_revision = p_revision, session_lifecycle_operation_id = p_operation_id,
    session_lifecycle_operation_hash = operation_hash,
    updated_at = clock_timestamp() WHERE id = agent.id;

  -- Backfill only this recipient's unconsumed admissions from an offline interval.
  -- Message history, wake routing facts, membership and read cursors are unchanged.
  INSERT INTO chat.message_agent_delivery_blocks(message_id, agent_user_id)
    SELECT w.message_id, agent.id FROM chat.message_agent_wakes w
    JOIN chat.messages m ON m.id = w.message_id
    WHERE w.agent_user_id = agent.id AND EXISTS (
      SELECT 1 FROM identity.agent_session_archive_intervals i
      WHERE i.agent_user_id = agent.id AND m.created_at >= i.archived_at
        AND (i.restored_at IS NULL OR m.created_at < i.restored_at)
    ) AND NOT EXISTS (
      SELECT 1 FROM chat.message_deliveries d WHERE d.message_id = m.id
        AND d.device_id = 'gugu-agent:' || agent.id AND d.status = 'read'
    ) ON CONFLICT DO NOTHING;
  PERFORM identity.fan_agent_presence_to_viewers(agent.id, identity.build_agent_presence_payload(agent.id));
  RETURN jsonb_build_object('agent_user_id', agent.id, 'archived_at', p_archived_at,
    'revision', p_revision, 'operation_id', p_operation_id);
END;
$$;
REVOKE ALL ON FUNCTION identity.set_agent_session_archival(text,text,uuid,bigint,timestamptz,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.set_agent_session_archival(text,text,uuid,bigint,timestamptz,jsonb) TO authenticated;

CREATE TRIGGER users_publish_session_archival AFTER UPDATE OF session_archived_at ON identity.users
  FOR EACH ROW WHEN (OLD.session_archived_at IS DISTINCT FROM NEW.session_archived_at)
  EXECUTE FUNCTION identity.publish_identity_display_revision();

-- Freeze recipients after broadcast's revision locks and before enqueue. A send
-- that waited across archive AND restore must still honor the closed interval.
-- No identity locks are added after a message's chat locks.
CREATE OR REPLACE FUNCTION chat.record_message_agent_wakes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE recipient record; recipients jsonb; reply_target text; sender_is_agent boolean;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR chat.message_wakes_nobody(NEW.content_type, NEW.reply_to_message_id) THEN RETURN NEW; END IF;
  reply_target := chat.message_reply_routing_target(NEW.reply_to_message_id);
  sender_is_agent := EXISTS(SELECT 1 FROM identity.users s WHERE s.id = NEW.sender_user_id AND s.type = 'agent');
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'archived',
    u.session_archived_at IS NOT NULL OR EXISTS (
      SELECT 1 FROM identity.agent_session_archive_intervals i
      WHERE i.agent_user_id = u.id AND NEW.created_at >= i.archived_at
        AND (i.restored_at IS NULL OR NEW.created_at < i.restored_at)
    ))), '[]'::jsonb)
    INTO recipients FROM chat.chats c
    JOIN chat.chat_members cm ON cm.chat_id = c.id
    JOIN identity.users u ON u.id = cm.user_id AND u.type = 'agent'
    WHERE c.id = NEW.chat_id AND chat.message_wakes_agent(cm.user_id, cm.listen_mode,
      cm.notification_level, c.kind, NEW.sender_user_id, sender_is_agent,
      NEW.sender_user_id = c.creator_user_id, NEW.to_user_ids, NEW.is_whisper, reply_target)
    ;
  FOR recipient IN SELECT * FROM jsonb_to_recordset(recipients) AS r(id text, archived boolean)
  LOOP
    IF NOT recipient.archived THEN
      INSERT INTO chat.message_agent_wakes(message_id, agent_user_id) VALUES(NEW.id, recipient.id) ON CONFLICT DO NOTHING;
    ELSE
      INSERT INTO chat.message_agent_delivery_blocks(message_id, agent_user_id) VALUES(NEW.id, recipient.id) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.record_message_agent_wakes() FROM PUBLIC, anon, authenticated;
DROP TRIGGER messages_record_agent_wakes ON chat.messages;
CREATE TRIGGER messages_c_record_agent_admission AFTER INSERT ON chat.messages
  FOR EACH ROW EXECUTE FUNCTION chat.record_message_agent_wakes();


CREATE OR REPLACE FUNCTION chat.enqueue_agent_deliver_device_command() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
 DECLARE
     v_reply_target    TEXT;
     v_sender_is_agent BOOLEAN;
 BEGIN
     IF NEW.deleted_at IS NOT NULL THEN
         RETURN NEW;
     END IF;

     IF chat.message_wakes_nobody(NEW.content_type, NEW.reply_to_message_id)
        OR NULLIF(trim(COALESCE(NEW.content, '')), '') IS NULL THEN
         RETURN NEW;
     END IF;

     v_reply_target := chat.message_reply_routing_target(NEW.reply_to_message_id);
     v_sender_is_agent := EXISTS (
         SELECT 1 FROM identity.users s WHERE s.id = NEW.sender_user_id AND s.type = 'agent'
     );

     INSERT INTO identity.gugu_device_commands (user_id, device_id, type, payload)
     SELECT u.owner_user_id::uuid, u.device_id, 'agent.deliver',
            jsonb_build_object(
                'agent_user_id', u.id, 'chat_id', NEW.chat_id, 'message_id', NEW.id,
                'sender_user_id', NEW.sender_user_id, 'content', NEW.content,
                'to_user_ids', to_jsonb(NEW.to_user_ids),
                -- #1761 F0:真实 whisper 标记,不是「任何点名都真」的派生值。
                'is_whisper', NEW.is_whisper,
                'listen_mode', cm.listen_mode,
                -- #1531:thread root(is_thread_root 真且 thread_root_id 空)→ 回复进本条自身 thread。
                'thread_root_id', COALESCE(NEW.thread_root_id, CASE WHEN NEW.is_thread_root THEN NEW.id END)
            ) || COALESCE(
                   -- 回复预览按**收件人**的可读性算(#5856),❌ 不共用一份。
                   (SELECT to_jsonb(rp)
                      FROM chat.message_reply_preview_row(NEW.reply_to_message_id, u.id) rp),
                   '{}'::jsonb
                 )
     FROM chat.chats c
     JOIN chat.chat_members cm ON cm.chat_id = c.id
     JOIN identity.users u
       ON u.id = cm.user_id
      AND u.type = 'agent'
      AND u.owner_user_id IS NOT NULL
      AND u.device_id IS NOT NULL
      AND u.desired_status = 'online'
      AND u.session_archived_at IS NULL
      AND EXISTS (SELECT 1 FROM chat.message_agent_wakes w WHERE w.message_id = NEW.id AND w.agent_user_id = u.id)
     JOIN identity.gugu_devices d
       ON d.device_id = u.device_id
      AND d.user_id::text = u.owner_user_id
     WHERE c.id = NEW.chat_id
       AND c.status = 'active'
       AND chat.message_wakes_agent(
             u.id,
             cm.listen_mode,
             cm.notification_level,
             c.kind,
             NEW.sender_user_id,
             v_sender_is_agent,
             NEW.sender_user_id = c.creator_user_id,
             NEW.to_user_ids,
             NEW.is_whisper,
             v_reply_target
           );

     RETURN NEW;
 END;
 $$;


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
         m.chat_id,
         c.kind,
         c.public_id,
         c.name,
         c.creator_user_id,
         cm.listen_mode,
         cm.notification_level,
         cm.last_read_seq,
         m.id,
         m.seq,
         m.sender_user_id,
         su.type,
         su.display_name,
         su.gugu_number,
         m.content,
         m.content_type,
         m.to_user_ids,
         m.is_whisper,
         m.reply_to_message_id,
         rm.sender_user_id,
         rm.content,
         m.thread_root_id,
         m.is_thread_root,
         m.created_at,
         v_fence,
         m.via_app,
         -- ◇ 附件指针(agent 拿它去 attachments/urls 取字节)。
         m.file_item_id,
         m.file_version,
         m.file_blob_id
     FROM chat.chat_members cm
     JOIN chat.chats c    ON c.id = cm.chat_id
     JOIN chat.messages m ON m.chat_id = cm.chat_id
     -- 回复**预览**(给这个收件人看的上下文),按它的可读性裁剪;路由目标另算,见谓词的最后一个参数。
     LEFT JOIN chat.messages rm
            ON rm.id = m.reply_to_message_id
           AND rm.deleted_at IS NULL
           AND NOT rm.is_whisper
           -- @@@5856 **这个 agent** 读不读得到被回复的那一条:一条它入群前的消息被别人回复 + @ 它,
           -- 正文不许原样落到它主人的机器上。⚠️ 传 p_agent_user_id:auth.uid() 是调用方(主人),不是收件人。
           AND chat.can_read_message(rm.id, p_agent_user_id)
     LEFT JOIN identity.users su ON su.id = m.sender_user_id
     WHERE cm.user_id = p_agent_user_id
       AND (p_chat_id IS NULL OR cm.chat_id = p_chat_id)
       AND c.status = 'active'
       AND m.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM chat.message_agent_delivery_blocks b WHERE b.message_id = m.id AND b.agent_user_id = p_agent_user_id)
       -- A deregistered human/agent is not retroactively a system sender.
       AND (m.sender_user_id IS NOT NULL OR m.content_type = 'system')
       AND m.seq > GREATEST(cm.last_read_seq, COALESCE(p_after_seq, 0))
       -- #5258 入群门:只投递 agent 在场之后到达的消息。入群前的历史归它自己按需回看,
       -- ❌ 不当积压推。与 hide_history_before 那道门同形(`>=`,同一 now() 时钟)。
       AND m.ingest_seq > cm.joined_ingest_seq
       AND m.ingest_seq <= v_fence
       AND (p_scan_after IS NULL OR
            (m.chat_id, m.seq) > (p_scan_after->>'chat_id', (p_scan_after->>'seq')::BIGINT))
       -- 已消费排除:水位可停滞(gap gate),精确读行才是逐条消费事实
       AND NOT EXISTS (
           SELECT 1 FROM chat.message_deliveries d
           WHERE d.message_id = m.id
             AND d.device_id = 'gugu-agent:' || p_agent_user_id
             AND d.status = 'read'
       )
       -- @@@6400 「叫醒谁」在消息写入那一刻定下(chat.message_agent_wakes),这里只读结果。
       -- ❌ 再拿此刻的 to_user_ids / 回复目标 / 档位重判:它们事后会变(删 agent、注销、切档)。
       AND EXISTS (
           SELECT 1 FROM chat.message_agent_wakes w
           WHERE w.message_id = m.id
             AND w.agent_user_id = p_agent_user_id
       )
     ORDER BY m.chat_id, m.seq
     LIMIT GREATEST(COALESCE(p_limit, 80), 1);
 END;
 $$;


CREATE OR REPLACE FUNCTION identity.build_agent_presence_payload(p_agent_user_id text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'identity', 'public', 'pg_catalog'
    AS $$
DECLARE
    v_payload JSONB;
BEGIN
    SELECT jsonb_build_object(
        'presence', jsonb_build_object(
            'agent_user_id',        u.id,
            'account_status',       'active',
            'session_archived_at',  u.session_archived_at,
            'session_lifecycle_revision', u.session_lifecycle_revision,
            'runtime_status',       COALESCE(r.runtime_status, 'offline'),
            'desired_status',       COALESCE(u.desired_status, 'online'),
            'activity_status',      COALESCE(r.activity_status, 'idle'),
            -- #6448 宿主写下的读数;NULL = 这一行没有读数(读方退回 activity_status)。
            'agent_status',         r.agent_status,
            'agent_status_detail',  r.agent_status_detail,
            'active_chat_id',       r.active_chat_id,
            'runtime_kind',         r.runtime_kind,
            'runtime_label',        r.runtime_label,
            'agent_type',           ap.agent_type,
            'recent_tool_type',     r.recent_tool_type,
            'recent_actions',       COALESCE(r.recent_actions, ARRAY[]::TEXT[]),
            'last_action_at',       r.last_action_at,
            'window_title',         r.window_title,
            'pid',                  r.pid,
            'runtime_last_seen_at', r.last_seen_at,
            'device_id',            u.device_id,
            'device_status',        d.status,
            'device_last_seen_at',  d.last_seen_at,
            'host_runtime_capability', (d.capabilities->>'host_runtime_capability')::int,
            'consecutive_deliver_failures', COALESCE(r.consecutive_deliver_failures, 0),
            'updated_at',           GREATEST(
                                        COALESCE(u.updated_at, to_timestamp(0)),
                                        COALESCE(r.updated_at, to_timestamp(0)),
                                        COALESCE(d.updated_at, to_timestamp(0))
                                    )
        )
    )
      INTO v_payload
      FROM identity.users u
      LEFT JOIN identity.agent_runtime_states r ON r.agent_user_id = u.id
      LEFT JOIN identity.gugu_devices d ON d.device_id = u.device_id
      LEFT JOIN identity.agent_profiles ap ON ap.id::text = u.id
     WHERE u.id = p_agent_user_id
       AND u.type = 'agent';

    IF v_payload IS NOT NULL THEN
        RETURN v_payload;
    END IF;

    SELECT jsonb_build_object(
        'presence', jsonb_build_object(
            'agent_user_id',        t.agent_user_id,
            'account_status',       'removed',
            'runtime_status',       'offline',
            'desired_status',       'offline',
            'activity_status',      'idle',
            'agent_status',         NULL,
            'agent_status_detail',  NULL,
            'active_chat_id',       NULL,
            'runtime_kind',         NULL,
            'runtime_label',        NULL,
            'agent_type',           NULL,
            'recent_tool_type',     NULL,
            'recent_actions',       ARRAY[]::TEXT[],
            'last_action_at',       NULL,
            'window_title',         NULL,
            'pid',                  NULL,
            'runtime_last_seen_at', NULL,
            'device_id',            NULL,
            'device_status',        NULL,
            'device_last_seen_at',  NULL,
            'host_runtime_capability', NULL,
            'consecutive_deliver_failures', 0,
            'updated_at',           t.removed_at
        )
    )
      INTO v_payload
      FROM identity.agent_lifecycle_tombstones t
     WHERE t.agent_user_id = p_agent_user_id;

    RETURN v_payload;
END;
$$;


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
               u.session_archived_at, u.session_lifecycle_revision,
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


CREATE OR REPLACE FUNCTION identity.recheck_device_command_execution(p_id UUID, p_claim_token UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = identity, chat, public, pg_catalog
AS $$
DECLARE
    command_row identity.gugu_device_commands%ROWTYPE;
BEGIN
    SELECT * INTO command_row
    FROM identity.gugu_device_commands c
    WHERE c.id = p_id AND c.claim_token = p_claim_token
      AND c.status = 'running'
    LIMIT 1;
    IF NOT FOUND THEN RETURN false; END IF;
    IF command_row.type <> 'agent.deliver' THEN RETURN true; END IF;
    IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id = command_row.payload->>'agent_user_id' AND u.session_archived_at IS NOT NULL)
       OR EXISTS (SELECT 1 FROM chat.message_agent_delivery_blocks b WHERE b.agent_user_id = command_row.payload->>'agent_user_id' AND b.message_id = command_row.payload->>'message_id') THEN
      RETURN false;
    END IF;
    IF command_row.payload ? 'source' THEN
        IF command_row.payload->>'source' = 'forum' THEN
            PERFORM public.forum_assert_delivery_live(
                command_row.user_id,
                command_row.payload->>'agent_user_id',
                CASE WHEN (command_row.payload->>'post_id') ~* '^[0-9a-f-]{36}$'
                     THEN (command_row.payload->>'post_id')::uuid END
            );
            RETURN true;
        END IF;
        RAISE EXCEPTION 'device command source % is not known', command_row.payload->>'source';
    END IF;
    PERFORM identity.assert_device_command_post_context(
        p_id,
        p_claim_token,
        command_row.payload->>'agent_user_id',
        command_row.payload->>'chat_id',
        NULL,
        NULL
    );
    RETURN true;
END;
$$;


CREATE OR REPLACE FUNCTION identity.assert_device_command_post_context(p_command_id uuid, p_claim_token uuid, p_agent_user_id text, p_chat_id text, p_reply_to_message_id text DEFAULT NULL::text, p_to_user_ids text[] DEFAULT NULL::text[]) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'identity', 'chat', 'public', 'pg_catalog'
    AS $$
DECLARE
    command_chat_kind TEXT;
    command_owner_id UUID;
    command_agent_id TEXT;
    command_chat_id TEXT;
    command_sender_id TEXT;
    command_message_id TEXT;
    reply_sender_id TEXT;
    required_identity_ids TEXT[];
    required_count INTEGER;
    locked_count INTEGER;
    required_member_ids TEXT[];
    locked_member_count INTEGER;
BEGIN
    -- Match lifecycle's chat -> command -> identity lock order.
    SELECT c.kind INTO command_chat_kind
    FROM chat.chats c
    WHERE c.id = p_chat_id
    FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'device command chat is not live'; END IF;

    SELECT c.user_id, c.payload->>'agent_user_id', c.payload->>'chat_id',
           c.payload->>'sender_user_id', c.payload->>'message_id'
    INTO command_owner_id, command_agent_id, command_chat_id, command_sender_id, command_message_id
    FROM identity.gugu_device_commands c
    WHERE c.id = p_command_id
      AND c.claim_token = p_claim_token
      AND c.status = 'running'
      AND c.type = 'agent.deliver'
    FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'device command lease is not live'; END IF;
    IF command_agent_id IS DISTINCT FROM p_agent_user_id
       OR command_chat_id IS DISTINCT FROM p_chat_id THEN
        RAISE EXCEPTION 'device command context does not match message';
    END IF;
    -- 没有发送者只有一种合法来路:这条命令叫醒的是一条服务端写的系统行(#6860 起只剩点名的那种,
    -- 如 #6562 的表情通知)。发送者被注销抹空的消息(#2051)是人话,content_type 不是 system,照旧拒。
    IF command_sender_id IS NULL AND NOT EXISTS (
        SELECT 1
        FROM chat.message_agent_wakes w
        JOIN chat.messages m ON m.id = w.message_id
        WHERE w.message_id = command_message_id
          AND w.agent_user_id = command_agent_id
          AND m.chat_id = p_chat_id
          AND m.content_type = 'system'
          AND m.sender_user_id IS NULL
    ) THEN
        RAISE EXCEPTION 'device command context does not match message';
    END IF;
    IF (SELECT auth.role()) = 'authenticated'
       AND command_owner_id IS DISTINCT FROM (SELECT auth.uid()) THEN
        RAISE EXCEPTION 'device command owner does not match caller';
    ELSIF (SELECT auth.role()) NOT IN ('authenticated', 'service_role') THEN
        RAISE EXCEPTION 'device command post requires an authenticated runtime';
    END IF;
    IF p_reply_to_message_id IS NOT NULL THEN
        SELECT m.sender_user_id INTO reply_sender_id
        FROM chat.messages m
        WHERE m.id = p_reply_to_message_id AND m.chat_id = p_chat_id;
        IF NOT FOUND OR reply_sender_id IS NULL THEN
            RAISE EXCEPTION 'reply target sender is not live';
        END IF;
    END IF;

    SELECT array_agg(DISTINCT identity_id ORDER BY identity_id)
    INTO required_identity_ids
    FROM (
        SELECT command_agent_id AS identity_id
        UNION ALL SELECT command_owner_id::TEXT
        UNION ALL SELECT command_sender_id
        UNION ALL SELECT reply_sender_id WHERE reply_sender_id IS NOT NULL
        UNION ALL
        SELECT recipient_id
        FROM unnest(COALESCE(p_to_user_ids, ARRAY[]::TEXT[])) AS recipient_id
        WHERE recipient_id <> '*'
    ) identities
    WHERE identity_id IS NOT NULL;
    required_count := COALESCE(cardinality(required_identity_ids), 0);
    SELECT count(*) INTO locked_count
    FROM (
        SELECT u.id
        FROM identity.users u
        WHERE u.id = ANY(COALESCE(required_identity_ids, ARRAY[]::TEXT[]))
        ORDER BY u.id
        FOR KEY SHARE
    ) locked;
    IF locked_count <> required_count THEN
        RAISE EXCEPTION 'device command sender or recipient is not live';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM identity.users agent
        WHERE agent.id = command_agent_id
          AND agent.type = 'agent'
          AND agent.owner_user_id = command_owner_id::text
    ) THEN
        RAISE EXCEPTION 'device command target agent is not live';
    END IF;

    IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id = command_agent_id AND u.session_archived_at IS NOT NULL)
       OR EXISTS (SELECT 1 FROM chat.message_agent_delivery_blocks b WHERE b.agent_user_id = command_agent_id AND b.message_id = command_message_id) THEN
      RAISE EXCEPTION 'agent_archived' USING ERRCODE = '55000';
    END IF;

    IF '*' = ANY(COALESCE(p_to_user_ids, ARRAY[]::TEXT[]))
       AND command_chat_kind <> 'group' THEN
        RAISE EXCEPTION 'broadcast recipient is only valid in a group chat';
    END IF;
    SELECT array_agg(DISTINCT member_id ORDER BY member_id)
    INTO required_member_ids
    FROM (
        SELECT command_agent_id AS member_id
        UNION ALL SELECT command_sender_id
        UNION ALL SELECT reply_sender_id WHERE reply_sender_id IS NOT NULL
        UNION ALL
        SELECT recipient_id
        FROM unnest(COALESCE(p_to_user_ids, ARRAY[]::TEXT[])) AS recipient_id
        WHERE recipient_id <> '*'
    ) members
    WHERE member_id IS NOT NULL;
    required_count := COALESCE(cardinality(required_member_ids), 0);
    SELECT count(*) INTO locked_member_count
    FROM (
        SELECT cm.user_id
        FROM chat.chat_members cm
        WHERE cm.chat_id = p_chat_id
          AND cm.user_id = ANY(COALESCE(required_member_ids, ARRAY[]::TEXT[]))
        ORDER BY cm.user_id
        FOR KEY SHARE
    ) locked_members;
    IF locked_member_count <> required_count THEN
        RAISE EXCEPTION 'device command sender, target agent, reply sender or recipient is not a chat member';
    END IF;
    IF (SELECT auth.role()) = 'authenticated'
       AND NOT chat.can_act_as(command_agent_id, p_chat_id) THEN
        RAISE EXCEPTION 'device command owner cannot act as target agent in chat';
    END IF;
    RETURN command_owner_id;
END;
$$;

-- The function-DDL guard closes authenticated execution even on replacement.
-- Restore the existing public API grants explicitly; internal helpers stay closed.
GRANT EXECUTE ON FUNCTION identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION identity.recheck_device_command_execution(uuid,uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.sync_snapshot() TO authenticated;
