-- human and agent group administration share one actor-aware write door.
-- Ownership authenticates the actor; the actor's seat determines group authority.
-- Clients lose the corresponding table writes in this same transaction.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION chat.require_group_actor(p_as_user_id TEXT)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF auth.uid() IS NULL OR NULLIF(btrim(p_as_user_id), '') IS NULL
       OR chat.is_acting_as(p_as_user_id) IS NOT TRUE THEN
        RAISE EXCEPTION 'group_actor_not_authorized' USING ERRCODE = '42501';
    END IF;
    RETURN p_as_user_id;
END;
$$;
REVOKE ALL ON FUNCTION chat.require_group_actor(TEXT) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION chat.group_is_manager(p_chat_id TEXT, p_actor TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
        SELECT 1 FROM chat.chats c JOIN chat.chat_members m ON m.chat_id = c.id
        WHERE c.id = p_chat_id AND c.kind IN ('group', 'topic') AND c.status <> 'archived'
          AND m.user_id = p_actor AND m.role IN ('owner', 'admin')
    );
$$;
REVOKE ALL ON FUNCTION chat.group_is_manager(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- Remaining internal callers use the same role predicate. This is not a second
-- mutation door: the public client writes formerly using this policy are revoked.
CREATE OR REPLACE FUNCTION chat.can_manage_group_members(p_chat_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT chat.group_is_manager(p_chat_id, (SELECT auth.uid()::text));
$$;
REVOKE ALL ON FUNCTION chat.can_manage_group_members(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.can_manage_group_members(TEXT) TO authenticated;

CREATE FUNCTION chat.require_group_manager(p_chat_id TEXT, p_as_user_id TEXT)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id);
BEGIN
    IF NOT chat.group_is_manager(p_chat_id, v_actor) THEN
        RAISE EXCEPTION 'group_manager_required' USING ERRCODE = '42501';
    END IF;
    RETURN v_actor;
END;
$$;
REVOKE ALL ON FUNCTION chat.require_group_manager(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION chat.group_info_as(p_chat_id TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id); v_group chat.chats%ROWTYPE; v_role TEXT;
BEGIN
    SELECT * INTO v_group FROM chat.chats WHERE id = p_chat_id AND kind IN ('group', 'topic');
    IF NOT FOUND OR NOT (
        chat.is_chat_member(p_chat_id, v_actor) OR chat.is_chat_member(p_chat_id, auth.uid()::text)
        OR (v_group.kind = 'topic' AND (chat.is_chat_member(v_group.source_chat_id, v_actor)
            OR chat.is_chat_member(v_group.source_chat_id, auth.uid()::text)))
    ) THEN RAISE EXCEPTION 'group_not_visible' USING ERRCODE = '42501'; END IF;
    SELECT role INTO v_role FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = v_actor;
    RETURN jsonb_build_object(
        'id', v_group.id, 'public_id', v_group.public_id, 'creator_user_id', v_group.creator_user_id,
        'name', v_group.name, 'status', v_group.status, 'group_prompt', v_group.group_prompt,
        'default_agent_type', v_group.default_agent_type, 'join_token', v_group.join_token,
        'description', v_group.description, 'max_members', v_group.max_members,
        'allow_member_invite', v_group.allow_member_invite, 'invite_link_enabled', v_group.invite_link_enabled,
        'agent_join_approval', v_group.agent_join_approval, 'join_mode', v_group.join_mode,
        'hide_history', v_group.hide_history, 'avatar_url', v_group.avatar_url,
        'is_discoverable', v_group.is_discoverable, 'agent_flood_threshold', v_group.agent_flood_threshold,
        'agent_flood_threshold_effective', chat.agent_flood_threshold_for(p_chat_id),
        'my_role', v_role, 'can_manage', chat.group_is_manager(p_chat_id, v_actor),
        'can_dissolve', v_group.kind = 'group' AND v_role = 'owner'
    );
END;
$$;
REVOKE ALL ON FUNCTION chat.group_info_as(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.group_info_as(TEXT, TEXT) TO authenticated;

CREATE FUNCTION chat.announce_group_management(p_chat_id TEXT, p_actor TEXT, p_target TEXT, p_action TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor_name TEXT; v_target_name TEXT; v_id TEXT := gen_random_uuid()::text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM chat.chats WHERE id = p_chat_id AND kind = 'group') THEN RETURN; END IF;
    SELECT display_name INTO v_actor_name FROM identity.users WHERE id = p_actor;
    SELECT display_name INTO v_target_name FROM identity.users WHERE id = p_target;
    INSERT INTO chat.messages(id, chat_id, sender_user_id, content, content_type, client_message_id)
    VALUES (v_id, p_chat_id, NULL,
        CASE WHEN p_action = 'left' THEN v_actor_name || ' 退出了群聊'
             WHEN p_action = 'removed' THEN v_actor_name || ' 将 ' || v_target_name || ' 移出了群聊'
             WHEN p_action = 'admin' THEN v_actor_name || ' 将 ' || v_target_name || ' 设为管理员'
             ELSE v_actor_name || ' 撤销了 ' || v_target_name || ' 的管理员身份' END,
        'system', 'member-managed:' || v_id || ':' || p_actor || ',' || p_target);
END;
$$;
REVOKE ALL ON FUNCTION chat.announce_group_management(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION chat.remove_group_member_as(p_chat_id TEXT, p_member_user_id TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id); v_kind TEXT; v_role TEXT; v_owned BOOLEAN; v_rooms TEXT[];
BEGIN
    SELECT kind INTO v_kind FROM chat.chats WHERE id = p_chat_id FOR UPDATE;
    IF v_kind IS NULL OR v_kind NOT IN ('group', 'topic') THEN RAISE EXCEPTION 'not_a_group'; END IF;
    SELECT role INTO v_role FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = p_member_user_id FOR UPDATE;
    SELECT EXISTS (SELECT 1 FROM identity.users WHERE id = p_member_user_id AND type = 'agent'
                   AND owner_user_id = v_actor) INTO v_owned;
    IF v_actor <> p_member_user_id AND NOT v_owned THEN
        PERFORM chat.require_group_manager(p_chat_id, v_actor);
    END IF;
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('status', 'already_absent', 'chat_id', p_chat_id, 'user_id', p_member_user_id);
    END IF;
    IF v_kind = 'group' AND v_role = 'owner' THEN RAISE EXCEPTION 'group_owner_cannot_leave'; END IF;
    WITH RECURSIVE rooms AS (
        SELECT p_chat_id AS id
        UNION ALL SELECT c.id FROM chat.chats c JOIN rooms r ON c.source_chat_id = r.id WHERE c.kind = 'topic'
    ) SELECT array_agg(id) INTO v_rooms FROM rooms;
    DELETE FROM chat.group_agent_states WHERE chat_id = ANY(v_rooms) AND agent_user_id = p_member_user_id;
    DELETE FROM chat.chat_members WHERE chat_id = ANY(v_rooms) AND user_id = p_member_user_id;
    PERFORM chat.announce_group_management(p_chat_id, v_actor, p_member_user_id,
        CASE WHEN v_actor = p_member_user_id THEN 'left' ELSE 'removed' END);
    RETURN jsonb_build_object('status', 'removed', 'chat_id', p_chat_id, 'user_id', p_member_user_id);
END;
$$;
REVOKE ALL ON FUNCTION chat.remove_group_member_as(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.remove_group_member_as(TEXT, TEXT, TEXT) TO authenticated;

CREATE FUNCTION chat.set_group_member_role_as(p_chat_id TEXT, p_member_user_id TEXT, p_role TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT; v_role TEXT;
BEGIN
    PERFORM 1 FROM chat.chats WHERE id = p_chat_id FOR UPDATE;
    v_actor := chat.require_group_manager(p_chat_id, p_as_user_id);
    IF p_role IS NULL OR p_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION 'invalid_group_role'; END IF;
    SELECT role INTO v_role FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = p_member_user_id FOR UPDATE;
    IF v_role IS NULL THEN RAISE EXCEPTION 'group_member_not_found'; END IF;
    IF v_role = 'owner' THEN RAISE EXCEPTION 'group_owner_role_protected'; END IF;
    IF v_role <> p_role THEN
        UPDATE chat.chat_members SET role = p_role WHERE chat_id = p_chat_id AND user_id = p_member_user_id;
        UPDATE chat.group_agent_states SET last_action = 'gugu:i18n:messaging:chatService.groupAction.roleUpdated', updated_at = now()
        WHERE chat_id = p_chat_id AND agent_user_id = p_member_user_id;
        PERFORM chat.announce_group_management(p_chat_id, v_actor, p_member_user_id, p_role);
    END IF;
    RETURN jsonb_build_object('chat_id', p_chat_id, 'user_id', p_member_user_id, 'role', p_role);
END;
$$;
REVOKE ALL ON FUNCTION chat.set_group_member_role_as(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.set_group_member_role_as(TEXT, TEXT, TEXT, TEXT) TO authenticated;

CREATE FUNCTION chat.set_agent_listen_mode_as(p_chat_id TEXT, p_agent_user_id TEXT, p_mode TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id);
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.users a JOIN identity.users h ON h.id = a.owner_user_id
        WHERE a.id = p_agent_user_id AND a.type = 'agent' AND h.type = 'human' AND h.id = v_actor) THEN
        RAISE EXCEPTION 'agent_owner_required' USING ERRCODE = '42501';
    END IF;
    IF p_mode IS NULL OR p_mode NOT IN ('active', 'passive') THEN RAISE EXCEPTION 'invalid_listen_mode'; END IF;
    UPDATE chat.chat_members SET listen_mode = p_mode WHERE chat_id = p_chat_id AND user_id = p_agent_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'group_member_not_found'; END IF;
    RETURN jsonb_build_object('chat_id', p_chat_id, 'user_id', p_agent_user_id, 'listen_mode', p_mode);
END;
$$;
REVOKE ALL ON FUNCTION chat.set_agent_listen_mode_as(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.set_agent_listen_mode_as(TEXT, TEXT, TEXT, TEXT) TO authenticated;

CREATE FUNCTION chat.update_group_as(p_chat_id TEXT, p_changes JSONB, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT; v_kind TEXT;
BEGIN
    SELECT kind INTO v_kind FROM chat.chats WHERE id = p_chat_id FOR UPDATE;
    v_actor := chat.require_group_manager(p_chat_id, p_as_user_id);
    IF jsonb_typeof(p_changes) IS DISTINCT FROM 'object' OR p_changes = '{}'::jsonb OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('name','description','group_prompt',
            'default_agent_type','join_mode','allow_member_invite','agent_join_approval','invite_link_enabled',
            'max_members','hide_history','agent_flood_threshold','avatar_url','avatar_storage_bucket_id',
            'avatar_storage_object_name','is_discoverable')
    ) THEN RAISE EXCEPTION 'invalid_group_changes'; END IF;
    IF v_kind = 'topic' AND EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes) k
                                  WHERE k NOT IN ('name','agent_flood_threshold')) THEN
        RAISE EXCEPTION 'invalid_topic_changes';
    END IF;
    IF p_changes ? 'name' AND NULLIF(btrim(p_changes->>'name'),'') IS NULL THEN RAISE EXCEPTION 'group_name_required'; END IF;
    IF p_changes ? 'join_mode' AND COALESCE(p_changes->>'join_mode','') NOT IN ('open','approval','invite_only') THEN
        RAISE EXCEPTION 'invalid_join_mode'; END IF;
    IF p_changes ? 'max_members' AND ((p_changes->>'max_members')::numeric < 1
        OR (p_changes->>'max_members')::numeric <> trunc((p_changes->>'max_members')::numeric)
        OR p_changes->'max_members' = 'null'::jsonb) THEN RAISE EXCEPTION 'invalid_member_limit'; END IF;
    IF p_changes ? 'agent_flood_threshold' AND p_changes->'agent_flood_threshold' <> 'null'::jsonb
        AND ((p_changes->>'agent_flood_threshold')::numeric < 1 OR (p_changes->>'agent_flood_threshold')::numeric
          <> trunc((p_changes->>'agent_flood_threshold')::numeric)) THEN RAISE EXCEPTION 'invalid_agent_threshold'; END IF;
    IF (p_changes ?| ARRAY['avatar_url','avatar_storage_bucket_id','avatar_storage_object_name'])
       AND NOT (p_changes ?& ARRAY['avatar_url','avatar_storage_bucket_id','avatar_storage_object_name']) THEN
        RAISE EXCEPTION 'group_avatar_reference_required'; END IF;
    UPDATE chat.chats SET
        name = CASE WHEN p_changes ? 'name' THEN btrim(p_changes->>'name') ELSE name END,
        description = CASE WHEN p_changes ? 'description' THEN NULLIF(btrim(p_changes->>'description'),'') ELSE description END,
        group_prompt = CASE WHEN p_changes ? 'group_prompt' THEN NULLIF(btrim(p_changes->>'group_prompt'),'') ELSE group_prompt END,
        default_agent_type = CASE WHEN p_changes ? 'default_agent_type' THEN p_changes->>'default_agent_type' ELSE default_agent_type END,
        join_mode = CASE WHEN p_changes ? 'join_mode' THEN p_changes->>'join_mode' ELSE join_mode END,
        allow_member_invite = CASE WHEN p_changes ? 'allow_member_invite' THEN (p_changes->>'allow_member_invite')::boolean ELSE allow_member_invite END,
        agent_join_approval = CASE WHEN p_changes ? 'agent_join_approval' THEN (p_changes->>'agent_join_approval')::boolean ELSE agent_join_approval END,
        invite_link_enabled = CASE WHEN p_changes ? 'invite_link_enabled' THEN (p_changes->>'invite_link_enabled')::boolean ELSE invite_link_enabled END,
        max_members = CASE WHEN p_changes ? 'max_members' THEN (p_changes->>'max_members')::integer ELSE max_members END,
        hide_history = CASE WHEN p_changes ? 'hide_history' THEN (p_changes->>'hide_history')::boolean ELSE hide_history END,
        agent_flood_threshold = CASE WHEN p_changes ? 'agent_flood_threshold' THEN (p_changes->>'agent_flood_threshold')::integer ELSE agent_flood_threshold END,
        avatar_url = CASE WHEN p_changes ? 'avatar_url' THEN p_changes->>'avatar_url' ELSE avatar_url END,
        avatar_storage_bucket_id = CASE WHEN p_changes ? 'avatar_storage_bucket_id' THEN p_changes->>'avatar_storage_bucket_id' ELSE avatar_storage_bucket_id END,
        avatar_storage_object_name = CASE WHEN p_changes ? 'avatar_storage_object_name' THEN p_changes->>'avatar_storage_object_name' ELSE avatar_storage_object_name END,
        is_discoverable = CASE WHEN p_changes ? 'is_discoverable' THEN (p_changes->>'is_discoverable')::boolean ELSE is_discoverable END
    WHERE id = p_chat_id;
    RETURN chat.group_info_as(p_chat_id, v_actor);
END;
$$;
REVOKE ALL ON FUNCTION chat.update_group_as(TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.update_group_as(TEXT, JSONB, TEXT) TO authenticated;

CREATE FUNCTION chat.archive_group_as(p_chat_id TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id);
BEGIN
    PERFORM 1 FROM chat.chats c JOIN chat.chat_members m ON m.chat_id = c.id JOIN identity.users u ON u.id = m.user_id
    WHERE c.id = p_chat_id AND c.kind = 'group' AND m.user_id = v_actor AND m.role = 'owner' AND u.type = 'human'
    FOR UPDATE OF c;
    IF NOT FOUND THEN RAISE EXCEPTION 'human_group_owner_required' USING ERRCODE = '42501'; END IF;
    UPDATE chat.chats SET status = 'archived' WHERE id = p_chat_id;
    RETURN jsonb_build_object('chat_id', p_chat_id, 'status', 'archived');
END;
$$;
REVOKE ALL ON FUNCTION chat.archive_group_as(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.archive_group_as(TEXT, TEXT) TO authenticated;

CREATE FUNCTION chat.post_group_announcement_as(p_chat_id TEXT, p_text TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT; v_id TEXT;
BEGIN
    PERFORM 1 FROM chat.chats WHERE id = p_chat_id FOR UPDATE;
    v_actor := chat.require_group_manager(p_chat_id, p_as_user_id);
    IF NULLIF(btrim(p_text),'') IS NULL THEN RAISE EXCEPTION 'announcement_text_required'; END IF;
    INSERT INTO chat.group_announcements(chat_id, author_id, content) VALUES (p_chat_id, v_actor, btrim(p_text)) RETURNING id INTO v_id;
    RETURN jsonb_build_object('id', v_id, 'chat_id', p_chat_id, 'content', btrim(p_text));
END;
$$;
REVOKE ALL ON FUNCTION chat.post_group_announcement_as(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.post_group_announcement_as(TEXT, TEXT, TEXT) TO authenticated;

CREATE FUNCTION chat.update_group_announcement_as(p_announcement_id TEXT, p_changes JSONB, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_chat TEXT; v_row JSONB;
BEGIN
    SELECT chat_id INTO v_chat FROM chat.group_announcements WHERE id = p_announcement_id::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'announcement_not_found'; END IF;
    PERFORM chat.require_group_manager(v_chat, p_as_user_id);
    IF jsonb_typeof(p_changes) IS DISTINCT FROM 'object' OR p_changes = '{}'::jsonb
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('content','pinned')) THEN
        RAISE EXCEPTION 'invalid_announcement_changes'; END IF;
    IF p_changes ? 'content' AND NULLIF(btrim(p_changes->>'content'),'') IS NULL THEN RAISE EXCEPTION 'announcement_text_required'; END IF;
    UPDATE chat.group_announcements SET content = CASE WHEN p_changes ? 'content' THEN btrim(p_changes->>'content') ELSE content END,
        pinned = CASE WHEN p_changes ? 'pinned' THEN (p_changes->>'pinned')::boolean ELSE pinned END
    WHERE id = p_announcement_id::uuid RETURNING to_jsonb(group_announcements.*) INTO v_row;
    RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION chat.update_group_announcement_as(TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.update_group_announcement_as(TEXT, JSONB, TEXT) TO authenticated;

CREATE FUNCTION chat.delete_group_announcement_as(p_announcement_id TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_chat TEXT;
BEGIN
    SELECT chat_id INTO v_chat FROM chat.group_announcements WHERE id = p_announcement_id::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'announcement_not_found'; END IF;
    PERFORM chat.require_group_manager(v_chat, p_as_user_id);
    DELETE FROM chat.group_announcements WHERE id = p_announcement_id::uuid;
    RETURN jsonb_build_object('id', p_announcement_id, 'chat_id', v_chat, 'status', 'deleted');
END;
$$;
REVOKE ALL ON FUNCTION chat.delete_group_announcement_as(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.delete_group_announcement_as(TEXT, TEXT) TO authenticated;

-- Structure invariants remain in triggers. The mutable column permissions and
-- sole RPC predicates replace the former duplicate client-role/listen guards.
REVOKE DELETE ON chat.group_agent_states FROM authenticated;
DROP POLICY group_agent_states_delete_group_agent_manager ON chat.group_agent_states;
REVOKE INSERT, DELETE ON chat.chat_members FROM authenticated;
REVOKE UPDATE (role, listen_mode) ON chat.chat_members FROM authenticated;
DROP POLICY members_insert_group_manager ON chat.chat_members;
DROP POLICY members_delete_self ON chat.chat_members;
DROP POLICY members_update_own ON chat.chat_members;
CREATE POLICY members_update_own ON chat.chat_members FOR UPDATE TO authenticated
    USING (user_id = (SELECT auth.uid()::text) OR chat.is_owned_agent_user(user_id))
    WITH CHECK (user_id = (SELECT auth.uid()::text) OR chat.is_owned_agent_user(user_id));
DROP TRIGGER guard_member_role_change ON chat.chat_members;
DROP FUNCTION chat.guard_member_role_change();
DROP TRIGGER guard_member_listen_mode_change ON chat.chat_members;
DROP FUNCTION chat.guard_member_listen_mode_change();
REVOKE UPDATE ON chat.chats FROM authenticated;
REVOKE UPDATE (name, status, pinned_message_id, group_prompt, default_agent_type, description, max_members,
    allow_member_invite, agent_join_approval, join_mode, hide_history, is_discoverable, avatar_url,
    avatar_storage_bucket_id, avatar_storage_object_name, agent_flood_threshold, invite_link_enabled)
ON chat.chats FROM authenticated;
DROP POLICY chats_update_owner ON chat.chats;
REVOKE INSERT, UPDATE, DELETE ON chat.group_announcements FROM authenticated;
DROP POLICY group_announcements_insert_admin ON chat.group_announcements;
DROP POLICY group_announcements_update_admin ON chat.group_announcements;
DROP POLICY group_announcements_delete_admin ON chat.group_announcements;


CREATE OR REPLACE FUNCTION chat.chats_membership_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = chat, identity, public, pg_catalog
AS $$
DECLARE
    affected_chat_id TEXT := COALESCE(NEW.chat_id, OLD.chat_id);
    chat_kind TEXT;
    chat_status TEXT;
    creator_user_id TEXT;
    owner_user_id TEXT;
    owner_count INTEGER;
    owner_is_human BOOLEAN;
    member_count_val INTEGER;
BEGIN
    SELECT kind, status, chats.creator_user_id
    INTO chat_kind, chat_status, creator_user_id
    FROM chat.chats WHERE id = affected_chat_id;
    IF chat_kind IS NULL OR chat_kind <> 'group' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    SELECT count(*), min(cm.user_id), bool_and(u.type = 'human')
    INTO owner_count, owner_user_id, owner_is_human
    FROM chat.chat_members cm
    LEFT JOIN identity.users u ON u.id = cm.user_id
    WHERE cm.chat_id = affected_chat_id AND cm.role = 'owner';
    SELECT count(*) INTO member_count_val
    FROM chat.chat_members WHERE chat_id = affected_chat_id;

    IF chat_status <> 'archived' THEN
        IF owner_count <> 1 OR NOT COALESCE(owner_is_human, false) THEN
            RAISE EXCEPTION 'non-archived group chat % must have exactly 1 human owner', affected_chat_id;
        END IF;
        IF creator_user_id IS DISTINCT FROM owner_user_id THEN
            RAISE EXCEPTION 'active group chat % creator and owner must match', affected_chat_id;
        END IF;
        IF chat_status = 'active' AND member_count_val < 1 THEN
            RAISE EXCEPTION 'active group chat % must have >= 1 member (have %)', affected_chat_id, member_count_val;
        END IF;
    ELSE
        IF owner_count > 1 OR (owner_count = 1 AND NOT COALESCE(owner_is_human, false)) THEN
            RAISE EXCEPTION 'archived group chat % cannot have invalid owners', affected_chat_id;
        END IF;
        IF (owner_count = 0 AND creator_user_id IS NOT NULL)
           OR (owner_count = 1 AND creator_user_id IS DISTINCT FROM owner_user_id) THEN
            RAISE EXCEPTION 'archived group chat % creator and owner must both be absent or match', affected_chat_id;
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION chat.chats_membership_invariants() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION chat.chats_status_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = chat, identity, public, pg_catalog
AS $$
DECLARE
    owner_user_id TEXT;
    owner_count INTEGER;
    owner_is_human BOOLEAN;
    member_count_val INTEGER;
BEGIN
    IF NEW.kind <> 'group' THEN RETURN NEW; END IF;
    SELECT count(*), min(cm.user_id), bool_and(u.type = 'human')
    INTO owner_count, owner_user_id, owner_is_human
    FROM chat.chat_members cm
    LEFT JOIN identity.users u ON u.id = cm.user_id
    WHERE cm.chat_id = NEW.id AND cm.role = 'owner';
    SELECT count(*) INTO member_count_val FROM chat.chat_members WHERE chat_id = NEW.id;

    IF NEW.status <> 'archived'
       AND (owner_count <> 1 OR NOT COALESCE(owner_is_human, false)
            OR NEW.creator_user_id IS DISTINCT FROM owner_user_id
            OR (NEW.status = 'active' AND member_count_val < 1)) THEN
        RAISE EXCEPTION 'cannot set invalid non-archived group chat %', NEW.id;
    END IF;
    IF NEW.status = 'archived'
       AND (owner_count > 1
            OR (owner_count = 1 AND NOT COALESCE(owner_is_human, false))
            OR (owner_count = 0 AND NEW.creator_user_id IS NOT NULL)
            OR (owner_count = 1 AND NEW.creator_user_id IS DISTINCT FROM owner_user_id)) THEN
        RAISE EXCEPTION 'cannot archive group chat % with inconsistent creator/owner', NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION chat.chats_status_invariants() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION chat.skip_listen_state_for_member_join_notice()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
    IF EXISTS (
        SELECT 1 FROM chat.messages m
        WHERE m.id = NEW.message_id
          AND m.sender_user_id IS NULL
          AND (m.client_message_id LIKE 'member-joined:%' OR m.client_message_id LIKE 'member-managed:%')
    ) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION chat.skip_listen_state_for_member_join_notice() FROM PUBLIC, anon, authenticated;

DROP FUNCTION chat.decide_group_join(TEXT, BOOLEAN);

CREATE FUNCTION chat.decide_group_join(p_request_id TEXT, p_accept BOOLEAN, p_as_user_id TEXT)
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

    INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES (v_req.chat_id, v_req.requester_user_id, 'member')
    ON CONFLICT (chat_id, user_id) DO NOTHING;
    IF v_type = 'agent' THEN
        INSERT INTO chat.group_agent_states (chat_id, agent_user_id, functional_role, capability_roles, last_action, updated_at)
        VALUES (v_req.chat_id, v_req.requester_user_id, 'member', ARRAY['member']::TEXT[], '已加入群聊', now())
        ON CONFLICT (chat_id, agent_user_id) DO NOTHING;
    END IF;
    UPDATE chat.group_join_requests SET status = 'accepted', updated_at = now() WHERE id = p_request_id;
    RETURN jsonb_build_object('request_id', p_request_id, 'chat_id', v_req.chat_id, 'status', 'accepted');
END;
$$;

REVOKE ALL ON FUNCTION chat.decide_group_join(TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.decide_group_join(TEXT, BOOLEAN, TEXT) TO authenticated;

DROP FUNCTION chat.list_group_join_requests(TEXT, BOOLEAN);

CREATE FUNCTION chat.list_group_join_requests(p_chat_id TEXT, p_include_decided BOOLEAN, p_as_user_id TEXT)
RETURNS TABLE(
    id TEXT, chat_id TEXT, requester_user_id TEXT, requester_name TEXT, requester_avatar TEXT,
    message TEXT, status TEXT, created_at TIMESTAMPTZ,
    requester_type TEXT, requested_by_user_id TEXT, requested_by_name TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = chat, identity, public, pg_catalog
AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    PERFORM chat.require_group_manager(p_chat_id, p_as_user_id);
    RETURN QUERY
    SELECT r.id, r.chat_id, r.requester_user_id, u.display_name, u.avatar, r.message, r.status, r.created_at,
           u.type, r.requested_by_user_id, b.display_name
      FROM chat.group_join_requests r
      JOIN identity.users u ON u.id = r.requester_user_id
      LEFT JOIN identity.users b ON b.id = r.requested_by_user_id
     WHERE r.chat_id = p_chat_id AND (p_include_decided OR r.status = 'pending')
     ORDER BY (r.status = 'pending') DESC, r.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION chat.list_group_join_requests(TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_group_join_requests(TEXT, BOOLEAN, TEXT) TO authenticated;

DROP FUNCTION chat.undo_agent_flood_adjustment(TEXT);

CREATE FUNCTION chat.undo_agent_flood_adjustment(p_adjustment_id TEXT, p_as_user_id TEXT)
RETURNS TABLE(adjustment_id TEXT, restored INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = chat, identity, public, pg_catalog
AS $function$
DECLARE
    v_me TEXT := chat.require_group_actor(p_as_user_id);
    v_chat_id TEXT;
    v_changed JSONB;
    v_restored INTEGER := 0;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT a.chat_id, a.changed INTO v_chat_id, v_changed
    FROM chat.agent_flood_adjustments a
    WHERE a.id = p_adjustment_id AND a.undone_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Adjustment % not found or already undone', p_adjustment_id;
    END IF;

    IF NOT chat.is_chat_member(v_chat_id, v_me) THEN
        RAISE EXCEPTION 'Not a member of chat %', v_chat_id;
    END IF;

    -- 只还原那些「现在仍然是我们改成的 passive」的成员:用户在这中间手动调过的,他的选择说了算。
    WITH restored AS (
        UPDATE chat.chat_members cm
        SET listen_mode = entry.previous_listen_mode, updated_at = now()
        FROM jsonb_to_recordset(v_changed) AS entry(user_id TEXT, previous_listen_mode TEXT)
        WHERE cm.chat_id = v_chat_id
          AND cm.user_id = entry.user_id
          AND cm.listen_mode = 'passive'
        RETURNING 1
    )
    SELECT count(*) INTO v_restored FROM restored;

    UPDATE chat.agent_flood_adjustments
    SET undone_at = now(), undone_by = v_me
    WHERE id = p_adjustment_id;

    -- 闸门故意不清:撤回之后同一个群不再自动改第二次(spec:否则就是跟用户打架)。

    RETURN QUERY SELECT p_adjustment_id, v_restored;
END;
$function$;

REVOKE ALL ON FUNCTION chat.undo_agent_flood_adjustment(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.undo_agent_flood_adjustment(TEXT, TEXT) TO authenticated;

-- Admission and the generalized invitation state machine follow in the next migration.
NOTIFY pgrst, 'reload schema';
