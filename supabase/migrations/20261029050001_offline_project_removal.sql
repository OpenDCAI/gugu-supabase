-- OpenDCAI/gugu#900: owner intent survives an offline computer publishing an old snapshot.
-- The existing command ledger owns execution. The project row retains its last folder
-- snapshot for undo; this is not a second queue or a copy of task history.
ALTER TABLE identity.device_projects
    ADD COLUMN removal_requested_at timestamptz,
    ADD COLUMN removal_command_id uuid REFERENCES identity.gugu_device_commands(id) ON DELETE SET NULL;

ALTER TABLE identity.gugu_device_commands DROP CONSTRAINT gugu_device_commands_type_chk;
ALTER TABLE identity.gugu_device_commands ADD CONSTRAINT gugu_device_commands_type_chk CHECK (
    type = ANY (ARRAY['agent.create', 'agent.deliver', 'agent.wake', 'agent.stop',
                     'agent.runtime-info', 'agent.set_model', 'agent.retire', 'project.set_removed']::text[])
);

-- The optional third argument is the receiving runtime's actual handler set. Old
-- callers still use two arguments and cannot claim a new project operation.
DROP FUNCTION identity.fetch_fair_pending_device_commands(text, integer);
CREATE FUNCTION identity.fetch_fair_pending_device_commands(
    p_device_id text,
    p_per_agent integer DEFAULT 1,
    p_types text[] DEFAULT ARRAY['agent.create', 'agent.deliver', 'agent.wake', 'agent.stop',
                                'agent.runtime-info', 'agent.set_model', 'agent.retire']::text[]
) RETURNS SETOF identity.gugu_device_commands
LANGUAGE sql STABLE SET search_path TO '' AS $$
    SELECT c.* FROM identity.gugu_device_commands c
    WHERE c.id IN (
        SELECT ranked.id FROM (
            SELECT gc.id, gc.type,
                   row_number() OVER (
                       PARTITION BY CASE WHEN gc.type = 'project.set_removed'
                           THEN 'project:' || (gc.payload->>'project_id')
                           ELSE COALESCE('agent:' || (gc.payload->>'agent_user_id'), 'command:' || gc.id::text) END
                       ORDER BY gc.created_at, gc.id
                   ) AS position
            FROM identity.gugu_device_commands gc
            WHERE gc.device_id = p_device_id AND gc.status = 'pending' AND gc.type = ANY(p_types)
              AND (gc.type <> 'project.set_removed' OR NOT EXISTS (
                  SELECT 1 FROM identity.gugu_device_commands running
                  WHERE running.device_id = gc.device_id AND running.type = gc.type
                    AND running.payload->>'project_id' = gc.payload->>'project_id' AND running.status = 'running'
              ))
        ) ranked WHERE ranked.position <= CASE WHEN ranked.type = 'project.set_removed' THEN 1 ELSE GREATEST(p_per_agent, 1) END
    ) ORDER BY c.created_at, c.id;
