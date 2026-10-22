-- 审批通过的任务座位:入群那一行点名这个 agent,把它叫醒(gugu-dev#181「项目群并入项目页」,核对 80b)。
--
-- 在开了「Agent 加入需审批」的群里派任务,任务 agent 先排队、照样干活;它交结果时还不是成员,就先把结果回在
-- 自己的会话里。群主同意后它入座,结果应当发进群 —— 可没有谁去叫它:入群那一行没有发信人、不点名,按 #6860
-- 谁也不叫醒;宿主不订阅成员变化;群主同意时宿主也不一定在线。
--
-- 「同意了」只在这里(chat.decide_group_join)发生,所以由这里说:审批通过的是任务座位时,入群那一行
-- 「X 加入了群聊」的收件人写成这个 agent。点名的消息照现有规则叫醒它(被动档也叫醒),拉取
-- (message_agent_wakes)和推送(agent.deliver)两头都走现成的投递;宿主离线时叫醒记在库里,回来拉收件箱照样拿到。
-- 叫醒以后做什么,写在它第一回合任务卡旁边的提示里(客户端):收到入群通知,就把结果引用任务卡发进群。
--
-- 认「任务座位」用这条请求自己记下的档位:requested_listen_mode = 'passive' 的请求 = 任务座位。
-- 今天只有任务路径(identity.provision_taskpage_agent、chat.add_group_agent 带 p_as_task)会请求 passive,两者等价。
-- 以后要是别的入口也会请求 passive,这里要改。
-- 普通 agent 被批准入群照旧不叫醒(入群不该多出一回合,#6860 的本意);被拒不写入群那一行,也不叫醒谁 ——
-- 结果本来就留在它自己的会话里。
--
-- chat.insert_group_member 加一个参数 p_address_joiner(默认 false),其余入口不传,行为不变。它不对客户端开放,
-- 签名变化只影响库内调用,库内调用都按位置传、少于五个参数,落在默认值上。

DROP FUNCTION chat.insert_group_member(TEXT, TEXT, TEXT, BOOLEAN);
CREATE FUNCTION chat.insert_group_member(
    p_chat_id TEXT, p_user_id TEXT, p_listen_mode TEXT DEFAULT 'active', p_announce BOOLEAN DEFAULT true,
    p_address_joiner BOOLEAN DEFAULT false
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_joined BOOLEAN; v_message_id TEXT;
BEGIN
    -- 已经在群里的不动:他现在的档位是群主或 agent 主人定的;也不再发一行提示。
    INSERT INTO chat.chat_members(chat_id, user_id, role, listen_mode)
    VALUES (p_chat_id, p_user_id, 'member', p_listen_mode)
    ON CONFLICT (chat_id, user_id) DO NOTHING;
    v_joined := FOUND;
    IF chat.is_agent_user(p_user_id) THEN
        INSERT INTO chat.group_agent_states(chat_id,agent_user_id,functional_role,capability_roles,last_action,updated_at)
        VALUES (p_chat_id,p_user_id,'member',ARRAY['member']::TEXT[],'已加入群聊',now())
        ON CONFLICT (chat_id,agent_user_id) DO NOTHING;
    END IF;
    -- #6386 入群灰字:没有发信人,入群者 id 编在 client_message_id(member-joined:<消息 id>:<uid>),客户端据此画可点的 @。
    -- 不点名就不叫醒任何 agent(#6860);p_address_joiner 时收件人是入群者本人,只叫醒它。私聊、话题没有这一行。
    IF v_joined AND p_announce AND EXISTS (SELECT 1 FROM chat.chats WHERE id = p_chat_id AND kind = 'group') THEN
        v_message_id := gen_random_uuid()::text;
        INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, client_message_id, to_user_ids)
        VALUES (
            v_message_id, p_chat_id, NULL,
            COALESCE((SELECT NULLIF(trim(u.display_name), '') FROM identity.users u WHERE u.id = p_user_id), '新成员') || ' 加入了群聊',
            'system',
            'member-joined:' || v_message_id || ':' || p_user_id,
            CASE WHEN p_address_joiner THEN ARRAY[p_user_id] END
        );
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION chat.insert_group_member(TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- 审批通过入群:任务座位(请求要的是 passive)的入群那一行点名它。其余与 20261022105000 相同。
CREATE OR REPLACE FUNCTION chat.decide_group_join(p_request_id TEXT, p_accept BOOLEAN, p_as_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = chat, identity, public, pg_catalog
AS $$
DECLARE
    v_me TEXT := chat.require_group_actor(p_as_user_id);
    v_req chat.group_join_requests%ROWTYPE;
    v_type TEXT;
    v_agent_owner TEXT;
    v_denial TEXT;
BEGIN
    IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT * INTO v_req FROM chat.group_join_requests WHERE id = p_request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Join request not found'; END IF;
    PERFORM 1 FROM chat.chats WHERE id = v_req.chat_id FOR UPDATE;
    PERFORM chat.require_group_manager(v_req.chat_id, v_me);
    SELECT * INTO v_req FROM chat.group_join_requests WHERE id = p_request_id FOR UPDATE;
    IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'Join request already decided'; END IF;

    IF NOT p_accept THEN
        UPDATE chat.group_join_requests SET status = 'rejected', updated_at = now() WHERE id = p_request_id;
        RETURN jsonb_build_object('request_id', p_request_id, 'chat_id', v_req.chat_id, 'status', 'rejected');
    END IF;

    SELECT u.type, u.owner_user_id INTO v_type, v_agent_owner FROM identity.users u WHERE u.id = v_req.requester_user_id;
    IF v_type = 'agent' THEN
        -- 等待期间事实可能变了:发起人退群 / agent 的主人不在群里了 ⇒ 这条请求不再成立。
        IF v_req.requested_by_user_id IS NOT NULL
           AND NOT chat.is_chat_member(v_req.chat_id, v_req.requested_by_user_id)
           AND NOT EXISTS (SELECT 1 FROM identity.users a WHERE a.id = v_req.requested_by_user_id
               AND a.type = 'agent' AND a.owner_user_id = v_agent_owner) THEN
            RAISE EXCEPTION 'join_request_requester_left';
        END IF;
        IF v_agent_owner IS NULL OR NOT chat.is_chat_member(v_req.chat_id, v_agent_owner) THEN
            RAISE EXCEPTION 'join_request_agent_owner_left';
        END IF;
    END IF;

    -- 按审批人身份判:审批人是管理员 ⇒ 邀请开关与 agent 审批放行,剩下上限 / 云 agent / 群状态。
    -- agent 归属:审批人不是 agent 的主人,但这条请求只可能由 queue_agent_join_request 落下
    -- (requested_by_user_id 非空),三个入队口子都已核过主人本人发起或主人已接受邀请 ⇒ 带上主人同意。
    -- requested_by 为空的 agent 请求没有这份同意 ⇒ 照常按归属拒。
    v_denial := chat.group_add_denial(v_req.chat_id, v_req.requester_user_id, v_me, true,
                                      v_type = 'agent' AND v_req.requested_by_user_id IS NOT NULL);
    IF v_denial IS NOT NULL THEN RAISE EXCEPTION '%', v_denial; END IF;

    -- passive 的请求 = 任务座位(见文件头;以后别的入口也请求 passive 时这里要改):入群那一行点名它,叫醒它交结果。
    PERFORM chat.insert_group_member(v_req.chat_id, v_req.requester_user_id, v_req.requested_listen_mode, true,
                                     v_type = 'agent' AND v_req.requested_listen_mode = 'passive');
    UPDATE chat.group_join_requests SET status = 'accepted', updated_at = now() WHERE id = p_request_id;
    RETURN jsonb_build_object('request_id', p_request_id, 'chat_id', v_req.chat_id, 'status', 'accepted');
END;
$$;
REVOKE ALL ON FUNCTION chat.decide_group_join(TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.decide_group_join(TEXT, BOOLEAN, TEXT) TO authenticated;
