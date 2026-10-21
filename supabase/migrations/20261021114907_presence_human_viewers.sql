-- Presence revisions feed the signed-in human UI. Agent MCP reads the same
-- authoritative snapshot on demand; device hosts subscribe to device commands.
-- Shared-chat agents therefore have no consumer for these revision wakes.
-- Filter before both the journal append and the wake to avoid multiplying every
-- runtime change by all agent members of every shared chat.
CREATE OR REPLACE FUNCTION identity.fan_agent_presence_to_viewers(
    p_agent_user_id TEXT,
    p_payload JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = identity, chat, realtime, public, pg_catalog
AS $$
DECLARE
    viewer_user_id TEXT;
    next_revision BIGINT;
BEGIN
    IF p_payload IS NULL THEN
        RAISE EXCEPTION 'Agent presence payload is required';
    END IF;

    FOR viewer_user_id IN
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
          JOIN identity.users viewer ON viewer.id = candidate.user_id
                                    AND viewer.type = 'human'
         WHERE candidate.user_id IS NOT NULL
         ORDER BY candidate.user_id
    LOOP
        next_revision := chat.append_user_revision(
          viewer_user_id,
          'presence_changed',
          jsonb_build_object('agent_user_id', p_agent_user_id),
          COALESCE(p_payload ->> 'derived_status', '') = 'removed'
        );
        IF chat.claim_presence_wake(viewer_user_id) THEN
            PERFORM realtime.send(
                jsonb_build_object('revision', next_revision),
                'im_revision_advanced',
                'gugu:user:' || viewer_user_id || ':events',
                true
            );
        END IF;
    END LOOP;
END;
$$;

-- Internal trigger helper: preserve its existing non-API ACL.
REVOKE ALL ON FUNCTION identity.fan_agent_presence_to_viewers(TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
