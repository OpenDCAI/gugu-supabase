-- Device writes and message inserts took the same two kinds of lock in opposite orders.
--
-- A device registration upsert (PostgREST on_conflict=device_id) sets device_id, so ON CONFLICT locks the
-- device row FOR UPDATE; its AFTER triggers then advance the owner's account revision head. A message that
-- wakes an agent advances every member's head first (broadcast_message_created) and only later inserts the
-- agent.deliver command, whose foreign key takes FOR KEY SHARE on the agent's device row. Device row then
-- head on one side, head then device row on the other: the device upsert was the deadlock victim in 14 of
-- 18 staging deadlocks between 10-26 and 10-29.
--
-- The shared order is now "device rows, then account heads", which device upserts, heartbeat PATCHes and
-- the lease sweeper already follow. A message insert takes the key-share locks its deliver commands will
-- need before any trigger touches a head. Separately, a device status change advanced the heads of each
-- hosted agent's viewers one agent at a time and the owner last, so two changes could cross; it now locks
-- every head it will advance in one sorted pass first.

-- Same initialization and lock mode as chat.lock_chat_revision_recipients, for an explicit set of accounts.
CREATE FUNCTION chat.lock_revision_heads(p_user_ids text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE
    target_user_id TEXT;
BEGIN
    FOR target_user_id IN
        SELECT DISTINCT u FROM unnest(p_user_ids) AS u WHERE u IS NOT NULL ORDER BY u
    LOOP
        INSERT INTO chat.account_revision_heads (user_id) VALUES (target_user_id)
        ON CONFLICT (user_id) DO NOTHING;
        PERFORM 1 FROM chat.account_revision_heads h WHERE h.user_id = target_user_id FOR NO KEY UPDATE;
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION chat.lock_revision_heads(text[]) FROM PUBLIC, anon, authenticated, service_role;

-- The accounts identity.fan_agent_presence_to_viewers advances for one agent; keep the two in step.
CREATE FUNCTION identity.agent_presence_viewer_ids(p_agent_user_id text) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $$
    SELECT DISTINCT candidate.user_id
      FROM (
        SELECT unnest(t.presence_viewer_user_ids) AS user_id
          FROM identity.agent_lifecycle_tombstones t
         WHERE t.agent_user_id = p_agent_user_id
        UNION
        SELECT u.owner_user_id
          FROM identity.users u
         WHERE u.id = p_agent_user_id
           AND u.type = 'agent'
           AND u.owner_user_id IS NOT NULL
        UNION
        SELECT CASE WHEN f.user_a_id = p_agent_user_id THEN f.user_b_id ELSE f.user_a_id END
          FROM identity.friendships f
         WHERE f.user_a_id = p_agent_user_id OR f.user_b_id = p_agent_user_id
        UNION
        SELECT cm_self.user_id
          FROM chat.chat_members cm_agent
          JOIN chat.chat_members cm_self ON cm_self.chat_id = cm_agent.chat_id
         WHERE cm_agent.user_id = p_agent_user_id
           AND cm_self.user_id <> p_agent_user_id
      ) candidate
      JOIN identity.users viewer ON viewer.id = candidate.user_id AND viewer.type = 'human'
     WHERE candidate.user_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION identity.agent_presence_viewer_ids(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION identity.broadcast_agent_presence_from_device() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'identity', 'realtime', 'public', 'pg_catalog'
AS $$
DECLARE
    v_agent RECORD;
    v_payload JSONB;
BEGIN
    -- This trigger and the device revision trigger after it advance these heads; lock them all first, sorted.
    PERFORM chat.lock_revision_heads(ARRAY(
        SELECT NEW.user_id::text
        UNION
        SELECT viewer.user_id
          FROM identity.users agent
          CROSS JOIN LATERAL identity.agent_presence_viewer_ids(agent.id) AS viewer(user_id)
         WHERE agent.device_id = NEW.device_id AND agent.type = 'agent'));
    FOR v_agent IN
        SELECT id
        FROM identity.users
        WHERE device_id = NEW.device_id
          AND type = 'agent'
    LOOP
        v_payload := identity.build_agent_presence_payload(v_agent.id);
        IF v_payload IS NULL THEN
            CONTINUE;
        END IF;
        PERFORM identity.fan_agent_presence_to_viewers(v_agent.id, v_payload);
    END LOOP;
    RETURN NEW;
END;
$$;

-- Superset of the devices chat.enqueue_agent_deliver_device_command can address for this message (agent
-- members, plus addressed agents a topic message may add), locked in device order. A broader key-share
-- lock only makes this insert wait for a concurrent device upsert; it never blocks heartbeats or sweeps.
CREATE FUNCTION chat.lock_message_agent_devices() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL OR chat.message_wakes_nobody(NEW.content_type, NEW.reply_to_message_id) THEN
        RETURN NEW;
    END IF;
    PERFORM 1
       FROM identity.gugu_devices d
      WHERE d.device_id IN (
            SELECT u.device_id
              FROM chat.chat_members cm
              JOIN identity.users u ON u.id = cm.user_id
             WHERE cm.chat_id = NEW.chat_id
               AND u.type = 'agent' AND u.device_id IS NOT NULL AND u.owner_user_id IS NOT NULL
               AND u.desired_status = 'online' AND u.session_archived_at IS NULL
            UNION
            SELECT u.device_id
              FROM identity.users u
             WHERE u.id = ANY (NEW.to_user_ids)
               AND u.type = 'agent' AND u.device_id IS NOT NULL AND u.owner_user_id IS NOT NULL
               AND u.desired_status = 'online' AND u.session_archived_at IS NULL)
      ORDER BY d.device_id
      FOR KEY SHARE OF d;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.lock_message_agent_devices() FROM PUBLIC, anon, authenticated, service_role;

-- BEFORE INSERT triggers fire by name: "messages_a_" runs before every trigger that can touch a head
-- (messages_join_topic_participants adds topic members) and before all AFTER triggers.
CREATE TRIGGER messages_a_lock_agent_devices BEFORE INSERT ON chat.messages
    FOR EACH ROW EXECUTE FUNCTION chat.lock_message_agent_devices();
