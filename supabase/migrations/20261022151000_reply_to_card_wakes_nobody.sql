-- 回复一张卡片,谁也不叫醒(gugu-dev#181 原型 ⑨「需要你」)。
--
-- agent 问主人的问题,作为一张卡片(content_type='card')发进它来自的群;主人在群里作答 = 引用这张卡回复,答案经
-- 会话那边的答问通道(<gugu_question_answer>)送到 agent。这条回复要是再按「回复了 agent 的消息 = 点名它」叫醒 agent,
-- agent 就会从两条路各收到一次同一个答案。
--
-- 规则:回复的是一条卡片消息,这条回复谁也不叫醒。只看 reply_to 指向那条消息的 content_type,不看卡片里写了什么。
-- 任务卡是主人自己发的,回复它本来就不点名任何 agent,所以这条规则对任务卡没有变化。
--
-- ⚠️ 判据的范围比问题卡大:「回复任何一张卡片」都不叫醒。写这条迁移时(10-23)写 card 消息的只有项目页的卡:
-- 宿主贴的任务卡(task-card-first-turn)、会话页请壳贴的任务卡 / 已安排卡(sendCardToChat),以及 agent 的问题卡;
-- agent 的 message_send 工具只发 text,后端函数不写 card。所以现在等价。以后要是新加一种「agent 发出、要人回复它」
-- 的卡片,回复它要叫醒 agent 的话,就得改这里。
--
-- 「谁也不叫醒」原来在拉取(record_message_agent_wakes)和推送(enqueue_agent_deliver_device_command)两个触发器里
-- 各写了一遍内容类型的判断;这里收成一个函数,两边都调它,新规则也只写一处。两个触发器的函数体除了开头这一道判断,
-- 其余逐字照抄上一版(CREATE OR REPLACE 只能整体替换)。

CREATE FUNCTION chat.message_wakes_nobody(p_content_type TEXT, p_reply_to_message_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = '' AS $$
    -- 只有 text / attachment / system 会投递、会叫醒人;任务卡、小组件这些不叫醒任何人。
    SELECT p_content_type NOT IN ('text', 'attachment', 'system')
        -- 回复一张卡片:答案走答问通道,不再按回复叫醒。范围是所有卡片(见文件头的 ⚠️):新加一种要人回复的卡片时改这里。
        OR EXISTS (SELECT 1 FROM chat.messages m WHERE m.id = p_reply_to_message_id AND m.content_type = 'card');
$$;
REVOKE ALL ON FUNCTION chat.message_wakes_nobody(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION chat.record_message_agent_wakes() RETURNS trigger
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

     -- 谁也不叫醒的消息(chat.message_wakes_nobody,与推送那条触发器同一个口径):拉取读的是这里写下的结果。
     IF chat.message_wakes_nobody(NEW.content_type, NEW.reply_to_message_id) THEN
         RETURN NEW;
     END IF;

     v_reply_target := chat.message_reply_routing_target(NEW.reply_to_message_id);
     v_sender_is_agent := EXISTS (
         SELECT 1 FROM identity.users s WHERE s.id = NEW.sender_user_id AND s.type = 'agent'
     );

     INSERT INTO chat.message_agent_wakes (message_id, agent_user_id)
     SELECT NEW.id, cm.user_id
     FROM chat.chats c
     JOIN chat.chat_members cm ON cm.chat_id = c.id
     JOIN identity.users u ON u.id = cm.user_id AND u.type = 'agent'
     WHERE c.id = NEW.chat_id
       AND chat.message_wakes_agent(
             cm.user_id,
             cm.listen_mode,
             cm.notification_level,
             c.kind,
             NEW.sender_user_id,
             v_sender_is_agent,
             NEW.sender_user_id = c.creator_user_id,
             NEW.to_user_ids,
             NEW.is_whisper,
             v_reply_target
           )
     ON CONFLICT (message_id, agent_user_id) DO NOTHING;

     RETURN NEW;
 END;
 $$;
REVOKE ALL ON FUNCTION chat.record_message_agent_wakes() FROM PUBLIC;

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
REVOKE ALL ON FUNCTION chat.enqueue_agent_deliver_device_command() FROM PUBLIC;
