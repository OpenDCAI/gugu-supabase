-- File storage policy is one global setting per account, not a per-group record. A project chat follows the setting of
-- the account whose machine holds it, read from the existing identity.user_settings row (scope 'user', key file_storage).
-- chat.file_project_policies keeps only the binding of a chat to its host project; earlier per-group values are not
-- carried over, so a chat whose values were changed follows its host's global setting from now on.
-- An image sent into a project chat that keeps files local expires on that setting's schedule through the existing
-- reference ledger, idle-expiry entry point and blob collector.

ALTER TABLE identity.user_settings ADD CONSTRAINT user_settings_file_storage CHECK (
    scope<>'user' OR NOT config ? 'file_storage' OR (
        jsonb_typeof(config->'file_storage')='object'
        AND (config->'file_storage')-ARRAY['proactive_upload','temporary_transfer','retention','image_retention']='{}'::jsonb
        AND COALESCE(jsonb_typeof(config->'file_storage'->'proactive_upload'),'boolean')='boolean'
        AND COALESCE(jsonb_typeof(config->'file_storage'->'temporary_transfer'),'boolean')='boolean'
        AND COALESCE(jsonb_typeof(config->'file_storage'->'retention'),'string')='string'
        AND COALESCE(config->'file_storage'->>'retention','7d') IN ('read-once','1d','7d','30d')
        AND COALESCE(jsonb_typeof(config->'file_storage'->'image_retention'),'string')='string'
        AND COALESCE(config->'file_storage'->>'image_retention','7d') IN ('1d','7d','30d')));

