-- invitations are a shared human/agent state machine. Related identities
-- join directly; unrelated identities require the invited human/owner's consent.
SET LOCAL lock_timeout = '5s';

ALTER TABLE chat.group_invitations RENAME COLUMN inviter_agent_user_id TO inviter_user_id;
ALTER TABLE chat.group_invitations RENAME COLUMN inviter_owner_user_id TO inviter_account_user_id;

CREATE FUNCTION chat.group_related(p_actor TEXT, p_target TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT COALESCE(EXISTS (
        SELECT 1 FROM identity.users a JOIN identity.users t ON t.id = p_target WHERE a.id = p_actor
          AND ((t.type = 'agent' AND t.owner_user_id = a.id)
               OR (a.type = 'agent' AND a.owner_user_id = t.id)
               OR (a.type = 'agent' AND t.type = 'agent' AND a.owner_user_id = t.owner_user_id))
    ), false);
$$;
REVOKE ALL ON FUNCTION chat.group_related(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- The sole admission predicate remains shared by creation, invitations, approval
-- and adding one's agents. Group authority is never inferred from an agent owner.
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

CREATE FUNCTION chat.insert_group_member(p_chat_id TEXT, p_user_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES (p_chat_id,p_user_id,'member')
    ON CONFLICT (chat_id,user_id) DO NOTHING;
    IF chat.is_agent_user(p_user_id) THEN
        INSERT INTO chat.group_agent_states(chat_id,agent_user_id,functional_role,capability_roles,last_action,updated_at)
        VALUES (p_chat_id,p_user_id,'member',ARRAY['member']::TEXT[],'已加入群聊',now())
        ON CONFLICT (chat_id,agent_user_id) DO NOTHING;
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION chat.insert_group_member(TEXT,TEXT) FROM PUBLIC, anon, authenticated;

DROP FUNCTION chat.add_group_agent(TEXT,TEXT,TEXT);
CREATE FUNCTION chat.add_group_agent(p_chat_id TEXT,p_agent_user_id TEXT,p_message TEXT,p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id); v_denial TEXT; v_request TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.users WHERE id = p_agent_user_id AND type = 'agent'
                   AND owner_user_id = auth.uid()::text) THEN RAISE EXCEPTION 'agent_not_owned'; END IF;
    PERFORM 1 FROM chat.chats WHERE id = p_chat_id FOR UPDATE;
    v_denial := chat.group_add_denial(p_chat_id,p_agent_user_id,v_actor);
    IF v_denial = 'agent_join_requires_manager' THEN
        v_request := chat.queue_agent_join_request(p_chat_id,p_agent_user_id,v_actor,p_message);
        RETURN jsonb_build_object('status','pending_approval','request_id',v_request,'chat_id',p_chat_id);
    END IF;
    IF v_denial IS NOT NULL THEN RAISE EXCEPTION '%', v_denial; END IF;
    IF chat.is_chat_member(p_chat_id,p_agent_user_id) THEN
        RETURN jsonb_build_object('status','already_member','chat_id',p_chat_id);
    END IF;
    PERFORM chat.insert_group_member(p_chat_id,p_agent_user_id);
    RETURN jsonb_build_object('status','joined','chat_id',p_chat_id);
END;
$$;
REVOKE ALL ON FUNCTION chat.add_group_agent(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.add_group_agent(TEXT,TEXT,TEXT,TEXT) TO authenticated,service_role;

CREATE FUNCTION chat.require_group_inviter(p_chat_id TEXT,p_actor TEXT)
RETURNS chat.chats LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_group chat.chats%ROWTYPE;
BEGIN
    SELECT * INTO v_group FROM chat.chats WHERE id = p_chat_id FOR UPDATE;
    IF NOT FOUND OR v_group.kind <> 'group' OR v_group.status <> 'active' THEN RAISE EXCEPTION 'group_not_active'; END IF;
    IF NOT chat.is_chat_member(p_chat_id,p_actor) THEN RAISE EXCEPTION 'actor_not_member' USING ERRCODE = '42501'; END IF;
    IF NOT v_group.allow_member_invite AND NOT chat.group_is_manager(p_chat_id,p_actor) THEN
        RAISE EXCEPTION 'member_invite_disabled' USING ERRCODE = '42501'; END IF;
    RETURN v_group;
END;
$$;
REVOKE ALL ON FUNCTION chat.require_group_inviter(TEXT,TEXT) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION chat.request_group_invitation_as(p_chat_id TEXT,p_invitee_user_id TEXT,p_message TEXT,p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id); v_group chat.chats%ROWTYPE;
    v_target identity.users%ROWTYPE; v_decider TEXT; v_invitation TEXT; v_denial TEXT;
BEGIN
    IF NULLIF(btrim(p_message),'') IS NULL THEN RAISE EXCEPTION 'invitation_message_required'; END IF;
    SELECT * INTO v_target FROM identity.users WHERE id = p_invitee_user_id;
    IF NOT FOUND OR (v_target.type = 'agent' AND v_target.owner_user_id <> auth.uid()::text
                     AND NOT COALESCE(v_target.agent_public,false)) THEN RAISE EXCEPTION 'invitee_not_visible'; END IF;
    IF chat.is_cloud_agent_user(v_target.id) THEN RAISE EXCEPTION 'cloud_agent'; END IF;
    -- Direct related membership uses the very same add-agent door as the picker.
    IF v_target.type = 'agent' AND chat.group_related(v_actor,v_target.id) THEN
        RETURN chat.add_group_agent(p_chat_id,v_target.id,p_message,v_actor);
    END IF;
    IF chat.group_related(v_actor,v_target.id) THEN
        PERFORM 1 FROM chat.chats WHERE id = p_chat_id FOR UPDATE;
        v_denial := chat.group_add_denial(p_chat_id,v_target.id,v_actor);
        IF v_denial IS NOT NULL THEN RAISE EXCEPTION '%',v_denial; END IF;
        IF chat.is_chat_member(p_chat_id,v_target.id) THEN
            RETURN jsonb_build_object('status','already_member','chat_id',p_chat_id,'invitee_user_id',v_target.id);
        END IF;
        PERFORM chat.insert_group_member(p_chat_id,v_target.id);
        RETURN jsonb_build_object('status','joined','chat_id',p_chat_id,'invitee_user_id',v_target.id);
    END IF;
    v_group := chat.require_group_inviter(p_chat_id,v_actor);
    IF chat.is_chat_member(p_chat_id,v_target.id) THEN
        RETURN jsonb_build_object('status','already_member','chat_id',p_chat_id,'invitee_user_id',v_target.id); END IF;
    v_decider := CASE WHEN v_target.type = 'agent' THEN v_target.owner_user_id ELSE v_target.id END;
    IF v_decider IS NULL THEN RAISE EXCEPTION 'invitee_has_no_decider'; END IF;
    SELECT id INTO v_invitation FROM chat.group_invitations
    WHERE chat_id = p_chat_id AND invitee_user_id = v_target.id AND status = 'pending';
    IF v_invitation IS NULL THEN
        INSERT INTO chat.group_invitations(chat_id,inviter_user_id,inviter_account_user_id,invitee_user_id,decision_user_id,message)
        VALUES (p_chat_id,v_actor,auth.uid()::text,v_target.id,v_decider,btrim(p_message)) RETURNING id INTO v_invitation;
    END IF;
    RETURN jsonb_build_object('status','pending','invitation_id',v_invitation,'chat_id',p_chat_id,
                             'invitee_user_id',v_target.id,'decision_user_id',v_decider);
END;
$$;
REVOKE ALL ON FUNCTION chat.request_group_invitation_as(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.request_group_invitation_as(TEXT,TEXT,TEXT,TEXT) TO authenticated;

CREATE FUNCTION chat.decide_group_invitation_as(p_invitation_id TEXT,p_accept BOOLEAN,p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id); v_inv chat.group_invitations%ROWTYPE;
    v_group chat.chats%ROWTYPE; v_target identity.users%ROWTYPE; v_members TEXT[]; v_count INTEGER;
    v_queue BOOLEAN; v_request TEXT; v_denial TEXT;
BEGIN
    IF p_accept IS NULL OR NOT EXISTS (SELECT 1 FROM identity.users WHERE id=v_actor AND type='human') THEN
        RAISE EXCEPTION 'invited_human_or_owner_required' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_inv FROM chat.group_invitations WHERE id=p_invitation_id AND decision_user_id=v_actor;
    IF NOT FOUND THEN RAISE EXCEPTION 'invitation_not_addressed_to_actor' USING ERRCODE = '42501'; END IF;
    PERFORM 1 FROM chat.chats WHERE id=v_inv.chat_id FOR UPDATE;
    SELECT * INTO v_inv FROM chat.group_invitations WHERE id=p_invitation_id FOR UPDATE;
    IF v_inv.status <> 'pending' THEN
        IF v_inv.status <> (CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END) THEN RAISE EXCEPTION 'invitation_already_decided'; END IF;
        RETURN jsonb_build_object('status',v_inv.status,'invitation_id',v_inv.id,'chat_id',v_inv.chat_id);
    END IF;
    IF NOT p_accept THEN
        UPDATE chat.group_invitations SET status='rejected',updated_at=now() WHERE id=v_inv.id;
        RETURN jsonb_build_object('status','rejected','invitation_id',v_inv.id,'chat_id',v_inv.chat_id);
    END IF;
    v_group := chat.require_group_inviter(v_inv.chat_id,v_inv.inviter_user_id);
    SELECT * INTO v_target FROM identity.users WHERE id=v_inv.invitee_user_id FOR SHARE;
    IF NOT FOUND OR (v_target.type='agent' AND v_target.owner_user_id IS DISTINCT FROM v_actor)
        OR (v_target.type='human' AND v_target.id<>v_actor) THEN RAISE EXCEPTION 'invited_human_or_owner_required'; END IF;
    v_denial := chat.group_add_denial(v_group.id,v_target.id,v_inv.inviter_user_id,false,true);
    v_queue := v_denial = 'agent_join_requires_manager';
    IF v_denial IS NOT NULL AND NOT v_queue THEN RAISE EXCEPTION '%',v_denial; END IF;
    v_queue := COALESCE(v_queue,false);
    v_members := CASE WHEN v_target.type='agent' AND NOT v_queue THEN ARRAY[v_actor,v_target.id] ELSE ARRAY[v_actor] END;
    SELECT count(*) INTO v_count FROM chat.chat_members WHERE chat_id=v_group.id;
    IF v_count+(SELECT count(*) FROM unnest(v_members) m(id) WHERE NOT chat.is_chat_member(v_group.id,m.id))>v_group.max_members THEN
        RAISE EXCEPTION 'member_limit_reached'; END IF;
    PERFORM chat.insert_group_member(v_group.id, m.id) FROM unnest(v_members) m(id);
    UPDATE chat.group_invitations SET status='accepted',updated_at=now() WHERE id=v_inv.id;
    IF v_inv.kind='friend_contact' AND NOT v_queue THEN
        INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,to_user_ids,client_message_id)
        VALUES (gen_random_uuid()::text,v_group.id,v_inv.inviter_user_id,v_inv.message,'text',ARRAY[v_target.id],'invitation-note:'||v_inv.id)
        ON CONFLICT (chat_id,client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING;
    END IF;
    IF v_queue THEN
        v_request:=chat.queue_agent_join_request(v_group.id,v_target.id,v_inv.inviter_user_id,v_inv.message);
        RETURN jsonb_build_object('status','pending_approval','invitation_id',v_inv.id,'chat_id',v_group.id,'request_id',v_request);
    END IF;
    RETURN jsonb_build_object('status','accepted','invitation_id',v_inv.id,'chat_id',v_group.id);
END;
$$;
REVOKE ALL ON FUNCTION chat.decide_group_invitation_as(TEXT,BOOLEAN,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.decide_group_invitation_as(TEXT,BOOLEAN,TEXT) TO authenticated;

CREATE FUNCTION chat.list_group_invitations_as(p_as_user_id TEXT,p_sent BOOLEAN,p_include_decided BOOLEAN)
RETURNS TABLE(id TEXT,chat_id TEXT,group_name TEXT,inviter_user_id TEXT,inviter_type TEXT,inviter_name TEXT,
    inviter_owner_name TEXT,invitee_user_id TEXT,invitee_name TEXT,invitee_type TEXT,decision_user_id TEXT,
    owner_will_join BOOLEAN,message TEXT,status TEXT,created_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id);
BEGIN
    RETURN QUERY SELECT i.id,i.chat_id,c.name,i.inviter_user_id,sender.type,sender.display_name,account.display_name,
        i.invitee_user_id,target.display_name,target.type,i.decision_user_id,
        target.type='agent' AND NOT chat.is_chat_member(i.chat_id,i.decision_user_id), i.message,i.status,i.created_at
    FROM chat.group_invitations i JOIN chat.chats c ON c.id=i.chat_id
    JOIN identity.users sender ON sender.id=i.inviter_user_id
    JOIN identity.users account ON account.id=i.inviter_account_user_id JOIN identity.users target ON target.id=i.invitee_user_id
    WHERE CASE WHEN p_sent THEN i.inviter_user_id=v_actor ELSE i.decision_user_id=v_actor END
      AND (p_include_decided OR i.status='pending')
    ORDER BY (i.status='pending') DESC,i.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION chat.list_group_invitations_as(TEXT,BOOLEAN,BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_group_invitations_as(TEXT,BOOLEAN,BOOLEAN) TO authenticated;


CREATE OR REPLACE FUNCTION chat.request_agent_friend_contact(p_agent_user_id TEXT, p_friend_user_id TEXT, p_message TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = chat, identity, public, pg_catalog AS $$
DECLARE
    v_me TEXT := auth.uid()::text;
    v_agent_name TEXT;
    v_friend_name TEXT;
    v_chat_id TEXT;
    v_name TEXT;
    v_result JSONB;
    v_status TEXT;
    v_invitation_id TEXT;
    v_created BOOLEAN := false;
BEGIN
    IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT display_name INTO v_agent_name FROM identity.users WHERE id = p_agent_user_id AND type = 'agent' AND owner_user_id = v_me;
    IF NOT FOUND THEN RAISE EXCEPTION 'Agent is not owned by this account'; END IF;
    SELECT display_name INTO v_friend_name FROM identity.users WHERE id = p_friend_user_id AND type = 'human';
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM identity.friendships
        WHERE user_a_id = LEAST(v_me, p_friend_user_id) AND user_b_id = GREATEST(v_me, p_friend_user_id)) THEN
        RAISE EXCEPTION 'Selected person is not an owner friend';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-friend-invitation:' || p_agent_user_id || ':' || p_friend_user_id, 0));
    SELECT c.id, c.name INTO v_chat_id, v_name FROM chat.chats c
    WHERE c.kind = 'group' AND c.status = 'active'
      AND (SELECT count(*) FROM chat.chat_members m WHERE m.chat_id = c.id) = 3
      AND NOT EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = c.id AND m.user_id <> ALL(ARRAY[v_me, p_agent_user_id, p_friend_user_id]))
      AND EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = c.id AND m.user_id = v_me AND m.role = 'owner')
    ORDER BY c.created_at LIMIT 1;
    IF v_chat_id IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'already_member', 'chat_id', v_chat_id, 'name', v_name, 'created', false);
    END IF;
    SELECT i.chat_id, c.name, i.status, i.id INTO v_chat_id, v_name, v_status, v_invitation_id FROM chat.group_invitations i JOIN chat.chats c ON c.id = i.chat_id
    WHERE i.inviter_user_id = p_agent_user_id AND i.invitee_user_id = p_friend_user_id
      AND c.status = 'active'
      AND (SELECT count(*) FROM chat.chat_members m WHERE m.chat_id = c.id) = 2
      AND NOT EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = c.id AND m.user_id <> ALL(ARRAY[v_me, p_agent_user_id]))
      AND EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = c.id AND m.user_id = v_me AND m.role = 'owner')
    ORDER BY i.created_at DESC LIMIT 1;
    IF v_status = 'rejected' THEN
        RETURN jsonb_build_object('status', 'rejected', 'chat_id', v_chat_id, 'name', v_name, 'invitation_id', v_invitation_id, 'created', false, 'message_id', NULL);
    END IF;
    IF v_chat_id IS NULL THEN
        v_created := true;
        v_chat_id := gen_random_uuid()::text;
        v_name := v_agent_name || '、' || v_friend_name;
        SET CONSTRAINTS ALL DEFERRED;
        -- A new contact-sharing group must let its member Agent send the invitation.
        INSERT INTO chat.chats(id, kind, name, creator_user_id, allow_member_invite)
        VALUES (v_chat_id, 'group', v_name, v_me, true);
        INSERT INTO chat.chat_members(chat_id, user_id, role) VALUES (v_chat_id, v_me, 'owner'), (v_chat_id, p_agent_user_id, 'member');
        INSERT INTO chat.group_agent_states(chat_id, agent_user_id, functional_role, capability_roles, last_action, updated_at)
        VALUES (v_chat_id, p_agent_user_id, 'member', ARRAY['member']::TEXT[], '已加入群聊', now());
    END IF;
    v_result := chat.request_group_invitation_as(v_chat_id, p_friend_user_id, p_message, p_agent_user_id);
    -- 这张邀请的附言在好友接受时要落成 agent 的第一条群消息(见 decide_group_invitation_as)。
    IF v_result ->> 'status' = 'pending' THEN
        UPDATE chat.group_invitations SET kind = 'friend_contact' WHERE id = v_result ->> 'invitation_id';
    END IF;
    RETURN v_result || jsonb_build_object('name', v_name, 'created', v_created, 'message_id', NULL);
END;
$$;
REVOKE ALL ON FUNCTION chat.request_agent_friend_contact(TEXT,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.request_agent_friend_contact(TEXT,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION chat.publish_group_invitation_revision()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = chat, identity, public, pg_catalog AS $$
DECLARE v_row chat.group_invitations%ROWTYPE := COALESCE(NEW, OLD); v_user TEXT;
BEGIN
    FOR v_user IN SELECT DISTINCT id FROM unnest(ARRAY[v_row.decision_user_id, v_row.inviter_account_user_id]) AS recipient(id) ORDER BY id LOOP
        PERFORM chat.publish_user_revision(v_user, 'group_invitations_changed', jsonb_build_object('invitation_id', v_row.id), TG_OP = 'DELETE');
    END LOOP;
    RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION chat.publish_group_invitation_revision() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION chat.list_my_agent_join_requests(p_chat_id TEXT)
RETURNS TABLE(id TEXT, agent_user_id TEXT, agent_name TEXT, status TEXT, updated_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT r.id, r.requester_user_id, u.display_name, r.status, r.updated_at
      FROM chat.group_join_requests r
      JOIN identity.users u ON u.id = r.requester_user_id
     WHERE r.chat_id = p_chat_id
       AND u.type = 'agent' AND u.owner_user_id = (SELECT auth.uid()::text)
     ORDER BY r.updated_at DESC;
$$;
REVOKE ALL ON FUNCTION chat.list_my_agent_join_requests(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_my_agent_join_requests(TEXT) TO authenticated;

DROP FUNCTION chat.request_agent_group_invitation(TEXT,TEXT,TEXT,TEXT);
DROP FUNCTION chat.decide_agent_group_invitation(TEXT,BOOLEAN);
DROP FUNCTION chat.list_agent_group_invitations(TEXT,BOOLEAN);
DROP FUNCTION chat.require_agent_group_inviter(TEXT,TEXT,TEXT);
DROP FUNCTION chat.can_add_group_member(TEXT,TEXT,TEXT);
CREATE OR REPLACE FUNCTION chat.create_gugu_group(p_chat_id text, p_name text, p_owner_user_id text, p_initial_members jsonb, p_default_agent_type text DEFAULT NULL::text, p_group_prompt text DEFAULT NULL::text)
 RETURNS chat.chats
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'identity', 'public', 'pg_catalog'
AS $function$
DECLARE
    caller_user_id TEXT;
    inserted       chat.chats;
    m              JSONB;
    member_user_id TEXT;
    member_role    TEXT;
    inserted_member_count INT := 0;
    inserted_member_rows  INT := 0;
    member_denial  TEXT;
BEGIN
    caller_user_id := (SELECT auth.uid()::text);
    IF caller_user_id IS NULL OR caller_user_id <> p_owner_user_id THEN
        RAISE EXCEPTION 'caller % cannot create group on behalf of %',
                        caller_user_id, p_owner_user_id;
    END IF;

    IF p_initial_members IS NULL OR jsonb_typeof(p_initial_members) <> 'array' THEN
        RAISE EXCEPTION 'p_initial_members must be a jsonb array';
    END IF;

    SET CONSTRAINTS ALL DEFERRED;

    INSERT INTO chat.chats (
        id, kind, name, status, creator_user_id,
        group_prompt, default_agent_type
    ) VALUES (
        p_chat_id, 'group', p_name, 'active', p_owner_user_id,
        p_group_prompt, p_default_agent_type
    ) RETURNING * INTO inserted;

    INSERT INTO chat.chat_members (chat_id, user_id, role)
    VALUES (p_chat_id, p_owner_user_id, 'owner');

    FOR m IN SELECT * FROM jsonb_array_elements(p_initial_members) LOOP
        member_user_id := m ->> 'user_id';
        member_role    := COALESCE(m ->> 'role', 'member');
        IF member_user_id IS NULL OR member_user_id = p_owner_user_id THEN
            CONTINUE;
        END IF;
        -- #1761 云 agent 禁入群（fail-loud，不静默跳过）
        IF chat.is_cloud_agent_user(member_user_id) THEN
            RAISE EXCEPTION 'cloud agent % cannot join groups (#1761)', member_user_id;
        END IF;
        -- 群只有一个 owner(= 创建者);初始成员只能是 member/admin。
        IF member_role NOT IN ('member', 'admin') THEN
            RAISE EXCEPTION 'initial member % cannot have role %', member_user_id, member_role;
        END IF;
        -- 与其余入口同一道「能否加此人」(调用者就是 owner:拦的是上限、身份存在、别人名下的 agent ——
        -- 别人的 agent 要走 agent 群邀请,由它的主人接受)。
        IF NOT chat.group_related(p_owner_user_id, member_user_id) THEN
            RAISE EXCEPTION 'initial_member_requires_invitation';
        END IF;
        member_denial := chat.group_add_denial(p_chat_id, member_user_id, p_owner_user_id);
        IF member_denial IS NOT NULL THEN
            RAISE EXCEPTION 'cannot add % to group %: %', member_user_id, p_chat_id, member_denial;
        END IF;
        INSERT INTO chat.chat_members (chat_id, user_id, role)
        VALUES (p_chat_id, member_user_id, member_role)
        ON CONFLICT (chat_id, user_id) DO NOTHING;
        GET DIAGNOSTICS inserted_member_rows = ROW_COUNT;
        inserted_member_count := inserted_member_count + inserted_member_rows;
    END LOOP;


    RETURN inserted;
END;
$function$;
REVOKE ALL ON FUNCTION chat.create_gugu_group(TEXT,TEXT,TEXT,JSONB,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.create_gugu_group(TEXT,TEXT,TEXT,JSONB,TEXT,TEXT) TO authenticated;
CREATE OR REPLACE FUNCTION identity.remove_owned_agent(p_agent_user_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'identity', 'chat', 'realtime', 'public', 'pg_catalog'
AS $$
DECLARE
    v_me TEXT := auth.uid()::text;
    v_agent identity.users%ROWTYPE;
    v_owned_agent_group_ids TEXT[];
    v_archive_chat_ids TEXT[];
    v_touched_chat_ids TEXT[];
    v_presence_viewer_ids TEXT[];
    v_contact_viewer_ids TEXT[];
    v_removed_payload JSONB;
    v_chat_id TEXT;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF NULLIF(p_agent_user_id, '') IS NULL THEN
        RAISE EXCEPTION 'Agent is required';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM identity.agent_lifecycle_tombstones t
        WHERE t.agent_user_id = p_agent_user_id
          AND t.owner_user_id = v_me
    ) THEN
        RETURN;
    END IF;

    SELECT *
      INTO v_agent
      FROM identity.users
     WHERE id = p_agent_user_id
       AND type = 'agent'
       AND owner_user_id = v_me
     FOR UPDATE;

    IF NOT FOUND THEN
        IF EXISTS (
            SELECT 1
            FROM identity.agent_lifecycle_tombstones t
            WHERE t.agent_user_id = p_agent_user_id
              AND t.owner_user_id = v_me
        ) THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'Agent is not owned by current user';
    END IF;

    SELECT coalesce(array_agg(DISTINCT viewer_id), ARRAY[]::TEXT[])
      INTO v_contact_viewer_ids
      FROM (
          SELECT v_me AS viewer_id
          UNION
          SELECT CASE WHEN f.user_a_id = v_agent.id THEN f.user_b_id ELSE f.user_a_id END
          FROM identity.friendships f
          WHERE f.user_a_id = v_agent.id OR f.user_b_id = v_agent.id
      ) viewers;

    SELECT coalesce(array_agg(DISTINCT viewer_id), ARRAY[]::TEXT[])
      INTO v_presence_viewer_ids
      FROM (
          SELECT unnest(v_contact_viewer_ids) AS viewer_id
          UNION
          SELECT cm_self.user_id
          FROM chat.chat_members cm_agent
          JOIN chat.chat_members cm_self ON cm_self.chat_id = cm_agent.chat_id
          WHERE cm_agent.user_id = v_agent.id
            AND cm_self.user_id <> v_agent.id
      ) viewers;

    INSERT INTO identity.agent_lifecycle_tombstones (
        agent_user_id,
        owner_user_id,
        display_name,
        avatar,
        bio,
        gugu_number,
        agent_public,
        desired_status,
        device_id,
        local_path,
        agent_created_at,
        removed_at,
        presence_viewer_user_ids,
        contact_viewer_user_ids
    ) VALUES (
        v_agent.id,
        v_me,
        v_agent.display_name,
        v_agent.avatar,
        v_agent.bio,
        v_agent.gugu_number,
        false,
        'offline',
        v_agent.device_id,
        v_agent.local_path,
        v_agent.created_at,
        now(),
        v_presence_viewer_ids,
        v_contact_viewer_ids
    );

    SELECT coalesce(array_agg(DISTINCT c.id), ARRAY[]::TEXT[])
      INTO v_owned_agent_group_ids
      FROM chat.chats c
     WHERE c.kind = 'group'
       AND c.creator_user_id = v_agent.id;

    SELECT coalesce(array_agg(DISTINCT c.id), ARRAY[]::TEXT[])
      INTO v_archive_chat_ids
      FROM chat.chats c
     WHERE c.kind IN ('dm', 'ai')
       AND EXISTS (
           SELECT 1
             FROM chat.chat_members cm
            WHERE cm.chat_id = c.id
              AND cm.user_id = v_agent.id
       );

    v_archive_chat_ids := (
        SELECT coalesce(array_agg(DISTINCT id), ARRAY[]::TEXT[])
          FROM unnest(v_archive_chat_ids || v_owned_agent_group_ids) AS ids(id)
    );

    SELECT coalesce(array_agg(DISTINCT c.id), ARRAY[]::TEXT[])
      INTO v_touched_chat_ids
      FROM chat.chats c
     WHERE c.id = ANY(v_archive_chat_ids)
        OR EXISTS (
            SELECT 1
              FROM chat.chat_members cm
             WHERE cm.chat_id = c.id
               AND cm.user_id = v_agent.id
        );

    UPDATE chat.chats c
       SET status = 'archived', updated_at = now()
     WHERE c.status <> 'archived'
       AND c.id = ANY(v_archive_chat_ids);

    -- @@@5919 消息只随它的专属会话(上面刚归档的单聊 / ai 会话 / 它自己建的群)一起删;
    -- 投递行与表态随消息级联。共享会话里的消息一条不删 —— @ 它、发给它的是别人写的字,
    -- 它自己说过的话是别人对话的上下文(删了还会把别人回复它的 reply_to 一并置空)。
    -- 与 identity.erase_human_account 同一套:消息留着,只擦对这个身份的引用。
    DELETE FROM chat.messages m
    WHERE m.chat_id = ANY(v_archive_chat_ids);

    -- 它自己那一份投递行(agent 的投递键是 'gugu-agent:<id>')与它自己按的表态。
    DELETE FROM chat.message_deliveries d
    WHERE d.device_id = 'gugu-agent:' || v_agent.id;
    DELETE FROM chat.message_reactions r
    WHERE r.user_id = v_agent.id;

    -- @@@6400 名单擦空 = 定向消息变「没点名」,会被 active agent 的下一次拉取捡走;只剩它时保留它的 id。
    UPDATE chat.messages m
    SET to_user_ids = ARRAY(
            SELECT recipient_id FROM unnest(m.to_user_ids) AS recipient_id
            WHERE recipient_id <> v_agent.id
        )
    WHERE v_agent.id = ANY(m.to_user_ids)
      AND EXISTS (
          SELECT 1 FROM unnest(m.to_user_ids) AS other(recipient_id)
          WHERE other.recipient_id <> v_agent.id
      );
    UPDATE chat.messages m
    SET deleted_for_user_ids = m.deleted_for_user_ids - v_agent.id
    WHERE m.deleted_for_user_ids ? v_agent.id;

    DELETE FROM chat.gugu_decision_events
    WHERE chat_id = ANY(v_owned_agent_group_ids)
       OR created_by_user_id = v_agent.id;
    DELETE FROM chat.group_scheduler_states WHERE chat_id = ANY(v_owned_agent_group_ids);
    DELETE FROM chat.group_tasks WHERE chat_id = ANY(v_owned_agent_group_ids);
    DELETE FROM chat.group_outputs WHERE chat_id = ANY(v_owned_agent_group_ids);
    DELETE FROM chat.group_agent_states WHERE chat_id = ANY(v_owned_agent_group_ids);
    DELETE FROM chat.group_agent_states WHERE agent_user_id = v_agent.id;

    UPDATE chat.group_tasks
       SET owner_agent_user_id = NULL,
           reviewer_agent_user_id = NULL,
           updated_at = now()
     WHERE owner_agent_user_id = v_agent.id
        OR reviewer_agent_user_id = v_agent.id;
    UPDATE chat.group_outputs
       SET produced_by_user_id = NULL
     WHERE produced_by_user_id = v_agent.id;
    DELETE FROM chat.chat_members WHERE chat_id = ANY(v_owned_agent_group_ids);

    -- A surviving human owner keeps the group active; agent removal is not group dissolution.
    DELETE FROM chat.chat_members WHERE user_id = v_agent.id;

    FOREACH v_chat_id IN ARRAY v_touched_chat_ids LOOP
        PERFORM chat.recompute_chat_last_message(v_chat_id);
    END LOOP;

    DELETE FROM identity.friendships
    WHERE user_a_id = v_agent.id OR user_b_id = v_agent.id;
    DELETE FROM identity.friend_requests
    WHERE sender_id = v_agent.id OR receiver_id = v_agent.id;
    DELETE FROM identity.contact_overrides
    WHERE owner_user_id = v_agent.id OR contact_user_id = v_agent.id;
    DELETE FROM identity.contact_group_members cgm
    USING identity.contact_groups cg
    WHERE cgm.group_id = cg.id
      AND (cgm.contact_user_id = v_agent.id OR cg.owner_user_id = v_agent.id);
    DELETE FROM identity.agent_runtime_states WHERE agent_user_id = v_agent.id;
    DELETE FROM identity.gugu_device_commands WHERE payload->>'agent_user_id' = v_agent.id;
    DELETE FROM identity.agent_profiles
    WHERE id::text = v_agent.id AND owner_id::text = v_me;
    DELETE FROM identity.users
    WHERE id = v_agent.id AND type = 'agent' AND owner_user_id = v_me;

    v_removed_payload := identity.build_agent_presence_payload(v_agent.id);
    IF v_removed_payload IS NULL THEN
        RAISE EXCEPTION 'Removed agent lifecycle payload is missing';
    END IF;

    PERFORM identity.fan_agent_presence_to_viewers(v_agent.id, v_removed_payload);
END;
$$;
REVOKE ALL ON FUNCTION identity.remove_owned_agent(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.remove_owned_agent(TEXT) TO authenticated;
CREATE OR REPLACE FUNCTION chat.list_owner_groups_as(p_as_user_id TEXT)
RETURNS TABLE(
    chat_id TEXT,
    public_id INTEGER,
    name TEXT,
    member_count INTEGER,
    joined BOOLEAN,
    agent_join_needs_approval BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_owner TEXT := (SELECT auth.uid()::text);
    v_actor TEXT := NULLIF(btrim(COALESCE(p_as_user_id, '')), '');
BEGIN
    IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    -- 提问资格走统一的 chat.is_acting_as:本人,或自己名下的 agent。替本人问时 joined 恒为 true。
    IF v_actor IS NULL OR NOT chat.is_acting_as(v_actor) THEN
        RAISE EXCEPTION 'Not allowed to act as %', COALESCE(v_actor, '<null>');
    END IF;

    RETURN QUERY
    SELECT c.id,
           c.public_id,
           c.name,
           (SELECT count(*)::INTEGER FROM chat.chat_members cm WHERE cm.chat_id = c.id),
           EXISTS (SELECT 1 FROM chat.chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = v_actor),
           COALESCE(chat.group_add_denial(c.id,v_actor,v_actor,false) = 'agent_join_requires_manager',false)
      FROM chat.chat_members mine
      JOIN chat.chats c ON c.id = mine.chat_id
     WHERE mine.user_id = v_owner
       AND c.kind = 'group'
       AND c.status = 'active'
     ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC;
END;
$function$;

COMMENT ON FUNCTION chat.list_owner_groups_as(TEXT) IS
    '#6492 主人所在的活跃群(不含话题,不含 stopped / paused / archived),替本人或名下 agent p_as_user_id 列:只给入群要用的元数据,❌ 不给预览或正文。第 3 件起本人也能问(App 的 groups.list)。';
-- event trigger 对 CREATE OR REPLACE 收回授权;照原样重申(与 20260925141000 相同)。
REVOKE ALL ON FUNCTION chat.list_owner_groups_as(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_owner_groups_as(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
