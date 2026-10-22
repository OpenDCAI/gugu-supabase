-- Retire the agent runtime_status / derived_status chain, first step (signatures unchanged).
--
-- An agent's online state on every current client is the device row plus desired_status: deriveAgentReachability
-- resolves an offline runtime/derived status with desired_status 'online' (always set in the presence payload) to
-- online, since client 0.2.30. runtime_status and derived_status therefore never change what a reader shows:
-- - set_agent_runtime_state ignores p_runtime_status. A new row records 'offline' (the column's CHECK has no neutral
--   value); an existing row keeps what it has. The parameter stays so clients that still send it keep working;
--   dropping it and the column waits until those clients are gone.
-- - build_agent_presence_payload no longer computes derived_status (last_seen_at within 180 s). A client that
--   still reads it falls back to runtime_status, which desired_status overrides the same way.
-- - fan_agent_presence_to_viewers no longer passes "derived_status = 'removed'" as the revision tombstone. That
--   value is only ever online/offline, so the flag was always false, and no client reads the tombstone of a
--   presence_changed revision (it re-reads the presence snapshot, which carries account_status = 'removed').
-- - set_agent_desired_status no longer broadcasts runtime_changed on agent:<id>:runtime; nothing subscribes to it.
--   It fans the presence snapshot to viewers instead, like every other presence change: before this, switching an
--   agent offline (or back online) reached other viewers only on their next full refresh.
-- Every function keeps its ACL: the event trigger revokes EXECUTE after CREATE OR REPLACE, so each is restated.

CREATE OR REPLACE FUNCTION identity.set_agent_runtime_state(p_agent_user_id text, p_runtime_status text DEFAULT NULL::text, p_activity_status text DEFAULT 'idle'::text, p_runtime_kind text DEFAULT NULL::text, p_runtime_label text DEFAULT NULL::text, p_window_title text DEFAULT NULL::text, p_pid integer DEFAULT NULL::integer, p_last_seen_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_recent_tool_type text DEFAULT NULL::text, p_recent_actions text[] DEFAULT NULL::text[], p_last_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_active_chat_id text DEFAULT NULL::text, p_agent_status text DEFAULT NULL::text, p_agent_status_detail text DEFAULT NULL::text) RETURNS identity.agent_runtime_states
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'identity', 'public', 'pg_catalog'
    AS $$
DECLARE
    v_row identity.agent_runtime_states;
BEGIN
    IF NOT identity.can_write_agent_runtime_state(p_agent_user_id) THEN
        RAISE EXCEPTION 'Agent runtime state is not writable by current user';
    END IF;

    INSERT INTO identity.agent_runtime_states (
        agent_user_id, owner_user_id, runtime_status, activity_status, runtime_kind,
        runtime_label, window_title, pid, last_seen_at, recent_tool_type, recent_actions,
        last_action_at, active_chat_id, agent_status, agent_status_detail
    )
    VALUES (
        p_agent_user_id,
        (SELECT auth.uid()::text),
        'offline',
        COALESCE(p_activity_status, 'idle'),
        p_runtime_kind, p_runtime_label, p_window_title, p_pid,
        COALESCE(p_last_seen_at, now()),
        p_recent_tool_type, p_recent_actions, p_last_action_at,
        CASE WHEN COALESCE(p_activity_status, 'idle') = 'running' THEN p_active_chat_id ELSE NULL END,
        p_agent_status, p_agent_status_detail
    )
    ON CONFLICT (agent_user_id) DO UPDATE
    SET activity_status = EXCLUDED.activity_status,
        runtime_kind = EXCLUDED.runtime_kind,
        runtime_label = EXCLUDED.runtime_label,
        window_title = EXCLUDED.window_title,
        pid = EXCLUDED.pid,
        last_seen_at = EXCLUDED.last_seen_at,
        recent_tool_type = COALESCE(EXCLUDED.recent_tool_type, agent_runtime_states.recent_tool_type),
        recent_actions = COALESCE(EXCLUDED.recent_actions, agent_runtime_states.recent_actions),
        last_action_at = COALESCE(EXCLUDED.last_action_at, agent_runtime_states.last_action_at),
        active_chat_id = CASE WHEN EXCLUDED.activity_status = 'running' THEN EXCLUDED.active_chat_id ELSE NULL END,
        -- 读数每次都覆盖:说不出读数的写(NULL)就是「这一行此刻没有读数」,❌ 留着上一句。
        agent_status = EXCLUDED.agent_status,
        agent_status_detail = EXCLUDED.agent_status_detail
    RETURNING *
    INTO v_row;

    RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION identity.set_agent_runtime_state(p_agent_user_id text, p_runtime_status text, p_activity_status text, p_runtime_kind text, p_runtime_label text, p_window_title text, p_pid integer, p_last_seen_at timestamp with time zone, p_recent_tool_type text, p_recent_actions text[], p_last_action_at timestamp with time zone, p_active_chat_id text, p_agent_status text, p_agent_status_detail text) FROM PUBLIC;
