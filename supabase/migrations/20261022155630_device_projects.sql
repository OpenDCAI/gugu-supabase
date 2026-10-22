-- Projects are recorded on the account, not only on the machine that holds them (OpenDCAI/gugu#113).
--
-- A project and its folders lived only in the SQLite database of the machine that holds them. Other desktops and the
-- phone kept their own caches, written only while that machine was online and they happened to ask; a machine that
-- was offline when a desktop first looked showed "can't read this project's folders", or no projects at all.
--
-- identity.device_projects holds one row per local project on a device: its name, root folder, creation time,
-- project group and folders. The device that holds the project is the only writer, through publish_device_projects, which replaces
-- that device's rows as one set. Only the account that owns the device reads them, and they go with the device
-- (ON DELETE CASCADE, like the other device tables). A change advances the owner's account revision as
-- device_changed, the same signal clients already follow for the device rows.

CREATE TABLE identity.device_projects (
    device_id text NOT NULL REFERENCES identity.gugu_devices (device_id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    local_project_id text NOT NULL,
    name text NOT NULL,
    root_path text NOT NULL,
    -- When the project was created on its device (clients list projects newest first).
    created_at timestamp with time zone NOT NULL,
    -- The project group this local project is bound to. Not a foreign key: the client reserves the group's id
    -- before the group chat exists.
    chat_id text,
    -- When several projects on this device are bound to the same group: the one that stands for the group here.
    group_representative boolean NOT NULL DEFAULT false,
    -- [{ "workspace_id", "kind": "root" | "attached", "path", "attached_at" }], root first.
    folders jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, local_project_id),
    CONSTRAINT device_projects_folders_array CHECK (jsonb_typeof(folders) = 'array')
);

CREATE INDEX device_projects_user_idx ON identity.device_projects (user_id);

ALTER TABLE identity.device_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY device_projects_owner_select ON identity.device_projects
    FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE identity.device_projects FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE identity.device_projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE identity.device_projects TO service_role;

-- Replace the projects of one of the caller's devices with p_projects:
-- [{ "local_project_id", "name", "root_path", "created_at", "chat_id" | null, "group_representative"?,
--    "folders": [{ "workspace_id", "kind", "path", "attached_at" | null }] }]. Projects missing from the list are deleted. Returns whether anything changed; the
-- account revision advances only then.
CREATE FUNCTION identity.publish_device_projects(p_device_id text, p_projects jsonb) RETURNS boolean
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

    DELETE FROM identity.device_projects d
     WHERE d.device_id = p_device_id
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(p_projects) p WHERE p.value ->> 'local_project_id' = d.local_project_id
       );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_rows > 0;

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
     WHERE (d.name, d.root_path, d.created_at, d.chat_id, d.group_representative, d.folders) IS DISTINCT FROM
           (EXCLUDED.name, EXCLUDED.root_path, EXCLUDED.created_at, EXCLUDED.chat_id, EXCLUDED.group_representative,
            EXCLUDED.folders);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_changed OR v_rows > 0;

    IF v_changed THEN
        PERFORM chat.publish_user_revision(v_me::text, 'device_changed', jsonb_build_object('device_id', p_device_id), false);
    END IF;
    RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION identity.publish_device_projects(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.publish_device_projects(text, jsonb) TO authenticated, service_role;
