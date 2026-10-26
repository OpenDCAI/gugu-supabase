-- Topic participation enrolls an Agent and its eligible human owner atomically.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION chat.enroll_topic_agent_owner()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_topic chat.chats%ROWTYPE;
    v_owner TEXT;
    v_role TEXT := 'member';
BEGIN
    SELECT * INTO v_topic FROM chat.chats WHERE id = NEW.chat_id AND kind = 'topic';
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT owner_user_id INTO v_owner FROM identity.users WHERE id = NEW.user_id AND type = 'agent';
    IF NOT FOUND THEN RETURN NULL; END IF;

    -- Lock the existing source seat: a concurrent source departure cannot
    -- invalidate the owner's eligibility before this admission commits.
    PERFORM 1 FROM chat.chat_members m JOIN identity.users u ON u.id = m.user_id AND u.type = 'human'
     WHERE m.chat_id = v_topic.source_chat_id AND m.user_id = v_owner FOR KEY SHARE OF m;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The Agent''s human owner cannot join this topic because they are not a member of its source conversation'
            USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM identity.users creator WHERE creator.id = v_topic.creator_user_id
               AND (creator.id = v_owner OR (creator.type = 'agent' AND creator.owner_user_id = v_owner))) THEN
        v_role := 'owner';
    END IF;
    -- Existing seats keep their role, history boundary, read state and settings.
    -- The normal membership triggers supply visibility/inbox/revision behavior.
    INSERT INTO chat.chat_members(chat_id,user_id,role,joined_ingest_seq)
    VALUES (NEW.chat_id,v_owner,v_role,NEW.joined_ingest_seq)
    ON CONFLICT (chat_id,user_id) DO NOTHING;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION chat.enroll_topic_agent_owner() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER chat_members_enroll_topic_agent_owner
AFTER INSERT OR UPDATE OF chat_id, user_id ON chat.chat_members
FOR EACH ROW EXECUTE FUNCTION chat.enroll_topic_agent_owner();

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
        ELSIF v_chat.kind = 'topic' AND v_target.type = 'agent' AND v_related THEN
            -- Topic participation carries its human owner; the seat trigger
            -- checks that owner's source eligibility in the same transaction.
            v_role := 'member';
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

-- A departure carries the human's Agents through the existing cascade.
-- No historical seats are scanned or repaired by this release.
CREATE OR REPLACE FUNCTION chat.leave_topics_of_source_line()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_kind TEXT; v_type TEXT;
BEGIN
    SELECT kind INTO v_kind FROM chat.chats WHERE id = OLD.chat_id;
    SELECT type INTO v_type FROM identity.users WHERE id = OLD.user_id;
    IF v_type = 'human' AND v_kind IN ('group','topic') THEN
        DELETE FROM chat.chat_members m USING identity.users a
         WHERE m.chat_id = OLD.chat_id AND m.user_id = a.id
           AND a.type = 'agent' AND a.owner_user_id = OLD.user_id;
    ELSIF v_type = 'agent' THEN
        DELETE FROM chat.group_agent_states
         WHERE chat_id = OLD.chat_id AND agent_user_id = OLD.user_id;
    END IF;
    -- Keep the same source -> topic propagation for the departing identity.
    -- Deleted Agent seats recurse here too, removing their topic state/seats.
    DELETE FROM chat.chat_members cm USING chat.chats t
     WHERE t.id = cm.chat_id AND t.kind = 'topic'
       AND t.source_chat_id = OLD.chat_id AND cm.user_id = OLD.user_id;
    RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION chat.leave_topics_of_source_line() FROM PUBLIC, anon, authenticated;
