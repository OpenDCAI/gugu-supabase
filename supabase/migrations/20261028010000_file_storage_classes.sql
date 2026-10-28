-- What a stored copy is: temporary (it has a fixed expiry on the reference ledger) or kept (none). No second state:
-- classifying, keeping and clearing all write storage_refs.expires_at, and the existing expiry entry point and collector
-- delete. Images in a project chat that keeps files local follow image_retention (as before); files marked temporary follow
-- temporary_retention — a key of its own in the same account setting. A project chat uses its host's setting, any other
-- chat the uploader's own. Existing references are not reclassified.

ALTER TABLE identity.user_settings DROP CONSTRAINT user_settings_file_storage;
ALTER TABLE identity.user_settings ADD CONSTRAINT user_settings_file_storage CHECK (
    scope<>'user' OR NOT config ? 'file_storage' OR (
        jsonb_typeof(config->'file_storage')='object'
        AND (config->'file_storage')-ARRAY['proactive_upload','temporary_transfer','retention','image_retention','temporary_retention']='{}'::jsonb
        AND COALESCE(jsonb_typeof(config->'file_storage'->'proactive_upload'),'boolean')='boolean'
        AND COALESCE(jsonb_typeof(config->'file_storage'->'temporary_transfer'),'boolean')='boolean'
        AND COALESCE(jsonb_typeof(config->'file_storage'->'retention'),'string')='string'
        AND COALESCE(config->'file_storage'->>'retention','7d') IN ('read-once','1d','7d','30d')
        AND COALESCE(jsonb_typeof(config->'file_storage'->'image_retention'),'string')='string'
        AND COALESCE(config->'file_storage'->>'image_retention','7d') IN ('1d','7d','30d')
        AND COALESCE(jsonb_typeof(config->'file_storage'->'temporary_retention'),'string')='string'
        AND COALESCE(config->'file_storage'->>'temporary_retention','7d') IN ('1d','7d','30d')));

