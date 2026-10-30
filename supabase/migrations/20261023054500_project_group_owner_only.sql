-- 项目群里只有项目的主人和主人的 agent(gugu-dev#181「项目群并入项目页」:项目群是主人和自己的 agent 交流的地方)。
--
-- 往群里加人的每条路(拉 agent、邀请、接受邀请、申请审批、建群时的初始成员、任务路径)都先问 chat.group_add_denial,
-- 所以规则只加在这一处:目标群被某台设备上报为某个项目的项目群(identity.device_projects.chat_id,20261022155630),
-- 就只放行那个项目的主人本人和 owner_user_id 是他的 agent;别人和别人的 agent 一律 project_group_owner_only。
-- 已经在群里的成员不动。话题跟着来源群(只有来源群的成员能进),不另加。项目被移除、不再上报,这个群就是普通群。

CREATE OR REPLACE FUNCTION chat.group_add_denial(
    p_chat_id TEXT, p_user_id TEXT, p_actor_user_id TEXT,
    p_take_seat BOOLEAN DEFAULT true, p_owner_consented BOOLEAN DEFAULT false
)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_chat chat.chats%ROWTYPE; v_target identity.users%ROWTYPE; v_actor identity.users%ROWTYPE;
    v_role TEXT; v_count INTEGER; v_related BOOLEAN;
BEGIN
    IF p_actor_user_id IS NULL THEN RETURN 'not_authenticated'; END IF;
    SELECT * INTO v_chat FROM chat.chats WHERE id = p_chat_id;
    IF NOT FOUND OR v_chat.kind NOT IN ('group','topic') THEN RETURN 'not_a_group'; END IF;
    IF v_chat.status = 'archived' THEN RETURN 'group_archived'; END IF;
    SELECT * INTO v_target FROM identity.users WHERE id = p_user_id;
    IF NOT FOUND THEN RETURN 'user_not_found'; END IF;
    IF chat.is_cloud_agent_user(p_user_id) THEN RETURN 'cloud_agent'; END IF;
    IF chat.is_chat_member(p_chat_id, p_user_id) THEN RETURN NULL; END IF;
    -- 项目群只有项目的主人和主人的 agent(gugu-dev#181):设备上报的项目记着它绑的群(identity.device_projects.chat_id)。
    -- 这是那条记录本身的事实,❌ 从群名、群人数之类去猜哪个群是项目群。已经在群里的人不动(上一行)。
    IF v_chat.kind = 'group' AND EXISTS (SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id = p_chat_id)
       AND NOT EXISTS (SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id = p_chat_id
                       AND dp.user_id::text IN (p_user_id, v_target.owner_user_id)) THEN
        RETURN 'project_group_owner_only';
    END IF;
    SELECT * INTO v_actor FROM identity.users WHERE id = p_actor_user_id;
    IF NOT FOUND THEN RETURN 'actor_not_member'; END IF;
    SELECT role INTO v_role FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = p_actor_user_id;
    v_related := chat.group_related(p_actor_user_id, p_user_id);
    IF v_role IS NULL THEN
        IF p_user_id = p_actor_user_id AND v_chat.creator_user_id = p_actor_user_id
           AND NOT EXISTS (SELECT 1 FROM chat.chat_members WHERE chat_id = p_chat_id) THEN
            v_role := 'owner'; -- the creator's initial seat
        ELSIF v_actor.type = 'agent' AND v_target.type = 'agent' AND v_related
           AND chat.is_chat_member(p_chat_id, v_actor.owner_user_id) THEN
            v_role := 'member'; -- enrollment consent is not the owner's admin role
        ELSE RETURN 'actor_not_member'; END IF;
    END IF;
    IF v_chat.kind = 'topic' THEN
        IF NOT chat.is_chat_member(v_chat.source_chat_id, p_user_id) THEN RETURN 'not_in_source_line'; END IF;
        RETURN NULL;
    END IF;
    IF v_target.type = 'agent' AND NOT v_related AND NOT COALESCE(p_owner_consented,false) THEN
        RETURN 'agent_not_owned'; END IF;
    IF v_role NOT IN ('owner','admin') THEN
        IF v_target.type = 'agent' AND v_chat.agent_join_approval THEN RETURN 'agent_join_requires_manager';
        ELSIF v_target.type <> 'agent' AND NOT v_related AND NOT v_chat.allow_member_invite THEN
            RETURN 'member_invite_disabled'; END IF;
    END IF;
    IF p_take_seat THEN
        SELECT count(*) INTO v_count FROM chat.chat_members WHERE chat_id = p_chat_id;
        IF v_count >= v_chat.max_members THEN RETURN 'member_limit_reached'; END IF;
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION chat.group_add_denial(TEXT,TEXT,TEXT,BOOLEAN,BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.group_add_denial(TEXT,TEXT,TEXT,BOOLEAN,BOOLEAN) TO service_role;