$$;
REVOKE ALL ON FUNCTION identity.fetch_fair_pending_device_commands(text, integer, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.fetch_fair_pending_device_commands(text, integer, text[]) TO authenticated, service_role;

CREATE FUNCTION identity.set_device_project_removed(
    p_device_id text, p_project_id text, p_removed boolean, p_expected_command_id uuid DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE
    v_me uuid := auth.uid();
    v_before uuid;
    v_project identity.device_projects%ROWTYPE;
    v_previous identity.gugu_device_commands%ROWTYPE;
    v_command uuid;
BEGIN
    IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NULLIF(p_device_id, '') IS NULL OR NULLIF(p_project_id, '') IS NULL OR p_removed IS NULL THEN
        RAISE EXCEPTION 'Device, project and removal choice are required';
    END IF;
    SELECT removal_command_id INTO v_before FROM identity.device_projects
    WHERE user_id = v_me AND device_id = p_device_id AND local_project_id = p_project_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Project not found on this account'; END IF;
    -- Same global order as account cleanup: command before device, then project.
    IF v_before IS NOT NULL THEN
        SELECT * INTO v_previous FROM identity.gugu_device_commands
        WHERE id = v_before AND user_id = v_me FOR UPDATE;
    END IF;
    PERFORM 1 FROM identity.gugu_devices
    WHERE device_id = p_device_id AND user_id = v_me FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Device is not owned by current user'; END IF;
    SELECT * INTO v_project FROM identity.device_projects
    WHERE user_id = v_me AND device_id = p_device_id AND local_project_id = p_project_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Project not found on this account'; END IF;
    IF v_project.removal_command_id IS DISTINCT FROM v_before THEN
        RAISE EXCEPTION 'Project changed while removal was being requested; try again';
    END IF;
    IF NOT p_removed THEN
        IF v_project.removal_requested_at IS NULL AND v_before IS NULL THEN RETURN NULL; END IF;
        IF p_expected_command_id IS NULL THEN RAISE EXCEPTION 'Undo requires the removal command'; END IF;
        IF v_project.removal_requested_at IS NULL AND v_previous.payload->>'undo_of' = p_expected_command_id::text THEN
            IF v_previous.status IN ('pending', 'running', 'done') THEN RETURN v_before; END IF;
        ELSIF v_project.removal_requested_at IS NULL OR v_before IS DISTINCT FROM p_expected_command_id THEN
            RAISE EXCEPTION 'A newer project request superseded this undo';
        END IF;
    ELSIF v_project.removal_requested_at IS NOT NULL AND v_previous.status IN ('pending', 'running', 'done') THEN
        RETURN v_before;
    END IF;
    -- Cancel only unclaimed work. A running removal settles before its queued undo.
    UPDATE identity.gugu_device_commands SET status = 'error', error = 'Superseded by the owner', completed_at = now()
    WHERE id = v_before AND user_id = v_me AND status = 'pending';
    INSERT INTO identity.gugu_device_commands (user_id, device_id, type, payload)
    VALUES (v_me, p_device_id, 'project.set_removed', jsonb_build_object(
        'project_id', p_project_id, 'removed', p_removed, 'folders', v_project.folders,
        'undo_of', CASE WHEN NOT p_removed THEN p_expected_command_id ELSE NULL END
    )) RETURNING id INTO v_command;
    UPDATE identity.device_projects SET
        removal_requested_at = CASE WHEN p_removed THEN COALESCE(removal_requested_at, now()) ELSE NULL END,
        removal_command_id = v_command, updated_at = now()
    WHERE device_id = p_device_id AND local_project_id = p_project_id AND user_id = v_me;
    PERFORM chat.publish_user_revision(v_me::text, 'device_changed',
        jsonb_build_object('device_id', p_device_id, 'kind', 'projects'), false);
    RETURN v_command;
END;
$$;
REVOKE ALL ON FUNCTION identity.set_device_project_removed(text, text, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.set_device_project_removed(text, text, boolean, uuid) TO authenticated;

-- Release the snapshot only after a successful undo, never after a failed apply.
-- Completed removals retain their original snapshot for a later undo.
CREATE FUNCTION identity.settle_device_project_removal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
    IF NEW.type = 'project.set_removed' AND NEW.status IN ('done', 'error') AND NEW.status IS DISTINCT FROM OLD.status THEN
        UPDATE identity.device_projects SET
            removal_command_id = CASE WHEN NEW.status = 'done' AND removal_requested_at IS NULL THEN NULL ELSE removal_command_id END,
            updated_at = now()
        WHERE device_id = NEW.device_id AND user_id = NEW.user_id
          AND local_project_id = NEW.payload->>'project_id' AND removal_command_id = NEW.id;
        IF FOUND THEN
            PERFORM chat.publish_user_revision(NEW.user_id::text, 'device_changed',
                jsonb_build_object('device_id', NEW.device_id, 'kind', 'projects'), false);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.settle_device_project_removal() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER settle_device_project_removal
AFTER UPDATE OF status ON identity.gugu_device_commands
FOR EACH ROW EXECUTE FUNCTION identity.settle_device_project_removal();

-- publish_device_projects is replaced below only to preserve the owner's snapshot
-- while a removal is requested or its undo has not completed.

-- New publishers read completed removal ids BEFORE reading local records. A row
-- appearing in that fresh read is an independent local Restore/new attachment.
-- Old or pre-cleanup publications have no matching acknowledgment and stay held.
DROP FUNCTION identity.publish_device_projects(text, jsonb);
CREATE FUNCTION identity.publish_device_projects(
    p_device_id text, p_projects jsonb, p_applied_removals jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_me uuid := auth.uid();
    v_changed boolean := false;
    v_rows integer;
    v_project jsonb;
    v_folder jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NULLIF(p_device_id, '') IS NULL THEN
        RAISE EXCEPTION 'Device is required';
    END IF;
    -- The row lock serializes two publishes from the same device. NO KEY keeps it from blocking the
    -- FOR KEY SHARE that inserts into tables referencing the device take.
    PERFORM 1 FROM identity.gugu_devices WHERE device_id = p_device_id AND user_id = v_me FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Device is not owned by current user';
    END IF;

    IF p_projects IS NULL OR jsonb_typeof(p_projects) <> 'array' THEN
        RAISE EXCEPTION 'Projects must be an array';
    END IF;
    IF jsonb_array_length(p_projects) > 1000 THEN
        RAISE EXCEPTION 'A device publishes at most 1000 projects';
    END IF;
    IF p_applied_removals IS NULL OR jsonb_typeof(p_applied_removals) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(p_applied_removals)) > 1000
       OR EXISTS (SELECT 1 FROM jsonb_each(p_applied_removals) e WHERE jsonb_typeof(e.value) <> 'string') THEN
        RAISE EXCEPTION 'Applied removals must be a project to command map';
    END IF;
    FOR v_project IN SELECT value FROM jsonb_array_elements(p_projects) LOOP
        IF jsonb_typeof(v_project) <> 'object'
           OR jsonb_typeof(v_project -> 'local_project_id') IS DISTINCT FROM 'string' OR v_project ->> 'local_project_id' = ''
           OR jsonb_typeof(v_project -> 'name') IS DISTINCT FROM 'string'
           OR jsonb_typeof(v_project -> 'root_path') IS DISTINCT FROM 'string' OR v_project ->> 'root_path' = ''
           OR (v_project ? 'chat_id' AND jsonb_typeof(v_project -> 'chat_id') NOT IN ('string', 'null'))
           OR (v_project ? 'group_representative' AND jsonb_typeof(v_project -> 'group_representative') <> 'boolean')
           OR jsonb_typeof(v_project -> 'folders') IS DISTINCT FROM 'array'
           OR jsonb_typeof(v_project -> 'created_at') IS DISTINCT FROM 'string' THEN
            RAISE EXCEPTION 'Invalid project %', left(v_project::text, 200);
        END IF;
        BEGIN
            PERFORM (v_project ->> 'created_at')::timestamp with time zone;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
            RAISE EXCEPTION 'Invalid project %', left(v_project::text, 200);
        END;
        IF jsonb_array_length(v_project -> 'folders') > 1000 THEN
            RAISE EXCEPTION 'A project publishes at most 1000 folders';
        END IF;
        FOR v_folder IN SELECT value FROM jsonb_array_elements(v_project -> 'folders') LOOP
            IF jsonb_typeof(v_folder) <> 'object'
               OR jsonb_typeof(v_folder -> 'workspace_id') IS DISTINCT FROM 'string' OR v_folder ->> 'workspace_id' = ''
               OR (v_folder ->> 'kind') IS DISTINCT FROM 'root' AND (v_folder ->> 'kind') IS DISTINCT FROM 'attached'
               OR jsonb_typeof(v_folder -> 'path') IS DISTINCT FROM 'string' OR v_folder ->> 'path' = ''
               OR (v_folder ? 'attached_at' AND jsonb_typeof(v_folder -> 'attached_at') NOT IN ('string', 'null')) THEN
                RAISE EXCEPTION 'Invalid folder %', left(v_folder::text, 200);
            END IF;
        END LOOP;
    END LOOP;
    IF (SELECT count(DISTINCT value ->> 'local_project_id') FROM jsonb_array_elements(p_projects))
       <> jsonb_array_length(p_projects) THEN
        RAISE EXCEPTION 'Each project is published once';
    END IF;

    UPDATE identity.device_projects d SET removal_requested_at = NULL, removal_command_id = NULL, updated_at = now()
    FROM identity.gugu_device_commands c
    WHERE d.device_id = p_device_id AND d.user_id = v_me AND d.removal_requested_at IS NOT NULL
      AND c.id = d.removal_command_id AND c.user_id = v_me AND c.status = 'done'
      AND c.type = 'project.set_removed' AND c.payload->>'removed' = 'true'
      AND p_applied_removals->>d.local_project_id = c.id::text
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_projects) p WHERE p.value->>'local_project_id' = d.local_project_id);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_rows > 0;

    DELETE FROM identity.device_projects d
     WHERE d.device_id = p_device_id
       AND d.removal_requested_at IS NULL AND d.removal_command_id IS NULL
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(p_projects) p WHERE p.value ->> 'local_project_id' = d.local_project_id
       );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_changed OR v_rows > 0;

    -- Folders are stored with exactly the four keys, so a row compares equal when nothing a reader sees changed.
    INSERT INTO identity.device_projects AS d
           (device_id, user_id, local_project_id, name, root_path, created_at, chat_id, group_representative, folders)
    SELECT p_device_id, v_me, p.value ->> 'local_project_id', p.value ->> 'name', p.value ->> 'root_path',
           (p.value ->> 'created_at')::timestamp with time zone, p.value ->> 'chat_id',
           COALESCE((p.value -> 'group_representative')::boolean, false),
           (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'workspace_id', f.value ->> 'workspace_id',
                       'kind', f.value ->> 'kind',
                       'path', f.value ->> 'path',
                       'attached_at', f.value -> 'attached_at'
                   ) ORDER BY f.ordinality), '[]'::jsonb)
              FROM jsonb_array_elements(p.value -> 'folders') WITH ORDINALITY f)
      FROM jsonb_array_elements(p_projects) p
    ON CONFLICT (device_id, local_project_id) DO UPDATE
       SET name = EXCLUDED.name,
           root_path = EXCLUDED.root_path,
           created_at = EXCLUDED.created_at,
           chat_id = EXCLUDED.chat_id,
           group_representative = EXCLUDED.group_representative,
           folders = EXCLUDED.folders,
           updated_at = now()
     WHERE d.removal_requested_at IS NULL AND d.removal_command_id IS NULL
       AND (d.name, d.root_path, d.created_at, d.chat_id, d.group_representative, d.folders) IS DISTINCT FROM
           (EXCLUDED.name, EXCLUDED.root_path, EXCLUDED.created_at, EXCLUDED.chat_id, EXCLUDED.group_representative,
            EXCLUDED.folders);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_changed OR v_rows > 0;

    IF v_changed THEN
        PERFORM chat.publish_user_revision(v_me::text, 'device_changed', jsonb_build_object('device_id', p_device_id, 'kind', 'projects'), false);
    END IF;
    RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION identity.publish_device_projects(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.publish_device_projects(text, jsonb, jsonb) TO authenticated, service_role;
