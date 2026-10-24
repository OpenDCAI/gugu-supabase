-- Project policy and immutable local revisions. Bytes remain behind the existing host read fence.
CREATE TABLE chat.file_project_policies (
    chat_id text PRIMARY KEY REFERENCES chat.chats(id) ON DELETE CASCADE,
    host_device_id text NOT NULL,
    host_project_id text NOT NULL,
    proactive_upload boolean NOT NULL DEFAULT false,
    temporary_transfer boolean NOT NULL DEFAULT true,
    retention text NOT NULL DEFAULT '7d' CHECK(retention IN ('read-once','1d','7d','30d')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(host_device_id,host_project_id) REFERENCES identity.device_projects(device_id,local_project_id) ON DELETE CASCADE
);
CREATE TABLE chat.file_device_revisions (
    item_id uuid NOT NULL REFERENCES chat.workspace_items(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK(version>0),
    host_device_id text REFERENCES identity.gugu_devices(device_id) ON DELETE SET NULL,
    host_project_id text NOT NULL,
    relative_path text NOT NULL CHECK(length(relative_path) BETWEEN 1 AND 4096
        AND relative_path !~ '(^/|//|/$|:|\\|[[:cntrl:]]|(^|/)\.\.?(/|$))'),
    sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes bigint NOT NULL CHECK(size_bytes>=0),
    file_name text NOT NULL CHECK(file_name<>''),
    content_type text NOT NULL CHECK(content_type<>''),
    PRIMARY KEY(item_id,version)
);
ALTER TABLE chat.file_project_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.file_device_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.file_project_policies,chat.file_device_revisions FROM PUBLIC,anon,authenticated;
GRANT ALL ON chat.file_project_policies,chat.file_device_revisions TO service_role;

-- Keep the existing version list and message pinning, with one valid body provider per snapshot.
ALTER TABLE chat.workspace_item_versions ADD COLUMN device_version integer;
ALTER TABLE chat.workspace_item_versions ADD FOREIGN KEY(item_id,device_version) REFERENCES chat.file_device_revisions(item_id,version) ON DELETE CASCADE;
ALTER TABLE chat.workspace_item_versions DROP CONSTRAINT workspace_item_versions_one_body;
ALTER TABLE chat.workspace_item_versions ADD CONSTRAINT workspace_item_versions_one_body CHECK(
    num_nonnulls(inline_text,blob_id,device_version)=1 AND (device_version IS NULL OR device_version=n));
CREATE FUNCTION chat.file_device_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NEW.blob_id IS NULL AND NEW.inline_text IS NULL THEN
        SELECT version INTO NEW.device_version FROM chat.file_device_revisions WHERE item_id=NEW.item_id AND version=NEW.n;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER file_device_snapshot BEFORE INSERT ON chat.workspace_item_versions FOR EACH ROW EXECUTE FUNCTION chat.file_device_snapshot();

CREATE FUNCTION chat.file_project_policy_as(p_chat text,p_device text,p_project text,p_upload boolean,p_temporary boolean,p_retention text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g text:=chat.workspace_require_room_member(p_chat,auth.uid()::text); p chat.file_project_policies%ROWTYPE;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM chat.chat_members WHERE chat_id=g AND user_id=auth.uid()::text AND role IN ('owner','admin'))
       OR NOT EXISTS(SELECT 1 FROM identity.device_projects dp JOIN identity.gugu_devices d ON d.device_id=dp.device_id
           WHERE dp.device_id=p_device AND dp.local_project_id=p_project AND dp.chat_id=g
             AND dp.user_id=auth.uid() AND d.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'Only the bound project owner can change file policy' USING HINT='file_transfer_denied';
    END IF;
    INSERT INTO chat.file_project_policies AS policy(chat_id,host_device_id,host_project_id,proactive_upload,temporary_transfer,retention)
    VALUES(g,p_device,p_project,p_upload,p_temporary,p_retention)
    ON CONFLICT(chat_id) DO UPDATE SET host_device_id=EXCLUDED.host_device_id,host_project_id=EXCLUDED.host_project_id,
        proactive_upload=EXCLUDED.proactive_upload,temporary_transfer=EXCLUDED.temporary_transfer,retention=EXCLUDED.retention,updated_at=now()
    RETURNING * INTO p;
    RETURN to_jsonb(p);
END $$;
CREATE FUNCTION chat.file_project_policy_for(p_chat text,p_as text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g text:=chat.workspace_require_room_member(p_chat,chat.workspace_actor_for(p_as));
BEGIN
    RETURN (SELECT to_jsonb(p) FROM chat.file_project_policies p JOIN identity.device_projects dp
        ON dp.device_id=p.host_device_id AND dp.local_project_id=p.host_project_id AND dp.chat_id=p.chat_id WHERE p.chat_id=g);
END $$;

CREATE FUNCTION chat.file_device_publish(p_item uuid,p_chat text,p_device text,p_path text,p_sha text,p_size bigint,
    p_filename text,p_type text,p_expected integer DEFAULT NULL,p_parent uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g text:=chat.workspace_require_room_member(p_chat,chat.workspace_actor_for(auth.uid()::text));
    p chat.file_project_policies%ROWTYPE; w chat.workspace_items%ROWTYPE; n integer;
BEGIN
    SELECT policy.* INTO p FROM chat.file_project_policies policy JOIN identity.device_projects dp
        ON dp.device_id=policy.host_device_id AND dp.local_project_id=policy.host_project_id AND dp.chat_id=policy.chat_id
        JOIN identity.gugu_devices d ON d.device_id=dp.device_id
        WHERE policy.chat_id=g AND dp.device_id=p_device AND dp.user_id=auth.uid() AND d.user_id=auth.uid()
        FOR SHARE OF policy,dp,d;
    IF NOT FOUND THEN RAISE EXCEPTION 'Only the bound host can publish a local revision' USING HINT='file_transfer_denied'; END IF;
    SELECT * INTO w FROM chat.workspace_items WHERE id=p_item FOR UPDATE;
    IF FOUND THEN
        IF w.chat_id<>g OR w.kind<>'file' OR w.version IS DISTINCT FROM p_expected THEN
            RAISE EXCEPTION 'File revision conflict' USING HINT='file_transfer_conflict';
        END IF;
        INSERT INTO chat.workspace_item_versions(item_id,n,blob_id,content_type,size_bytes,made_by,made_at)
        VALUES(w.id,w.version,w.blob_id,w.content_type,w.size_bytes,w.created_by,w.updated_at) ON CONFLICT DO NOTHING;
        n:=w.version+1;
    ELSE
        IF p_expected IS NOT NULL THEN RAISE EXCEPTION 'File revision conflict' USING HINT='file_transfer_conflict'; END IF;
        n:=1;
        INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,created_by,parent_id)
        VALUES(p_item,g,'file',p_filename,p_type,p_size,auth.uid()::text,p_parent);
    END IF;
    INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type)
    VALUES(p_item,n,p_device,p.host_project_id,p_path,p_sha,p_size,chat.workspace_stored_name(p_filename),p_type);
    IF w.id IS NOT NULL THEN
        UPDATE chat.workspace_items SET version=n,blob_id=NULL,size_bytes=p_size,filename=p_filename,content_type=p_type WHERE id=w.id;
    END IF;
    RETURN jsonb_build_object('item_id',p_item,'version',n,'sha256',p_sha,'size_bytes',p_size);
END $$;

-- A local reference is not a write capability. Existing mutation APIs must obey the same host ownership.
CREATE FUNCTION chat.file_device_read_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM chat.chats WHERE id=OLD.chat_id)
       AND EXISTS(SELECT 1 FROM chat.file_device_revisions WHERE item_id=OLD.id)
       AND NOT EXISTS(SELECT 1 FROM chat.file_project_policies p JOIN identity.device_projects dp
           ON dp.device_id=p.host_device_id AND dp.local_project_id=p.host_project_id AND dp.chat_id=p.chat_id
           JOIN identity.gugu_devices d ON d.device_id=dp.device_id
           WHERE p.chat_id=OLD.chat_id AND d.user_id=auth.uid() AND dp.user_id=auth.uid()
             AND chat.is_chat_member(OLD.chat_id,auth.uid()::text)) THEN
        RAISE EXCEPTION 'Remote project files are read-only' USING HINT='file_transfer_read_only';
    END IF;
    IF TG_OP='UPDATE' AND auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM chat.file_device_revisions WHERE item_id=OLD.id)
       AND NOT EXISTS(SELECT 1 FROM chat.file_device_revisions d WHERE d.item_id=NEW.id AND d.version=NEW.version
           AND (d.file_name,d.content_type,d.size_bytes)=(NEW.filename,NEW.content_type,NEW.size_bytes)
           AND NEW.blob_id IS NULL AND NEW.chat_id=OLD.chat_id AND NEW.kind='file') THEN
        RAISE EXCEPTION 'Local revisions must be published by the host' USING HINT='file_transfer_read_only';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER file_device_read_only BEFORE UPDATE OR DELETE ON chat.workspace_items
    FOR EACH ROW EXECUTE FUNCTION chat.file_device_read_only();

-- Pin messages to local metadata without fabricating a cloud blob or bypassing the existing message trigger.
CREATE OR REPLACE FUNCTION chat.workspace_version_envelope(p_item_id uuid,p_n integer) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT chat.attachment_envelope(COALESCE(d.file_name,w.filename),COALESCE(d.size_bytes,b.size_bytes,w.size_bytes),
        COALESCE(d.content_type,b.content_type)) FROM chat.workspace_items w
        LEFT JOIN chat.file_blobs b ON b.id=chat.workspace_version_blob(p_item_id,p_n)
        LEFT JOIN chat.file_device_revisions d ON d.item_id=w.id AND d.version=p_n
        WHERE w.id=p_item_id AND (b.id IS NOT NULL OR d.item_id IS NOT NULL)
$$;

-- One metadata entry point for local, managed, message-pinned and private task references. No bytes or keys.
CREATE FUNCTION chat.file_resolve_as(p_ref jsonb,p_as text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); msg text; w chat.workspace_items%ROWTYPE;
    d chat.file_device_revisions%ROWTYPE; p chat.file_project_policies%ROWTYPE; c record; n integer; hint text; ref jsonb:=p_ref;
BEGIN
    IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR NOT (
        (ref ? 'item_id' AND ref-'item_id'-'version'='{}' AND jsonb_typeof(ref->'item_id')='string'
            AND (NOT (ref ? 'version') OR (jsonb_typeof(ref->'version')='number' AND ref->>'version' ~ '^[1-9][0-9]{0,8}$')))
        OR (ref ? 'message_id' AND ref-'message_id'='{}' AND jsonb_typeof(ref->'message_id')='string')
        OR (ref ? 'attachment_id' AND ref-'attachment_id'='{}' AND jsonb_typeof(ref->'attachment_id')='string')) THEN
        RAISE EXCEPTION 'Invalid file reference' USING HINT='file_transfer_invalid';
    END IF;
    IF ref ? 'message_id' THEN
        msg:=ref->>'message_id';
        IF NOT chat.can_read_message(msg,actor) THEN RETURN jsonb_build_object('status','gone'); END IF;
        SELECT file_item_id,file_version INTO w.id,n FROM chat.messages WHERE id=msg AND retracted_at IS NULL;
        IF w.id IS NOT NULL THEN ref:=jsonb_build_object('item_id',w.id,'version',n); END IF;
    END IF;
    IF ref ? 'item_id' THEN
        -- Same membership and room checks as all workspace readers; hidden messages were checked above.
        BEGIN w:=chat.workspace_item_for(ref->>'item_id',actor,false);
        EXCEPTION WHEN raise_exception THEN
            GET STACKED DIAGNOSTICS hint=PG_EXCEPTION_HINT;
            IF hint='workspace_item_not_found' THEN RETURN jsonb_build_object('status','gone'); END IF;
            RAISE;
        END;
        n:=COALESCE((ref->>'version')::integer,w.version);
        SELECT * INTO d FROM chat.file_device_revisions WHERE item_id=w.id AND version=n;
        IF FOUND THEN
            SELECT policy.* INTO p FROM chat.file_project_policies policy JOIN identity.device_projects dp
                ON dp.device_id=policy.host_device_id AND dp.local_project_id=policy.host_project_id AND dp.chat_id=policy.chat_id
                WHERE policy.chat_id=w.chat_id AND policy.host_device_id=d.host_device_id AND policy.host_project_id=d.host_project_id;
            IF NOT FOUND THEN RETURN jsonb_build_object('status','gone'); END IF;
            RETURN jsonb_build_object('status','ready','source','local','item_id',w.id,'version',n,'current_version',w.version,
                'chat_id',w.chat_id,'message_id',msg,'file_name',d.file_name,'content_type',d.content_type,
                'sha256',d.sha256,'size_bytes',d.size_bytes,'host_device_id',d.host_device_id,'host_project_id',d.host_project_id,
                'host_account_id',(SELECT user_id FROM identity.gugu_devices WHERE device_id=d.host_device_id),
                'relative_path',d.relative_path,'temporary_transfer',p.temporary_transfer);
        END IF;
    END IF;
    IF ref ? 'attachment_id' THEN
        SELECT * INTO c FROM chat.session_attachment_urls_as(ARRAY[(ref->>'attachment_id')::uuid],actor) LIMIT 1;
    ELSE SELECT * INTO c FROM chat.file_urls_as(jsonb_build_array(ref),actor) LIMIT 1;
    END IF;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','gone'); END IF;
    RETURN to_jsonb(c)||jsonb_build_object('source','managed-object','message_id',COALESCE(to_jsonb(c)->>'message_id',msg),
        'status',CASE WHEN EXISTS(SELECT 1 FROM chat.file_transfer_storage o JOIN chat.file_transfer_storage_refs r ON r.storage_id=o.id
            WHERE o.bucket_id=c.bucket_id AND o.object_name=c.object_name AND r.chat_id=chat.file_transfer_group(to_jsonb(c)->>'chat_id')
              AND r.expired_at IS NOT NULL) THEN 'expired' ELSE 'ready' END);
END $$;
REVOKE ALL ON FUNCTION chat.file_project_policy_as(text,text,text,boolean,boolean,text),chat.file_project_policy_for(text,text),
    chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid),chat.file_device_read_only(),chat.file_device_snapshot(),
    chat.workspace_version_envelope(uuid,integer),chat.file_resolve_as(jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_project_policy_as(text,text,text,boolean,boolean,text),chat.file_project_policy_for(text,text),
    chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid),chat.file_resolve_as(jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.workspace_version_envelope(uuid,integer),chat.file_device_read_only(),chat.file_device_snapshot() TO service_role;