CREATE OR REPLACE FUNCTION chat.file_storage_policy(p_chat text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT '{"proactive_upload":false,"temporary_transfer":true,"retention":"7d","image_retention":"7d","temporary_retention":"7d"}'::jsonb
        ||COALESCE((SELECT s.config->'file_storage' FROM identity.user_settings s WHERE s.scope='user' AND s.user_id=(
            SELECT dp.user_id::text FROM identity.device_projects dp LEFT JOIN chat.file_project_policies p ON p.chat_id=dp.chat_id
            WHERE dp.chat_id=p_chat
            ORDER BY (p.host_device_id,p.host_project_id) IS NOT DISTINCT FROM (dp.device_id,dp.local_project_id) DESC,
                dp.group_representative DESC,dp.created_at,dp.device_id
            LIMIT 1)),'{}'::jsonb)
$$;

-- How long a copy marked temporary stays: the project chat's host setting, otherwise the uploader's own.
CREATE FUNCTION chat.file_temporary_interval(p_chat text,p_account text) RETURNS interval
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT (CASE WHEN EXISTS(SELECT 1 FROM identity.device_projects WHERE chat_id=p_chat) THEN chat.file_storage_policy(p_chat)->>'temporary_retention'
        ELSE COALESCE((SELECT s.config->'file_storage'->>'temporary_retention' FROM identity.user_settings s WHERE s.user_id=p_account AND s.scope='user'),'7d')
        END)::interval
$$;

-- The uploader marks their copies: temporary, permanent (kept) or release (cleared now). p_refs holds {message_id} or {item_id},
-- read as p_as (a person or their agent), or {class, chat_id?} — every copy of theirs of that class (image|temporary|kept).
-- A copy the caller did not upload is refused. Release hands the copies to the existing expiry and collector.
CREATE FUNCTION chat.file_storage_mark_as(p_refs jsonb,p_action text,p_as text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE me text:=auth.uid()::text; actor text; r jsonb; v_blob uuid; v_chat text; w chat.workspace_items%ROWTYPE; n integer:=0; k integer;
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING HINT='file_transfer_denied'; END IF;
    actor:=chat.workspace_actor_for(COALESCE(p_as,me));
    IF p_action IS NULL OR p_action NOT IN ('temporary','permanent','release') THEN
        RAISE EXCEPTION 'Invalid file storage action' USING HINT='file_transfer_invalid';
    END IF;
    IF jsonb_typeof(p_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_refs) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'Give 1 to 500 file references' USING HINT='file_transfer_invalid';
    END IF;
    FOR r IN SELECT value FROM jsonb_array_elements(p_refs) LOOP
        IF r ? 'class' THEN
            IF NOT (r->>'class' IN ('image','temporary','kept') AND r-'class'-'chat_id'='{}'::jsonb) THEN
                RAISE EXCEPTION 'Invalid file reference' USING HINT='file_transfer_invalid';
            END IF;
            UPDATE chat.file_transfer_storage_refs ref SET expires_at=CASE p_action WHEN 'permanent' THEN NULL WHEN 'release' THEN now()
                    ELSE now()+chat.file_temporary_interval(ref.chat_id,me) END
                FROM chat.file_transfer_storage o JOIN chat.file_blobs b ON b.id=o.blob_id
                WHERE o.id=ref.storage_id AND o.state='ready' AND ref.account_id=me AND ref.expired_at IS NULL
                  AND (r->>'chat_id' IS NULL OR ref.chat_id=chat.file_transfer_group(r->>'chat_id'))
                  AND CASE r->>'class' WHEN 'image' THEN b.content_type LIKE 'image/%'
                      WHEN 'temporary' THEN b.content_type NOT LIKE 'image/%' AND ref.expires_at IS NOT NULL
                      ELSE b.content_type NOT LIKE 'image/%' AND ref.expires_at IS NULL END;
            GET DIAGNOSTICS k=ROW_COUNT; n:=n+k;
            CONTINUE;
        END IF;
        IF r ? 'message_id' AND r-'message_id'='{}'::jsonb THEN
            IF NOT chat.can_read_message(r->>'message_id',actor) THEN RAISE EXCEPTION 'File reference is not readable' USING HINT='file_transfer_denied'; END IF;
            SELECT COALESCE(m.file_blob_id,chat.workspace_version_blob(m.file_item_id,m.file_version)),m.chat_id INTO v_blob,v_chat
                FROM chat.messages m WHERE m.id=r->>'message_id';
        ELSIF r ? 'item_id' AND r-'item_id'='{}'::jsonb THEN
            w:=chat.workspace_item_for(r->>'item_id',actor,false);
            v_blob:=w.blob_id; v_chat:=w.chat_id;
        ELSE
            RAISE EXCEPTION 'Invalid file reference' USING HINT='file_transfer_invalid';
        END IF;
        IF v_blob IS NULL THEN RAISE EXCEPTION 'This file has no cloud copy' USING HINT='file_transfer_invalid'; END IF;
        v_chat:=chat.file_transfer_group(v_chat);
        UPDATE chat.file_transfer_storage_refs ref SET expires_at=CASE p_action WHEN 'permanent' THEN NULL WHEN 'release' THEN now()
                ELSE now()+chat.file_temporary_interval(v_chat,me) END
            FROM chat.file_transfer_storage o
            WHERE o.id=ref.storage_id AND o.blob_id=v_blob AND ref.chat_id=v_chat AND ref.account_id=me AND ref.expired_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Only the person who uploaded a file can change how long it is kept' USING HINT='file_transfer_denied';
        END IF;
        n:=n+1;
    END LOOP;
    IF p_action='release' THEN PERFORM chat.file_transfer_expire(500); END IF;
    RETURN n;
END $$;

-- The caller's own cloud copies, as the 「文件存储与读取」 dashboard shows them: totals, classes, groups, what expires
-- soonest, and the files their machines keep for project chats (not in the cloud) with the temporary copies made of them.
CREATE FUNCTION chat.file_storage_overview_as() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE me text:=auth.uid()::text; result jsonb;
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING HINT='file_transfer_denied'; END IF;
    WITH mine AS (
        SELECT ref.storage_id,ref.chat_id,ref.expires_at,o.size_bytes,o.blob_id,
            CASE WHEN b.content_type LIKE 'image/%' THEN 'image' WHEN ref.expires_at IS NOT NULL THEN 'temporary' ELSE 'kept' END AS class
        FROM chat.file_transfer_storage_refs ref JOIN chat.file_transfer_storage o ON o.id=ref.storage_id JOIN chat.file_blobs b ON b.id=o.blob_id
        WHERE ref.account_id=me AND ref.expired_at IS NULL AND o.state='ready'
    ), devices AS (SELECT device_id,label FROM identity.gugu_devices WHERE user_id::text=me)
    SELECT jsonb_build_object(
        'total_bytes',COALESCE((SELECT sum(size_bytes) FROM (SELECT DISTINCT ON (storage_id) storage_id,size_bytes FROM mine) d),0),
        'count',(SELECT count(*) FROM mine),
        'expiring_7d_bytes',COALESCE((SELECT sum(size_bytes) FROM mine WHERE expires_at<=now()+interval '7 days'),0),
        'classes',(SELECT jsonb_object_agg(c.class,jsonb_build_object('bytes',COALESCE(s.bytes,0),'count',COALESCE(s.n,0)))
            FROM (VALUES('image'),('temporary'),('kept')) c(class)
            LEFT JOIN (SELECT class,sum(size_bytes) bytes,count(*) n FROM mine GROUP BY class) s ON s.class=c.class),
        'groups',COALESCE((SELECT jsonb_agg(g ORDER BY (g->>'bytes')::bigint DESC) FROM (
            SELECT jsonb_build_object('chat_id',m.chat_id,'name',c.name,'project',EXISTS(SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id=m.chat_id),
                'bytes',sum(m.size_bytes),'count',count(*)) g
            FROM mine m JOIN chat.chats c ON c.id=m.chat_id GROUP BY m.chat_id,c.name) gs),'[]'::jsonb),
        'expiring',COALESCE((SELECT jsonb_agg(e ORDER BY e->>'expires_at') FROM (
            SELECT jsonb_build_object('chat_id',m.chat_id,'expires_at',m.expires_at,'bytes',m.size_bytes,'class',m.class,
                'item_id',w.id,'file_name',w.filename) e
            FROM mine m LEFT JOIN LATERAL (SELECT i.id,i.filename FROM chat.workspace_items i WHERE i.chat_id=m.chat_id AND i.blob_id=m.blob_id LIMIT 1) w ON true
            WHERE m.expires_at IS NOT NULL ORDER BY m.expires_at LIMIT 20) es),'[]'::jsonb),
        'machines',COALESCE((SELECT jsonb_agg(jsonb_build_object('device_id',d.device_id,'label',d.label,'files',s.files,'bytes',s.bytes,
                'temporary_copy_bytes',s.copies))
            FROM devices d JOIN LATERAL (
                SELECT count(*) files,COALESCE(sum(r.size_bytes),0) bytes,
                    COALESCE((SELECT sum(chat.file_temporary_usage(p.chat_id)) FROM chat.file_project_policies p WHERE p.host_device_id=d.device_id),0) copies
                FROM chat.file_device_revisions r JOIN chat.workspace_items w ON w.id=r.item_id AND w.version=r.version
                WHERE r.host_device_id=d.device_id) s ON true),'[]'::jsonb)
    ) INTO result;
    RETURN result;
END $$;

REVOKE ALL ON FUNCTION chat.file_temporary_interval(text,text),chat.file_storage_mark_as(jsonb,text,text),chat.file_storage_overview_as()
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_storage_mark_as(jsonb,text,text),chat.file_storage_overview_as() TO authenticated;

NOTIFY pgrst,'reload schema';