CREATE FUNCTION chat.file_storage_policy(p_chat text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT '{"proactive_upload":false,"temporary_transfer":true,"retention":"7d","image_retention":"7d"}'::jsonb
        ||COALESCE((SELECT s.config->'file_storage' FROM identity.user_settings s WHERE s.scope='user' AND s.user_id=(
            SELECT dp.user_id::text FROM identity.device_projects dp LEFT JOIN chat.file_project_policies p ON p.chat_id=dp.chat_id
            WHERE dp.chat_id=p_chat
            ORDER BY (p.host_device_id,p.host_project_id) IS NOT DISTINCT FROM (dp.device_id,dp.local_project_id) DESC,
                dp.group_representative DESC,dp.created_at,dp.device_id
            LIMIT 1)),'{}'::jsonb)
$$;
REVOKE ALL ON FUNCTION chat.file_storage_policy(text) FROM PUBLIC,anon,authenticated;

ALTER TABLE chat.file_project_policies DROP COLUMN proactive_upload,DROP COLUMN temporary_transfer,DROP COLUMN retention;

-- The policy RPCs keep their signatures and keys for existing clients. Writing binds the chat to its host project;
-- the policy arguments no longer change anything, the host's global setting does.
CREATE OR REPLACE FUNCTION chat.file_project_policy_as(p_chat text,p_device text,p_project text,p_upload boolean,p_temporary boolean,p_retention text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g text:=chat.workspace_require_room_member(p_chat,auth.uid()::text); p chat.file_project_policies%ROWTYPE;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM chat.chat_members WHERE chat_id=g AND user_id=auth.uid()::text AND role IN ('owner','admin'))
       OR NOT EXISTS(SELECT 1 FROM identity.device_projects dp JOIN identity.gugu_devices d ON d.device_id=dp.device_id
           WHERE dp.device_id=p_device AND dp.local_project_id=p_project AND dp.chat_id=g
             AND dp.user_id=auth.uid() AND d.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'Only the bound project owner can change file policy' USING HINT='file_transfer_denied';
    END IF;
    INSERT INTO chat.file_project_policies AS policy(chat_id,host_device_id,host_project_id)
    VALUES(g,p_device,p_project)
    ON CONFLICT(chat_id) DO UPDATE SET host_device_id=EXCLUDED.host_device_id,host_project_id=EXCLUDED.host_project_id,updated_at=now()
    RETURNING * INTO p;
    RETURN to_jsonb(p)||chat.file_storage_policy(g);
END $$;
CREATE OR REPLACE FUNCTION chat.file_project_policy_for(p_chat text,p_as text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g text:=chat.workspace_require_room_member(p_chat,chat.workspace_actor_for(p_as));
BEGIN
    -- The host account is whose setting applies; members are told so where a file says which machine keeps it.
    RETURN (SELECT to_jsonb(p)||jsonb_build_object('host_account_id',dp.user_id)||chat.file_storage_policy(g)
        FROM chat.file_project_policies p JOIN identity.device_projects dp
        ON dp.device_id=p.host_device_id AND dp.local_project_id=p.host_project_id AND dp.chat_id=p.chat_id WHERE p.chat_id=g);
END $$;

-- A fixed expiry chosen when the reference was registered; NULL keeps the existing retention rules.
ALTER TABLE chat.file_transfer_storage_refs ADD COLUMN expires_at timestamptz;
CREATE INDEX file_transfer_fixed_expiry_refs ON chat.file_transfer_storage_refs (expires_at)
    WHERE expired_at IS NULL AND expires_at IS NOT NULL;

-- Same entry point, selection fences and collector hand-off. A fixed expiry needs no deployment idle policy.
CREATE OR REPLACE FUNCTION chat.file_transfer_expire(p_limit integer DEFAULT 500) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s jsonb; idle boolean; threshold_bytes bigint; idle_seconds bigint; r record; n integer:=0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid expiry batch size'; END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0)) THEN RETURN 0; END IF;
    SELECT settings INTO s FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*';
    -- Absent deployment policy preserves idle files; it never invents a deletion policy.
    idle:=COALESCE(s ?& ARRAY['large_file_bytes','large_file_idle_seconds'],false);
    IF idle THEN
        threshold_bytes:=chat.file_transfer_parameter(s,'large_file_bytes');
        idle_seconds:=chat.file_transfer_parameter(s,'large_file_idle_seconds');
        IF idle_seconds NOT BETWEEN 1 AND 2147483647 THEN RAISE EXCEPTION 'Invalid large file idle interval'; END IF;
    END IF;
    FOR r IN SELECT ref.storage_id,ref.chat_id,o.blob_id
        FROM chat.file_transfer_storage_refs ref JOIN chat.file_transfer_storage o ON o.id=ref.storage_id
        WHERE ref.expired_at IS NULL AND o.state='ready' AND o.blob_id IS NOT NULL
          AND (ref.expires_at<=now()
            OR idle AND o.size_bytes>threshold_bytes
              AND COALESCE(ref.last_download_at,ref.retention_started_at)<=now()-make_interval(secs=>idle_seconds::integer)
              AND NOT EXISTS(SELECT 1 FROM identity.device_projects p WHERE p.chat_id=ref.chat_id))
          AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_reservations d WHERE d.kind='download'
              AND d.subject='object:'||o.id::text AND d.expires_at>now() AND d.state IN ('reserved','issued'))
        ORDER BY COALESCE(ref.last_download_at,ref.retention_started_at),ref.storage_id,ref.chat_id
        LIMIT p_limit FOR UPDATE OF ref SKIP LOCKED
    LOOP
        UPDATE chat.file_transfer_storage_refs SET expired_at=now() WHERE storage_id=r.storage_id AND chat_id=r.chat_id;
        -- The existing GC checks all remaining references and owns physical deletion/retry.
        PERFORM chat.file_blob_enqueue(r.blob_id);
        UPDATE chat.file_blob_gc SET next_attempt_at=now() WHERE blob_id=r.blob_id AND status<>'running';
        n:=n+1;
    END LOOP;
    RETURN n;
END $$;

-- Every policy reader now asks the host's global setting, guarded against a mismatched predecessor.
DO $upgrade$
DECLARE r record; definition text;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('chat.file_managed_upload_prepare(text,text,bigint,text)',
         $old$NOT COALESCE((SELECT proactive_upload FROM chat.file_project_policies WHERE chat_id=g),false)$old$,
         $new$NOT (chat.file_storage_policy(g)->>'proactive_upload')::boolean$new$),
        ('chat.file_managed_upload_registered(text,text,jsonb)',
         $old$NOT COALESCE((SELECT proactive_upload FROM chat.file_project_policies WHERE chat_id=u.chat_id),false)$old$,
         $new$NOT (chat.file_storage_policy(u.chat_id)->>'proactive_upload')::boolean$new$),
        ('chat.file_managed_upload_registered(text,text,jsonb)',
         $old$    UPDATE chat.file_transfer_uploads SET blob_id=b.id WHERE staging_key=p_key;$old$,
         $new$    -- Fixed when the image is stored; sending it again, also after it expired, starts a new interval.
    IF u.blob_id IS NULL AND b.content_type LIKE 'image/%' AND EXISTS(SELECT 1 FROM identity.device_projects WHERE chat_id=u.chat_id)
       AND NOT (chat.file_storage_policy(u.chat_id)->>'proactive_upload')::boolean THEN
        UPDATE chat.file_transfer_storage_refs SET expires_at=now()+(chat.file_storage_policy(u.chat_id)->>'image_retention')::interval
          WHERE storage_id=(SELECT id FROM chat.file_transfer_storage WHERE blob_id=b.id) AND chat_id=u.chat_id;
    END IF;
    UPDATE chat.file_transfer_uploads SET blob_id=b.id WHERE staging_key=p_key;$new$),
        ('chat.file_device_read_only()',
         $old$EXISTS(SELECT 1 FROM chat.file_project_policies WHERE chat_id=OLD.chat_id AND proactive_upload)$old$,
         $new$(chat.file_storage_policy(OLD.chat_id)->>'proactive_upload')::boolean$new$),
        ('chat.file_resolve_as(jsonb,text)',
         $old$'temporary_transfer',p.temporary_transfer$old$,
         $new$'temporary_transfer',(chat.file_storage_policy(w.chat_id)->>'temporary_transfer')::boolean$new$)
    ) AS patches(signature,before_text,after_text)
    LOOP
        SELECT pg_get_functiondef(r.signature::regprocedure) INTO definition;
        IF position(r.before_text IN definition)=0 THEN RAISE EXCEPTION 'Unexpected predecessor: %',r.signature; END IF;
        EXECUTE replace(definition,r.before_text,r.after_text);
    END LOOP;
END $upgrade$;

-- The installation DDL guard closes replaced functions too; restore only their existing API grants.
GRANT EXECUTE ON FUNCTION chat.file_project_policy_as(text,text,text,boolean,boolean,text),chat.file_project_policy_for(text,text),
    chat.file_managed_upload_prepare(text,text,bigint,text),chat.file_resolve_as(jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_registered(text,text,jsonb),chat.file_transfer_expire(integer),
    chat.file_device_read_only() TO service_role;

NOTIFY pgrst,'reload schema';
