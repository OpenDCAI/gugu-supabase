-- 在对话(普通群)里派的任务,它的 agent 也坐任务座位(gugu-dev#181「任务 agent 进群一律被动」)。
--
-- 项目里派任务走 identity.provision_taskpage_agent,入座是被动档、不出「加入了群聊」(20261022105000)。
-- 在普通群里派任务、agent 带着出生群开出的子会话,入群走的是 chat.add_group_agent —— 它和群成员面板里手动拉
-- agent 是同一个入口,一律主动档、照常提示。这里给它加一个 p_as_task:由调用方说这次入座是不是任务座位。
--   · p_as_task = true:入座被动、不提示;群开了「Agent 加入需审批」时,排队记下要被动,群主同意后照它入座。
--   · 不传(false):和原来一样 —— 手动拉进群的 agent 主动、照常提示。
--   · 已经在群里:座位不动(档位是群主 / agent 主人定的),和任务路径同一条规则。
-- 旧的四参签名去掉:留着它,PostgREST 遇到四个具名参数的调用会认不出该调哪一个。现有客户端按参数名调用、
-- 不传 p_as_task,落到新函数的默认值上,行为不变。

DROP FUNCTION chat.add_group_agent(TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION chat.add_group_agent(
    p_chat_id TEXT,
    p_agent_user_id TEXT,
    p_message TEXT,
    p_as_user_id TEXT,
    p_as_task BOOLEAN DEFAULT false
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_actor TEXT := chat.require_group_actor(p_as_user_id);
    v_listen_mode TEXT := CASE WHEN p_as_task THEN 'passive' ELSE 'active' END;
    v_denial TEXT;
    v_request TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.users WHERE id = p_agent_user_id AND type = 'agent'
                   AND owner_user_id = auth.uid()::text) THEN RAISE EXCEPTION 'agent_not_owned'; END IF;
    PERFORM 1 FROM chat.chats WHERE id = p_chat_id FOR UPDATE;
    v_denial := chat.group_add_denial(p_chat_id, p_agent_user_id, v_actor);
    IF v_denial = 'agent_join_requires_manager' THEN
        v_request := chat.queue_agent_join_request(p_chat_id, p_agent_user_id, v_actor, p_message, v_listen_mode);
        RETURN jsonb_build_object('status', 'pending_approval', 'request_id', v_request, 'chat_id', p_chat_id);
    END IF;
    IF v_denial IS NOT NULL THEN RAISE EXCEPTION '%', v_denial; END IF;
    IF chat.is_chat_member(p_chat_id, p_agent_user_id) THEN
        RETURN jsonb_build_object('status', 'already_member', 'chat_id', p_chat_id);
    END IF;
    PERFORM chat.insert_group_member(p_chat_id, p_agent_user_id, v_listen_mode, NOT p_as_task);
    RETURN jsonb_build_object('status', 'joined', 'chat_id', p_chat_id);
END;
$$;
REVOKE ALL ON FUNCTION chat.add_group_agent(TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.add_group_agent(TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;
