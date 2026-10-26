-- The panel is durable account state, independent of an execution host.
-- A committed edit and the instruction to apply it are one transaction.
CREATE TABLE identity.assistant_panel_items (
    assistant_user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    owner_user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    domain text NOT NULL CHECK (domain IN ('control','tasks','schedules','memory','personality','integrations','voice-notes','capabilities','device-notes','files','skills')),
    resource_key text NOT NULL CHECK (length(resource_key) BETWEEN 1 AND 512),
    device_id text,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    data jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
    body_item_id uuid REFERENCES chat.workspace_items(id) ON DELETE SET NULL,
    body_sha256 text CHECK (body_sha256 IS NULL OR body_sha256 ~ '^[0-9a-f]{64}$'),
    deleted_at timestamptz,
    observed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (assistant_user_id, domain, resource_key),
    CHECK (body_item_id IS NULL OR body_sha256 IS NOT NULL)
);
CREATE UNIQUE INDEX assistant_panel_body_owner ON identity.assistant_panel_items(body_item_id)
    WHERE body_item_id IS NOT NULL;

CREATE TABLE identity.assistant_panel_changes (
    operation_id uuid PRIMARY KEY,
    revision bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    assistant_user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    owner_user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    domain text NOT NULL,
    resource_key text NOT NULL,
    device_id text,
    source text NOT NULL CHECK (source IN ('panel','runtime')),
    operation text NOT NULL CHECK (operation IN ('save','remove','enable','disable','prepared','error')),
    expected_item_revision bigint NOT NULL,
    request_hash text NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    status text NOT NULL CHECK (status IN ('pending','applied','failed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    applied_at timestamptz,
    applied_device_id text,
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
CREATE INDEX assistant_panel_pending ON identity.assistant_panel_changes(assistant_user_id, revision)
    WHERE source = 'panel' AND status <> 'applied';
CREATE INDEX assistant_panel_resource_history ON identity.assistant_panel_changes(assistant_user_id,domain,resource_key,revision);
CREATE INDEX assistant_panel_body_history ON identity.assistant_panel_changes((payload->>'bodyItemId'));

-- Used by RLS as well as RPCs; never reveal whether somebody else's agent exists.
CREATE FUNCTION identity.assistant_panel_is_owner(p_assistant text, p_owner text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT p_owner = auth.uid()::text AND EXISTS (
        SELECT 1 FROM identity.users u
        JOIN identity.agent_provisions p ON p.agent_user_id = u.id
        WHERE u.id = p_assistant AND u.type = 'agent' AND u.owner_user_id = p_owner
          AND p.owner_user_id = p_owner AND p.member_key = 'assistant'
          AND p.phase IN ('ready','completed')
    );
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_is_owner(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_panel_is_owner(text,text) TO authenticated;

ALTER TABLE identity.assistant_panel_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.assistant_panel_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.assistant_panel_items, identity.assistant_panel_changes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON identity.assistant_panel_items, identity.assistant_panel_changes TO authenticated;
CREATE POLICY assistant_panel_items_owner ON identity.assistant_panel_items FOR SELECT TO authenticated
    USING (identity.assistant_panel_is_owner(assistant_user_id, owner_user_id));
CREATE POLICY assistant_panel_changes_owner ON identity.assistant_panel_changes FOR SELECT TO authenticated
    USING (identity.assistant_panel_is_owner(assistant_user_id, owner_user_id));

-- Internal helpers have no API grants. The control row serializes allocation,
-- publication, acknowledgements and admission for one assistant.
CREATE FUNCTION identity.assistant_panel_lock(p_assistant text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := auth.uid()::text;
BEGIN
    IF NOT COALESCE(identity.assistant_panel_is_owner(p_assistant, v_owner), false) THEN
        RAISE EXCEPTION 'Personal assistant is not available to this account' USING ERRCODE = '42501';
    END IF;
    -- A move cannot change the home between checking its writer and commit.
    PERFORM 1 FROM identity.users WHERE id = p_assistant FOR SHARE;
    INSERT INTO identity.assistant_panel_items(assistant_user_id, owner_user_id, domain, resource_key)
        VALUES (p_assistant, v_owner, 'control', '__head__') ON CONFLICT DO NOTHING;
    PERFORM 1 FROM identity.assistant_panel_items
        WHERE assistant_user_id = p_assistant AND domain = 'control' AND resource_key = '__head__' FOR UPDATE;
    RETURN v_owner;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_lock(text) FROM PUBLIC, anon, authenticated;

-- Reuse the runtime lease; a still-live writer cannot be taken over. Moving the
-- assistant rejects its former home even if that old instance is still alive.
CREATE FUNCTION identity.assistant_panel_runtime(p_assistant text, p_instance text, p_home_only boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_device text; v_home text; v_prior text; v_owner text := auth.uid()::text;
BEGIN
    SELECT i.device_id INTO v_device FROM identity.runtime_instances i
      JOIN identity.gugu_devices d ON d.device_id = i.device_id AND d.user_id = i.owner_user_id
      WHERE i.instance_id = p_instance AND i.owner_user_id::text = v_owner
        AND i.last_heartbeat_at > clock_timestamp() - interval '90 seconds';
    SELECT device_id INTO v_home FROM identity.users WHERE id = p_assistant;
    IF v_device IS NULL OR (p_home_only AND v_device IS DISTINCT FROM v_home) THEN
        RAISE EXCEPTION 'Assistant publisher is not a current runtime on the required device' USING ERRCODE = '42501';
    END IF;
    SELECT data->'publishers'->>v_device INTO v_prior FROM identity.assistant_panel_items
      WHERE assistant_user_id = p_assistant AND domain = 'control' AND resource_key = '__head__';
    IF v_prior IS DISTINCT FROM p_instance AND EXISTS (
        SELECT 1 FROM identity.runtime_instances WHERE instance_id = v_prior
          AND owner_user_id::text = v_owner AND device_id = v_device
          AND last_heartbeat_at > clock_timestamp() - interval '90 seconds'
    ) THEN
        RAISE EXCEPTION 'Assistant publisher still has an active lease' USING ERRCODE = '55000';
    END IF;
    UPDATE identity.assistant_panel_items SET data = jsonb_set(data, '{publishers}',
        COALESCE(data->'publishers', '{}'::jsonb) || jsonb_build_object(v_device, p_instance))
      WHERE assistant_user_id = p_assistant AND domain = 'control' AND resource_key = '__head__';
    RETURN v_device;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_runtime(text,text,boolean) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION identity.assistant_panel_validate(p_domain text, p_key text, p_data jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE v_keys text[];
BEGIN
    IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
        RAISE EXCEPTION 'Panel data must be an object' USING ERRCODE = '22023';
    END IF;
    v_keys := CASE WHEN p_key = '__collection__' OR starts_with(p_key,'__collection__:') THEN ARRAY['state','schemaVersion','itemCount','errorCode'] ELSE CASE p_domain
        WHEN 'tasks' THEN ARRAY['agentId','sessionId','parentSessionId','assistantSessionIds','chatId','title','createdAt','lastInteractedAt','status','statusDetail','statusObservedAt','sourceLinks']
        WHEN 'schedules' THEN ARRAY['title','prompt','at','cron','tz','enabled','nextRunAt','lastRun']
        WHEN 'memory' THEN ARRAY['title','path','relativePath','createdAt','modifiedAt','kind']
        WHEN 'personality' THEN ARRAY['preset','text']
        WHEN 'integrations' THEN ARRAY['providerId','accountId','displayName','configured','isDefault','checkResult','checkedAt','permission','enabled']
        WHEN 'voice-notes' THEN ARRAY['noteId','kind','title','createdAt','updatedAt','status','phase','durationMs','startMs','voicedMs','failureCode']
        WHEN 'capabilities' THEN ARRAY['name','description','group','modifiedAt','contentFormat']
        WHEN 'device-notes' THEN ARRAY['name','description','group','modifiedAt','contentFormat']
        WHEN 'files' THEN ARRAY['name','path','parentKey','kind','contentType','sizeBytes','modifiedAt']
        WHEN 'skills' THEN ARRAY['name','description','modifiedAt']
        ELSE NULL END END;
    IF v_keys IS NULL OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_data) k WHERE NOT k = ANY(v_keys)) THEN
        RAISE EXCEPTION 'Panel data has unsupported fields' USING ERRCODE = '22023';
    END IF;
    -- Metadata is scalar except for explicitly structured task/schedule references.
    IF EXISTS (SELECT 1 FROM jsonb_each(p_data) e
        WHERE jsonb_typeof(e.value) IN ('object','array') AND e.key NOT IN ('assistantSessionIds','sourceLinks','lastRun')) THEN
        RAISE EXCEPTION 'Panel metadata must not contain nested configuration' USING ERRCODE = '22023';
    END IF;
    IF p_data ? 'enabled' AND jsonb_typeof(p_data->'enabled') <> 'boolean' THEN
        RAISE EXCEPTION 'Panel enabled must be boolean' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(p_data) e WHERE e.key IN ('configured','isDefault')
        AND jsonb_typeof(e.value) <> 'boolean') OR EXISTS (
        SELECT 1 FROM jsonb_each(p_data) e WHERE e.key IN ('errorCode','failureCode') AND e.value <> 'null'::jsonb
          AND (jsonb_typeof(e.value) <> 'string' OR e.value #>> '{}' !~ '^[A-Z][A-Z0-9_]{0,63}$')
    ) THEN
        RAISE EXCEPTION 'Panel metadata has an invalid boolean or non-sensitive error code' USING ERRCODE = '22023';
    END IF;
    IF (p_key = '__collection__' OR starts_with(p_key,'__collection__:')) AND (COALESCE(p_data->>'state','') NOT IN ('ready','error')
        OR p_data->>'schemaVersion' IS DISTINCT FROM '1') THEN
        RAISE EXCEPTION 'Panel collection state is invalid' USING ERRCODE = '22023';
    END IF;
    IF p_data ? 'lastRun' AND p_data->'lastRun' <> 'null'::jsonb THEN
        IF jsonb_typeof(p_data->'lastRun') <> 'object' OR EXISTS (
            SELECT 1 FROM jsonb_each(p_data->'lastRun') e WHERE e.key NOT IN ('status','at','errorCode')
              OR jsonb_typeof(e.value) IN ('object','array')
        ) THEN
            RAISE EXCEPTION 'Panel last run must contain only status, time and error code' USING ERRCODE = '22023';
        END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(p_data) e WHERE e.key IN ('assistantSessionIds','sourceLinks')
        AND jsonb_typeof(e.value) <> 'array') OR EXISTS (
        SELECT 1 FROM jsonb_each(p_data) e CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN e.key IN ('assistantSessionIds','sourceLinks') AND jsonb_typeof(e.value) = 'array' THEN e.value ELSE '[]'::jsonb END
        ) v WHERE jsonb_typeof(v) <> 'string'
    ) THEN
        RAISE EXCEPTION 'Panel task references must be string arrays' USING ERRCODE = '22023';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_validate(text,text,jsonb) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION identity.assistant_panel_commit(
    p_assistant text, p_operation_id uuid, p_domain text, p_resource_key text,
    p_expected_revision bigint, p_operation text, p_data jsonb DEFAULT '{}',
    p_body_item_id uuid DEFAULT NULL, p_body_sha256 text DEFAULT NULL,
    p_device_id text DEFAULT NULL, p_runtime_instance_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_owner text; v_device text; v_source text; v_hash text; v_revision bigint;
    v_old identity.assistant_panel_items%ROWTYPE;
    v_existing identity.assistant_panel_changes%ROWTYPE;
    v_data jsonb := p_data; v_payload jsonb; v_body uuid; v_collection boolean;
BEGIN
    v_owner := identity.assistant_panel_lock(p_assistant);
    v_source := CASE WHEN p_runtime_instance_id IS NULL THEN 'panel' ELSE 'runtime' END;
    v_collection := p_resource_key = '__collection__' OR starts_with(p_resource_key,'__collection__:');
    IF p_operation_id IS NULL OR p_data IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
       OR p_domain IS NULL OR p_domain NOT IN ('tasks','schedules','memory','personality','integrations','voice-notes','capabilities','device-notes','files','skills')
       OR p_resource_key IS NULL OR length(p_resource_key) NOT BETWEEN 1 AND 512
       OR p_operation IS NULL OR p_operation NOT IN ('save','remove','enable','disable','prepared','error') THEN
        RAISE EXCEPTION 'Invalid panel operation' USING ERRCODE = '22023';
    END IF;
    IF p_device_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM identity.gugu_devices
        WHERE device_id = p_device_id AND user_id::text = v_owner) THEN
        RAISE EXCEPTION 'Panel resource device is not owned by this account' USING ERRCODE = '42501';
    END IF;
    IF v_source = 'runtime' THEN
        v_device := identity.assistant_panel_runtime(p_assistant, p_runtime_instance_id,
            p_domain NOT IN ('tasks','capabilities','device-notes','integrations'));
        IF p_device_id IS NOT NULL AND p_device_id <> v_device THEN
            RAISE EXCEPTION 'Runtime cannot publish another device resource' USING ERRCODE = '42501';
        END IF;
    END IF;
    IF starts_with(p_resource_key,'__collection__:') AND p_resource_key IS DISTINCT FROM '__collection__:' || p_device_id THEN
        RAISE EXCEPTION 'Panel collection key must identify its resource device' USING ERRCODE = '22023';
    END IF;
    IF v_collection AND (v_source <> 'runtime' OR p_operation NOT IN ('prepared','error'))
       OR NOT v_collection AND p_operation IN ('prepared','error')
       OR p_operation IN ('enable','disable') AND p_domain NOT IN ('schedules','integrations') THEN
        RAISE EXCEPTION 'Panel operation does not match its resource' USING ERRCODE = '22023';
    END IF;
    v_hash := encode(sha256(convert_to(jsonb_build_array(p_assistant,p_domain,p_resource_key,
        p_expected_revision,p_operation,p_data,p_body_item_id,p_body_sha256,p_device_id,v_source)::text, 'UTF8')), 'hex');
    SELECT * INTO v_existing FROM identity.assistant_panel_changes WHERE operation_id = p_operation_id;
    IF FOUND THEN
        IF v_existing.owner_user_id <> v_owner OR v_existing.assistant_user_id <> p_assistant OR v_existing.request_hash <> v_hash THEN
            RAISE EXCEPTION 'Panel operation ID was already used for a different request' USING ERRCODE = '23505';
        END IF;
        RETURN jsonb_build_object('operationId',p_operation_id,'revision',v_existing.revision::text,'status',v_existing.status);
    END IF;
    SELECT * INTO v_old FROM identity.assistant_panel_items
      WHERE assistant_user_id = p_assistant AND domain = p_domain AND resource_key = p_resource_key;
    IF COALESCE(v_old.revision,0) <> p_expected_revision THEN
        RAISE EXCEPTION 'Panel resource changed; read it again before editing' USING ERRCODE = '40001';
    END IF;
    IF v_source = 'runtime' AND v_old.device_id IS NOT NULL AND v_old.device_id <> v_device THEN
        RAISE EXCEPTION 'Runtime cannot replace another device resource' USING ERRCODE = '42501';
    END IF;
    IF v_old.deleted_at IS NOT NULL AND p_operation <> 'remove' THEN
        RAISE EXCEPTION 'Panel resource was deleted and cannot be republished' USING ERRCODE = '55000';
    END IF;
    IF v_source = 'runtime' AND EXISTS (SELECT 1 FROM identity.assistant_panel_changes
        WHERE assistant_user_id = p_assistant AND domain = p_domain AND resource_key = p_resource_key
          AND source = 'panel' AND status <> 'applied') THEN
        RAISE EXCEPTION 'Apply the committed panel change before publishing this resource' USING ERRCODE = '55000';
    END IF;
    IF p_operation IN ('enable','disable') THEN
        IF v_old.assistant_user_id IS NULL OR p_data <> '{}' OR p_body_item_id IS NOT NULL OR p_body_sha256 IS NOT NULL THEN
            RAISE EXCEPTION 'Panel toggle requires an existing resource and no replacement data' USING ERRCODE = '22023';
        END IF;
        v_data := v_old.data || jsonb_build_object('enabled', p_operation = 'enable');
    ELSIF p_operation = 'remove' THEN
        IF p_data <> '{}' OR p_body_item_id IS NOT NULL OR p_body_sha256 IS NOT NULL THEN
            RAISE EXCEPTION 'Panel deletion must not include resource content' USING ERRCODE = '22023';
        END IF;
        v_data := '{}';
    END IF;
    PERFORM identity.assistant_panel_validate(p_domain, p_resource_key, v_data);
    IF p_operation = 'prepared' THEN
        IF p_data->>'state' IS DISTINCT FROM 'ready' OR jsonb_typeof(p_data->'itemCount') IS DISTINCT FROM 'number'
           OR p_data->>'itemCount' !~ '^[0-9]+$' OR (p_data->>'itemCount')::bigint <> (
               SELECT count(*) FROM identity.assistant_panel_items WHERE assistant_user_id = p_assistant
                 AND domain = p_domain AND resource_key <> '__collection__' AND NOT starts_with(resource_key,'__collection__:') AND deleted_at IS NULL
                 AND (p_resource_key = '__collection__' OR device_id = p_device_id)
           ) THEN
            RAISE EXCEPTION 'Panel collection is not a complete enumerated snapshot' USING ERRCODE = '22023';
        END IF;
    ELSIF p_operation = 'error' AND p_data->>'state' IS DISTINCT FROM 'error' THEN
        RAISE EXCEPTION 'Panel read failure must retain an error state' USING ERRCODE = '22023';
    END IF;
    IF (p_body_item_id IS NULL) <> (p_body_sha256 IS NULL) OR
       (p_body_sha256 IS NOT NULL AND p_body_sha256 !~ '^[0-9a-f]{64}$') THEN
        RAISE EXCEPTION 'Panel body requires its ID and SHA-256' USING ERRCODE = '22023';
    END IF;
    IF p_body_item_id IS NOT NULL THEN
        -- Pin the row until the reference is committed. Otherwise a concurrent
        -- file replacement could race hash verification before immutability applies.
        PERFORM 1 FROM chat.workspace_items w JOIN chat.chats c ON c.id = w.chat_id
        JOIN chat.file_blobs b ON b.id = w.blob_id AND b.sha256 = p_body_sha256
        JOIN chat.chat_members m ON m.chat_id = c.id AND m.user_id = v_owner
        JOIN chat.chat_members a ON a.chat_id = c.id AND a.user_id = p_assistant
        WHERE w.id = p_body_item_id AND w.kind = 'file' AND c.kind = 'dm'
          AND NOT EXISTS (SELECT 1 FROM chat.chat_members other WHERE other.chat_id = c.id AND other.user_id NOT IN (v_owner,p_assistant))
          AND EXISTS (SELECT 1 FROM identity.agent_provisions p WHERE p.agent_user_id = p_assistant AND p.dm_chat_id = c.id AND p.owner_user_id = v_owner)
        FOR SHARE OF w;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Panel body requires a matching file hash in the owner and assistant private folder' USING ERRCODE = '42501';
        END IF;
    END IF;
    IF p_body_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM identity.assistant_panel_changes
        WHERE payload->>'bodyItemId' = p_body_item_id::text
          AND (assistant_user_id <> p_assistant OR domain <> p_domain OR resource_key <> p_resource_key)) THEN
        RAISE EXCEPTION 'Panel body already belongs to another resource' USING ERRCODE = '22023';
    END IF;
    v_payload := jsonb_build_object('data',v_data,'bodyItemId',p_body_item_id,'bodySha256',p_body_sha256,
        'deviceId',COALESCE(p_device_id,v_old.device_id,v_device));
    IF p_operation = 'remove' THEN
        -- Keep routing for local cleanup, never the deleted body or personality text.
        v_payload := jsonb_build_object('before', jsonb_strip_nulls(jsonb_build_object(
            'path',v_old.data->'path','relativePath',v_old.data->'relativePath',
            'providerId',v_old.data->'providerId','accountId',v_old.data->'accountId',
            'kind',v_old.data->'kind','noteId',v_old.data->'noteId')),
        'deviceId',COALESCE(v_old.device_id,p_device_id,v_device),'deleted',true);
    END IF;
    INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,domain,resource_key,
        device_id,source,operation,expected_item_revision,request_hash,payload,status,applied_at,applied_device_id)
      VALUES (p_operation_id,p_assistant,v_owner,p_domain,p_resource_key,COALESCE(p_device_id,v_old.device_id,v_device),
        v_source,p_operation,p_expected_revision,v_hash,v_payload,
        CASE WHEN v_source = 'runtime' THEN 'applied' ELSE 'pending' END,
        CASE WHEN v_source = 'runtime' THEN clock_timestamp() END,v_device) RETURNING revision INTO v_revision;
    INSERT INTO identity.assistant_panel_items(assistant_user_id,owner_user_id,domain,resource_key,device_id,
        revision,data,body_item_id,body_sha256,deleted_at,observed_at)
      VALUES (p_assistant,v_owner,p_domain,p_resource_key,COALESCE(p_device_id,v_old.device_id,v_device),v_revision,v_data,
        CASE WHEN p_operation IN ('enable','disable') THEN v_old.body_item_id ELSE p_body_item_id END,
        CASE WHEN p_operation IN ('enable','disable') THEN v_old.body_sha256 ELSE p_body_sha256 END,
        CASE WHEN p_operation = 'remove' THEN COALESCE(v_old.deleted_at,clock_timestamp()) END,
        CASE WHEN v_source = 'runtime' THEN clock_timestamp() ELSE v_old.observed_at END)
      ON CONFLICT (assistant_user_id,domain,resource_key) DO UPDATE SET device_id = EXCLUDED.device_id,
        revision = EXCLUDED.revision,data = EXCLUDED.data,body_item_id = EXCLUDED.body_item_id,body_sha256 = EXCLUDED.body_sha256,
        deleted_at = EXCLUDED.deleted_at,observed_at = EXCLUDED.observed_at,updated_at = clock_timestamp();
    IF p_operation = 'remove' THEN
        FOR v_body IN SELECT DISTINCT (payload->>'bodyItemId')::uuid FROM identity.assistant_panel_changes
          WHERE assistant_user_id = p_assistant AND domain = p_domain AND resource_key = p_resource_key
            AND payload->>'bodyItemId' IS NOT NULL
        LOOP
            IF EXISTS (SELECT 1 FROM chat.workspace_items WHERE id = v_body) THEN
                PERFORM chat.workspace_delete_as(v_body::text, v_owner);
            END IF;
        END LOOP;
    END IF;
    UPDATE identity.assistant_panel_items SET revision = v_revision,updated_at = clock_timestamp()
      WHERE assistant_user_id = p_assistant AND domain = 'control' AND resource_key = '__head__';
    -- Transactional wake hints only: no message, model turn, or device command.
    PERFORM chat.send_user_event(jsonb_build_object('assistantId',p_assistant,'revision',v_revision::text),
        'assistant_panel_changed','gugu:user:' || v_owner || ':events',true);
    RETURN jsonb_build_object('operationId',p_operation_id,'revision',v_revision::text,
        'status',CASE WHEN v_source = 'runtime' THEN 'applied' ELSE 'pending' END);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_commit(text,uuid,text,text,bigint,text,jsonb,uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_panel_commit(text,uuid,text,text,bigint,text,jsonb,uuid,text,text,text) TO authenticated;

CREATE FUNCTION identity.assistant_panel_snapshot(p_assistant text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text := auth.uid()::text; v_result jsonb;
BEGIN
    IF NOT COALESCE(identity.assistant_panel_is_owner(p_assistant,v_owner),false) THEN
        RAISE EXCEPTION 'Personal assistant is not available to this account' USING ERRCODE = '42501';
    END IF;
    SELECT jsonb_build_object('version',1,'revision',COALESCE((SELECT revision::text FROM identity.assistant_panel_items
        WHERE assistant_user_id = p_assistant AND domain = 'control' AND resource_key = '__head__'),'0'),
        'items',COALESCE((SELECT jsonb_agg(to_jsonb(i) || jsonb_build_object('revision',i.revision::text) ORDER BY domain,resource_key) FROM identity.assistant_panel_items i
            WHERE assistant_user_id = p_assistant AND domain <> 'control'),'[]'::jsonb),
        'application',COALESCE((SELECT jsonb_agg(jsonb_build_object('operationId',operation_id,'revision',revision::text,
            'domain',domain,'resourceKey',resource_key,'status',status,'errorCode',error_code) ORDER BY revision)
            FROM identity.assistant_panel_changes WHERE assistant_user_id = p_assistant AND source = 'panel' AND status <> 'applied'),'[]'::jsonb)) INTO v_result;
    IF octet_length(v_result::text) > 16777216 THEN
        RAISE EXCEPTION 'Assistant panel snapshot exceeds the complete response budget' USING ERRCODE = '54000';
    END IF;
    RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_snapshot(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_panel_snapshot(text) TO authenticated;

CREATE FUNCTION identity.assistant_panel_pending(p_assistant text, p_runtime_instance_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text; v_result jsonb;
BEGIN
    v_owner := identity.assistant_panel_lock(p_assistant);
    PERFORM identity.assistant_panel_runtime(p_assistant,p_runtime_instance_id,true);
    SELECT jsonb_build_object('revision',h.revision::text,'changes',COALESCE((SELECT jsonb_agg(to_jsonb(c) ||
        jsonb_build_object('revision',c.revision::text,'expected_item_revision',c.expected_item_revision::text) ORDER BY revision)
        FROM identity.assistant_panel_changes c WHERE assistant_user_id = p_assistant AND source = 'panel' AND status <> 'applied'),'[]'::jsonb))
      INTO v_result FROM identity.assistant_panel_items h
      WHERE assistant_user_id = p_assistant AND domain = 'control' AND resource_key = '__head__';
    IF octet_length(v_result::text) > 16777216 THEN
        RAISE EXCEPTION 'Assistant pending changes exceed the complete response budget' USING ERRCODE = '54000';
    END IF;
    RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_pending(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_panel_pending(text,text) TO authenticated;

CREATE FUNCTION identity.assistant_panel_ack(p_assistant text, p_runtime_instance_id text, p_operation_id uuid, p_error_code text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text; v_device text; v_change identity.assistant_panel_changes%ROWTYPE;
BEGIN
    v_owner := identity.assistant_panel_lock(p_assistant);
    v_device := identity.assistant_panel_runtime(p_assistant,p_runtime_instance_id,true);
    SELECT * INTO v_change FROM identity.assistant_panel_changes WHERE operation_id = p_operation_id
        AND assistant_user_id = p_assistant AND owner_user_id = v_owner AND source = 'panel';
    IF NOT FOUND THEN RAISE EXCEPTION 'Assistant panel change not found' USING ERRCODE = 'P0002'; END IF;
    IF p_error_code IS NOT NULL AND p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
        RAISE EXCEPTION 'Application failure requires a non-sensitive error code' USING ERRCODE = '22023';
    END IF;
    IF v_change.status = 'applied' THEN
        RETURN jsonb_build_object('operationId',p_operation_id,'status','applied','revision',v_change.revision::text);
    END IF;
    IF EXISTS (SELECT 1 FROM identity.assistant_panel_changes WHERE assistant_user_id = p_assistant
        AND source = 'panel' AND status <> 'applied' AND revision < v_change.revision) THEN
        RAISE EXCEPTION 'Earlier assistant panel changes must be applied first' USING ERRCODE = '55000';
    END IF;
    UPDATE identity.assistant_panel_changes SET status = CASE WHEN p_error_code IS NULL THEN 'applied' ELSE 'failed' END,
        applied_at = CASE WHEN p_error_code IS NULL THEN clock_timestamp() END,
        applied_device_id = v_device,error_code = p_error_code WHERE operation_id = p_operation_id;
    PERFORM chat.send_user_event(jsonb_build_object('assistantId',p_assistant,'operationId',p_operation_id,
        'applicationStatus',CASE WHEN p_error_code IS NULL THEN 'applied' ELSE 'failed' END),
        'assistant_panel_changed','gugu:user:' || v_owner || ':events',true);
    RETURN jsonb_build_object('operationId',p_operation_id,'revision',v_change.revision::text,
        'status',CASE WHEN p_error_code IS NULL THEN 'applied' ELSE 'failed' END,
        'domain',v_change.domain,'resourceKey',v_change.resource_key,'errorCode',p_error_code);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_ack(text,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_panel_ack(text,text,uuid,text) TO authenticated;

-- This lock defines ordering against panel commits. A later edit is an in-turn
-- App change; an earlier one must have been applied before admission succeeds.
CREATE FUNCTION identity.assistant_panel_admit(p_assistant text, p_runtime_instance_id text, p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner text; v_revision bigint; v_change identity.assistant_panel_changes%ROWTYPE;
BEGIN
    v_owner := identity.assistant_panel_lock(p_assistant);
    PERFORM identity.assistant_panel_runtime(p_assistant,p_runtime_instance_id,true);
    SELECT revision INTO v_revision FROM identity.assistant_panel_items
      WHERE assistant_user_id = p_assistant AND domain = 'control' AND resource_key = '__head__';
    IF p_expected_revision IS NULL OR v_revision <> p_expected_revision THEN
        RAISE EXCEPTION 'Assistant panel changed before admission; apply current changes' USING ERRCODE = '40001';
    END IF;
    SELECT * INTO v_change FROM identity.assistant_panel_changes WHERE assistant_user_id = p_assistant
        AND source = 'panel' AND status <> 'applied' ORDER BY revision LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('admitted',false,'revision',v_revision::text,'operationId',v_change.operation_id,
            'domain',v_change.domain,'resourceKey',v_change.resource_key,'errorCode',v_change.error_code);
    END IF;
    RETURN jsonb_build_object('admitted',true,'revision',v_revision::text);
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_admit(text,text,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.assistant_panel_admit(text,text,bigint) TO authenticated;

-- Referenced bodies are immutable file snapshots, not collaboratively edited
-- documents. A new body needs a new ID and an atomic panel commit.
CREATE FUNCTION identity.assistant_panel_guard_body() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF (NEW.blob_id IS DISTINCT FROM OLD.blob_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.chat_id IS DISTINCT FROM OLD.chat_id) AND EXISTS (
        SELECT 1 FROM identity.assistant_panel_changes WHERE payload->>'bodyItemId' = OLD.id::text
    ) THEN
        RAISE EXCEPTION 'Published assistant panel bodies are immutable; create a new file' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_guard_body() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER assistant_panel_body_immutable BEFORE UPDATE OF blob_id, kind, chat_id ON chat.workspace_items
    FOR EACH ROW EXECUTE FUNCTION identity.assistant_panel_guard_body();
