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