GRANT ALL ON FUNCTION identity.set_agent_runtime_state(p_agent_user_id text, p_runtime_status text, p_activity_status text, p_runtime_kind text, p_runtime_label text, p_window_title text, p_pid integer, p_last_seen_at timestamp with time zone, p_recent_tool_type text, p_recent_actions text[], p_last_action_at timestamp with time zone, p_active_chat_id text, p_agent_status text, p_agent_status_detail text) TO authenticated;

CREATE OR REPLACE FUNCTION identity.build_agent_presence_payload(p_agent_user_id text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'identity', 'public', 'pg_catalog'
    AS $$
DECLARE
    v_payload JSONB;
BEGIN
    SELECT jsonb_build_object(
        'presence', jsonb_build_object(
            'agent_user_id',        u.id,
            'account_status',       'active',
            'runtime_status',       COALESCE(r.runtime_status, 'offline'),
            'desired_status',       COALESCE(u.desired_status, 'online'),
            'activity_status',      COALESCE(r.activity_status, 'idle'),
            -- #6448 宿主写下的读数;NULL = 这一行没有读数(读方退回 activity_status)。
            'agent_status',         r.agent_status,
            'agent_status_detail',  r.agent_status_detail,
            'active_chat_id',       r.active_chat_id,
            'runtime_kind',         r.runtime_kind,
            'runtime_label',        r.runtime_label,
            'agent_type',           ap.agent_type,
            'recent_tool_type',     r.recent_tool_type,
            'recent_actions',       COALESCE(r.recent_actions, ARRAY[]::TEXT[]),
            'last_action_at',       r.last_action_at,
            'window_title',         r.window_title,
            'pid',                  r.pid,
            'runtime_last_seen_at', r.last_seen_at,
            'device_id',            u.device_id,
            'device_status',        d.status,
            'device_last_seen_at',  d.last_seen_at,
            'host_runtime_capability', (d.capabilities->>'host_runtime_capability')::int,
            'consecutive_deliver_failures', COALESCE(r.consecutive_deliver_failures, 0),
            'updated_at',           GREATEST(
                                        COALESCE(r.updated_at, to_timestamp(0)),
                                        COALESCE(d.updated_at, to_timestamp(0))
                                    )
        )
    )
      INTO v_payload
      FROM identity.users u
      LEFT JOIN identity.agent_runtime_states r ON r.agent_user_id = u.id
      LEFT JOIN identity.gugu_devices d ON d.device_id = u.device_id
      LEFT JOIN identity.agent_profiles ap ON ap.id::text = u.id
     WHERE u.id = p_agent_user_id
       AND u.type = 'agent';

    IF v_payload IS NOT NULL THEN
        RETURN v_payload;
    END IF;

    SELECT jsonb_build_object(
        'presence', jsonb_build_object(
            'agent_user_id',        t.agent_user_id,
            'account_status',       'removed',
            'runtime_status',       'offline',
            'desired_status',       'offline',
            'activity_status',      'idle',
            'agent_status',         NULL,
            'agent_status_detail',  NULL,
            'active_chat_id',       NULL,
            'runtime_kind',         NULL,
            'runtime_label',        NULL,
            'agent_type',           NULL,
            'recent_tool_type',     NULL,
            'recent_actions',       ARRAY[]::TEXT[],
            'last_action_at',       NULL,
            'window_title',         NULL,
            'pid',                  NULL,
            'runtime_last_seen_at', NULL,
            'device_id',            NULL,
            'device_status',        NULL,
            'device_last_seen_at',  NULL,
            'host_runtime_capability', NULL,
            'consecutive_deliver_failures', 0,
            'updated_at',           t.removed_at
        )
    )
      INTO v_payload
      FROM identity.agent_lifecycle_tombstones t
     WHERE t.agent_user_id = p_agent_user_id;

    RETURN v_payload;
END;
$$;
REVOKE ALL ON FUNCTION identity.build_agent_presence_payload(p_agent_user_id text) FROM PUBLIC;

-- fan_agent_presence_to_viewers is edited in place: its live body was rewritten inside the database by the
-- human user-events release (sends routed through chat.send_user_event), so no file holds it verbatim.
DO $migration$
DECLARE
    old_body TEXT;
    definition TEXT;
    anchor CONSTANT TEXT := E'jsonb_build_object(''agent_user_id'', p_agent_user_id),\n          COALESCE(p_payload ->> ''derived_status'', '''') = ''removed''';
BEGIN
    SELECT p.prosrc, pg_get_functiondef(p.oid) INTO old_body, definition
    FROM pg_proc p WHERE p.oid = 'identity.fan_agent_presence_to_viewers(text,jsonb)'::regprocedure;
    IF length(old_body) - length(replace(old_body, anchor, '')) <> length(anchor) THEN
        RAISE EXCEPTION 'expected one derived_status tombstone argument in fan_agent_presence_to_viewers';
    END IF;
    EXECUTE replace(definition, old_body, replace(old_body, anchor, 'jsonb_build_object(''agent_user_id'', p_agent_user_id)'));
END;
$migration$;
REVOKE ALL ON FUNCTION identity.fan_agent_presence_to_viewers(text, jsonb)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION identity.set_agent_desired_status(p_agent_user_id text, p_desired_status text) RETURNS identity.users
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'identity', 'public', 'pg_catalog'
    AS $$
DECLARE
    v_agent identity.users;
BEGIN
    IF p_desired_status NOT IN ('online', 'offline') THEN
        RAISE EXCEPTION 'Invalid agent desired status: %', p_desired_status;
    END IF;

    UPDATE identity.users
    SET desired_status = p_desired_status,
        updated_at = now()
    WHERE id = p_agent_user_id
      AND type = 'agent'
      AND owner_user_id = (SELECT auth.uid()::text)
    RETURNING *
    INTO v_agent;

    IF v_agent.id IS NULL THEN
        RAISE EXCEPTION 'Agent desired status is not writable by current user';
    END IF;

    IF p_desired_status = 'offline' AND v_agent.device_id IS NOT NULL THEN
        INSERT INTO identity.gugu_device_commands (
            user_id,
            device_id,
            type,
            payload
        )
        VALUES (
            v_agent.owner_user_id::uuid,
            v_agent.device_id,
            'agent.stop',
            jsonb_build_object('agent_user_id', v_agent.id)
        );
    END IF;

    PERFORM identity.fan_agent_presence_to_viewers(v_agent.id, identity.build_agent_presence_payload(v_agent.id));

    RETURN v_agent;
END;
$$;
REVOKE ALL ON FUNCTION identity.set_agent_desired_status(p_agent_user_id text, p_desired_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION identity.set_agent_desired_status(p_agent_user_id text, p_desired_status text) TO authenticated;
