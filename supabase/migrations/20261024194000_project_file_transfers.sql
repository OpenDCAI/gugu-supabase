-- Temporary generations reuse the quota ledger, immutable upload permits and the original blob GC.
ALTER TABLE chat.file_blobs DROP CONSTRAINT file_blobs_bucket_id_check;
ALTER TABLE chat.file_blobs ADD CONSTRAINT file_blobs_bucket_id_check CHECK(bucket_id IN ('oss','workspace','temporary'));
ALTER TABLE chat.file_transfer_reservations ADD COLUMN file_context jsonb;
CREATE TABLE chat.file_temporary_transfers (
    id uuid PRIMARY KEY,
    item_id uuid NOT NULL,
    version integer NOT NULL,
    chat_id text NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
    host_device_id text NOT NULL,
    reader_account text NOT NULL,
    reader_actor text NOT NULL,
    source_ref jsonb NOT NULL,
    retention text NOT NULL CHECK(retention IN ('read-once','1d','7d','30d')),
    state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','uploading','ready','retired')),
    object_name text UNIQUE NOT NULL,
    ciphertext_bytes bigint,
    ciphertext_sha256 text,
    data_key text,
    blob_id uuid REFERENCES chat.file_blobs(id) ON DELETE SET NULL,
    once_download_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    serve_until timestamptz,
    FOREIGN KEY(item_id,version) REFERENCES chat.file_device_revisions(item_id,version) ON DELETE CASCADE
);
CREATE INDEX file_temporary_pending ON chat.file_temporary_transfers(host_device_id,created_at) WHERE state IN ('requested','uploading');
ALTER TABLE chat.file_temporary_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.file_temporary_transfers FROM PUBLIC,anon,authenticated;
GRANT ALL ON chat.file_temporary_transfers TO service_role;

-- Match the existing delegated-call helper: restore both claims on return or error. API roles cannot impersonate here.
CREATE FUNCTION chat.file_resolve_for(p_ref jsonb,p_actor text,p_account text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE claims text:=current_setting('request.jwt.claims',true); sub text:=current_setting('request.jwt.claim.sub',true); r jsonb;
BEGIN
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_account,'role','authenticated')::text,true);
    PERFORM set_config('request.jwt.claim.sub',p_account,true);
    r:=CASE WHEN chat.is_acting_as(p_actor) THEN chat.file_resolve_as(p_ref,p_actor) ELSE jsonb_build_object('status','gone') END;
    PERFORM set_config('request.jwt.claims',COALESCE(claims,''),true),set_config('request.jwt.claim.sub',COALESCE(sub,''),true);
    RETURN r;
EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('request.jwt.claims',COALESCE(claims,''),true),set_config('request.jwt.claim.sub',COALESCE(sub,''),true);
    RAISE;
END $$;
CREATE FUNCTION chat.file_temporary_current(p_transfer chat.file_temporary_transfers) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    SELECT COALESCE(r->>'status'='ready' AND r->>'source'='local' AND r->>'item_id'=(p_transfer).item_id::text
        AND (r->>'version')::integer=(p_transfer).version AND (r->>'current_version')::integer=(p_transfer).version
        AND r->>'host_device_id'=(p_transfer).host_device_id AND (r->>'temporary_transfer')::boolean,false)
    FROM (SELECT chat.file_resolve_for((p_transfer).source_ref,(p_transfer).reader_actor,(p_transfer).reader_account) AS r) source
$$;
CREATE FUNCTION chat.file_temporary_host_for(p_id uuid,p_host text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t chat.file_temporary_transfers%ROWTYPE;
BEGIN
    SELECT * INTO t FROM chat.file_temporary_transfers WHERE id=p_id;
    IF NOT FOUND OR t.state='retired' OR NOT EXISTS(SELECT 1 FROM identity.gugu_devices d
        WHERE d.device_id=t.host_device_id AND d.user_id::text=p_host AND chat.is_chat_member(t.chat_id,p_host)) THEN
        RAISE EXCEPTION 'Transfer is not owned by this host' USING HINT='file_transfer_denied';
    END IF;
    IF NOT chat.file_temporary_current(t)
       OR t.state<>'ready' AND t.created_at<=now()-make_interval(secs=>chat.file_transfer_parameter(chat.file_transfer_settings(),'upload_permit_seconds')::integer) THEN
        RAISE EXCEPTION 'Transfer is no longer authorized' USING HINT='file_transfer_denied';
    END IF;
    RETURN to_jsonb(t)-'data_key';
END $$;
CREATE FUNCTION chat.file_temporary_request(p_ref jsonb,p_as text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); r jsonb; t chat.file_temporary_transfers%ROWTYPE; p jsonb; cfg jsonb;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    r:=chat.file_resolve_as(p_ref,actor);
    IF r->>'status'<>'ready' OR r->>'source'<>'local' THEN RETURN r; END IF;
    IF (r->>'temporary_transfer')::boolean IS DISTINCT FROM true OR r->>'version' IS DISTINCT FROM r->>'current_version' THEN
        RAISE EXCEPTION 'Temporary transfer is disabled or this local version has changed' USING HINT='file_transfer_denied';
    END IF;
    SELECT * INTO t FROM chat.file_temporary_transfers WHERE id=p_id;
    IF FOUND THEN
        IF (t.reader_account,t.reader_actor,t.item_id,t.version,t.source_ref)
           IS DISTINCT FROM (auth.uid()::text,actor,(r->>'item_id')::uuid,(r->>'version')::integer,p_ref) THEN
            RAISE EXCEPTION 'Transfer identity is immutable' USING HINT='file_transfer_conflict';
        END IF;
    ELSE
        p:=chat.file_project_policy_for(r->>'chat_id',actor); cfg:=chat.file_transfer_settings();
        IF p->>'retention'<>'read-once' THEN
            SELECT generation.* INTO t FROM chat.file_temporary_transfers generation WHERE item_id=(r->>'item_id')::uuid AND version=(r->>'version')::integer
                AND retention<>'read-once' AND (state='ready' AND serve_until>now() AND created_at>now()-interval '30 days'
                    OR state IN ('requested','uploading') AND created_at>now()-make_interval(secs=>chat.file_transfer_parameter(cfg,'upload_permit_seconds')::integer))
                AND chat.file_temporary_current(generation)
                ORDER BY created_at DESC LIMIT 1;
        END IF;
        IF t.id IS NULL THEN
            IF (SELECT count(*) FROM chat.file_temporary_transfers WHERE reader_account=auth.uid()::text
                AND created_at>now()-make_interval(secs=>chat.file_transfer_parameter(cfg,'sign_window_seconds')::integer))
                >=chat.file_transfer_parameter(cfg,'sign_account_count') THEN
                RAISE EXCEPTION 'Too many temporary transfer requests' USING HINT='file_transfer_rate_limited';
            END IF;
            INSERT INTO chat.file_temporary_transfers(id,item_id,version,chat_id,host_device_id,reader_account,reader_actor,source_ref,retention,object_name)
            VALUES(p_id,(r->>'item_id')::uuid,(r->>'version')::integer,r->>'chat_id',r->>'host_device_id',auth.uid()::text,actor,p_ref,p->>'retention',
                'temporary/'||(r->>'chat_id')||'/'||(r->>'item_id')||'/'||(r->>'version')||'/'||(r->>'sha256')||'/'||p_id::text) RETURNING * INTO t;
            PERFORM chat.send_user_event(jsonb_build_object('request_id',t.id),'files.transfer','gugu:user:'||(r->>'host_account_id')||':events',true);
        END IF;
    END IF;
    RETURN r||jsonb_build_object('transfer_id',t.id,'transfer_status',t.state);
END $$;
CREATE FUNCTION chat.file_temporary_pending(p_device text) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM identity.gugu_devices WHERE device_id=p_device AND user_id=auth.uid()) THEN
        RAISE EXCEPTION 'Device is not owned by the caller' USING HINT='file_transfer_denied';
    END IF;
    RETURN QUERY SELECT to_jsonb(t)-'data_key'||jsonb_build_object('relative_path',d.relative_path,'sha256',d.sha256,'size_bytes',d.size_bytes)
        FROM chat.file_temporary_transfers t JOIN chat.file_device_revisions d ON d.item_id=t.item_id AND d.version=t.version
        WHERE t.host_device_id=p_device AND t.state IN ('requested','uploading') ORDER BY t.created_at LIMIT 200;
END $$;
CREATE FUNCTION chat.file_temporary_accept(p_id uuid,p_size bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t chat.file_temporary_transfers%ROWTYPE; v chat.file_transfer_reservations%ROWTYPE; host text:=auth.uid()::text; b uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    PERFORM chat.file_temporary_host_for(p_id,host);
    SELECT * INTO t FROM chat.file_temporary_transfers WHERE id=p_id FOR UPDATE;
    IF t.state NOT IN ('requested','uploading') OR p_size IS NULL OR p_size<1 OR p_size>chat.file_transfer_parameter(chat.file_transfer_settings(),'file_max_bytes') THEN
        RAISE EXCEPTION 'Invalid temporary upload' USING HINT='file_transfer_too_large';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM chat.file_transfer_reservations WHERE id=t.id) AND chat.file_temporary_usage(t.chat_id)+p_size>
        chat.file_transfer_parameter(chat.file_transfer_settings('group',t.chat_id),'temporary_group_bytes') THEN
        RAISE EXCEPTION 'Temporary storage quota is exhausted' USING HINT='file_transfer_group_storage_full';
    END IF;
    v:=chat.file_transfer_reserve(t.id,'upload',host,t.chat_id,p_size,t.object_name);
    IF t.blob_id IS NULL THEN
        INSERT INTO chat.file_blobs(bucket_id,object_name,content_type,created_by) VALUES('temporary',t.object_name,'application/octet-stream',host) RETURNING id INTO b;
    END IF;
    INSERT INTO chat.file_transfer_uploads(staging_key,reservation_id,account_id,chat_id,actor_id,max_bytes)
    VALUES(t.object_name,t.id,host,t.chat_id,host,p_size) ON CONFLICT DO NOTHING;
    UPDATE chat.file_transfer_reservations SET state='issued' WHERE id=v.id;
    UPDATE chat.file_temporary_transfers SET state='uploading',ciphertext_bytes=p_size,blob_id=COALESCE(blob_id,b) WHERE id=t.id;
    RETURN jsonb_build_object('transfer_id',t.id,'staging_key',t.object_name,'max_bytes',p_size,'signed_at',v.created_at,'expires_at',v.expires_at);
END $$;
CREATE FUNCTION chat.file_temporary_commit(p_id uuid,p_host text,p_sha text,p_size bigint,p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t chat.file_temporary_transfers%ROWTYPE; b uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    PERFORM chat.file_temporary_host_for(p_id,p_host);
    SELECT * INTO t FROM chat.file_temporary_transfers WHERE id=p_id FOR UPDATE;
    IF p_sha IS NULL OR p_sha!~'^[0-9a-f]{64}$' OR p_key IS NULL OR p_key!~'^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$'
       OR t.ciphertext_bytes IS DISTINCT FROM p_size OR t.state NOT IN ('uploading','ready') THEN
        RAISE EXCEPTION 'Invalid temporary commitment' USING HINT='file_transfer_conflict';
    END IF;
    IF t.state='ready' THEN
        IF (t.ciphertext_sha256,t.data_key) IS DISTINCT FROM (p_sha,p_key) THEN RAISE EXCEPTION 'Committed generation is immutable' USING HINT='file_transfer_conflict'; END IF;
        RETURN;
    END IF;
    UPDATE chat.file_blobs SET sha256=p_sha,size_bytes=p_size WHERE id=t.blob_id AND bucket_id='temporary' AND object_name=t.object_name AND state='live' RETURNING id INTO b;
    IF NOT FOUND THEN RAISE EXCEPTION 'Temporary upload is being collected' USING HINT='file_transfer_conflict'; END IF;
    -- The same transaction replaces the upload hold with physical inventory, before reference admission.
    UPDATE chat.file_transfer_reservations SET actual_bytes=p_size WHERE id=t.id;
    PERFORM chat.file_transfer_track(b,t.chat_id,p_host);
    UPDATE chat.file_transfer_uploads SET blob_id=b WHERE reservation_id=t.id;
    UPDATE chat.file_temporary_transfers SET state='ready',blob_id=b,ciphertext_sha256=p_sha,data_key=p_key,
        serve_until=least(created_at+interval '30 days',now()+CASE retention WHEN '1d' THEN interval '1 day'
            WHEN '7d' THEN interval '7 days' WHEN '30d' THEN interval '30 days' ELSE interval '60 seconds' END) WHERE id=t.id;
END $$;
CREATE FUNCTION chat.file_temporary_key_for(p_download uuid,p_account text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v chat.file_transfer_reservations%ROWTYPE; t chat.file_temporary_transfers%ROWTYPE; r jsonb;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    SELECT * INTO v FROM chat.file_transfer_reservations WHERE id=p_download AND kind='download' AND account_id=p_account AND state='issued' AND expires_at>now();
    SELECT * INTO t FROM chat.file_temporary_transfers WHERE id=(v.file_context->>'transfer_id')::uuid AND state='ready' AND serve_until>now();
    IF t.id IS NULL OR t.data_key IS NULL THEN RAISE EXCEPTION 'File key is unavailable' USING HINT='file_transfer_denied'; END IF;
    PERFORM chat.file_temporary_host_for(t.id,(SELECT user_id::text FROM identity.gugu_devices WHERE device_id=t.host_device_id));
    r:=chat.file_resolve_for(v.file_context->'ref',v.file_context->>'actor',p_account);
    IF r->>'status' IS DISTINCT FROM 'ready' OR r->>'item_id' IS DISTINCT FROM t.item_id::text OR (r->>'version')::integer IS DISTINCT FROM t.version THEN
        RAISE EXCEPTION 'File key is no longer authorized' USING HINT='file_transfer_denied';
    END IF;
    RETURN t.data_key;
END $$;
CREATE FUNCTION chat.file_temporary_read_complete(p_download uuid,p_as text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as);
BEGIN
    UPDATE chat.file_temporary_transfers t SET serve_until=now(),data_key=NULL FROM chat.file_transfer_reservations v
        WHERE v.id=p_download AND v.account_id=auth.uid()::text AND v.file_context->>'actor'=actor
          AND t.id=(v.file_context->>'transfer_id')::uuid AND t.retention='read-once';
    -- This ACK changes retention only; it never refunds a financial reservation.
END $$;

-- Ordinary project uploads require the explicit cloud setting; temporary accept uses the same reserve primitive.
DO $policy$ DECLARE definition text; BEGIN
    SELECT pg_get_functiondef('chat.file_managed_upload_prepare(text,text,bigint)'::regprocedure) INTO definition;
    IF position('IF p_bytes IS NULL' IN definition)=0 THEN RAISE EXCEPTION 'Missing managed upload policy fence'; END IF;
    definition:=replace(definition,'IF p_bytes IS NULL',$guard$
    IF g IS NOT NULL AND EXISTS(SELECT 1 FROM identity.device_projects WHERE chat_id=g)
       AND NOT COALESCE((SELECT proactive_upload FROM chat.file_project_policies WHERE chat_id=g),false) THEN
        RAISE EXCEPTION 'Project files are not uploaded proactively' USING HINT='file_transfer_denied';
    END IF;
    IF p_bytes IS NULL$guard$); EXECUTE definition;
END $policy$;

-- Extend the original download/reservation transaction, preserving its inventory, expiry and budget guards.
DO $download$
DECLARE definition text; a integer; z integer;
BEGIN
    SELECT pg_get_functiondef('chat.file_transfer_download_as(jsonb,text,uuid)'::regprocedure) INTO definition;
    a:=position('IF message IS NOT NULL THEN' IN definition); z:=position('SELECT * INTO o FROM chat.file_transfer_storage' IN definition);
    IF a=0 OR z<=a THEN RAISE EXCEPTION 'Unexpected download authorization predecessor'; END IF;
    definition:=replace(definition,'c record; r jsonb; b uuid;','c record; r jsonb; b uuid; t chat.file_temporary_transfers%ROWTYPE; context jsonb;');
    a:=position('IF message IS NOT NULL THEN' IN definition); z:=position('SELECT * INTO o FROM chat.file_transfer_storage' IN definition);
    definition:=substr(definition,1,a-1)||$body$r:=chat.file_resolve_as(p_ref,actor);
    IF r->>'status'<>'ready' THEN RETURN r; END IF;
    IF r->>'source'='local' THEN
        SELECT * INTO t FROM chat.file_temporary_transfers WHERE item_id=(r->>'item_id')::uuid AND version=(r->>'version')::integer
            AND state='ready' AND serve_until>now() AND created_at>now()-interval '30 days'
            AND (r->>'temporary_transfer')::boolean AND version=(r->>'current_version')::integer
            AND (retention<>'read-once' OR reader_account=auth.uid()::text AND reader_actor=actor AND (once_download_id IS NULL OR once_download_id=p_id))
            ORDER BY created_at DESC LIMIT 1;
        IF NOT FOUND THEN RETURN r||jsonb_build_object('status','pending'); END IF;
        PERFORM chat.file_temporary_host_for(t.id,(SELECT user_id::text FROM identity.gugu_devices WHERE device_id=t.host_device_id));
        r:=r||jsonb_build_object('bucket_id','temporary','object_name',t.object_name,'transfer_id',t.id,
            'plain_size_bytes',r->'size_bytes','ciphertext_sha256',t.ciphertext_sha256,'ciphertext_bytes',t.ciphertext_bytes);
    END IF;
    SELECT r->>'bucket_id' AS bucket_id,r->>'object_name' AS object_name INTO c;
    g:=chat.file_transfer_group(r->>'chat_id');
    $body$||substr(definition,z);
    IF position('UPDATE chat.file_transfer_reservations SET state=''issued'' WHERE id=v.id;' IN definition)=0 THEN RAISE EXCEPTION 'Missing download reservation fence'; END IF;
    definition:=replace(definition,'UPDATE chat.file_transfer_reservations SET state=''issued'' WHERE id=v.id;',$body$
    IF t.id IS NOT NULL THEN
        context:=jsonb_build_object('transfer_id',t.id,'ref',p_ref,'actor',actor);
        IF v.file_context IS NOT NULL AND v.file_context<>context THEN RAISE EXCEPTION 'Download context is immutable' USING HINT='file_transfer_conflict'; END IF;
        UPDATE chat.file_transfer_reservations SET file_context=context WHERE id=v.id;
        IF v.state='reserved' THEN
            UPDATE chat.file_temporary_transfers SET once_download_id=CASE WHEN retention='read-once' THEN v.id ELSE NULL END,
                serve_until=least(created_at+interval '30 days',now()+CASE retention WHEN '1d' THEN interval '1 day'
                    WHEN '7d' THEN interval '7 days' WHEN '30d' THEN interval '30 days' ELSE interval '60 seconds' END) WHERE id=t.id;
        END IF;
    END IF;
    UPDATE chat.file_transfer_reservations SET state='issued' WHERE id=v.id;
    $body$);
    EXECUTE definition;
END $download$;
REVOKE ALL ON FUNCTION chat.file_resolve_for(jsonb,text,text),chat.file_temporary_current(chat.file_temporary_transfers),chat.file_temporary_host_for(uuid,text),chat.file_temporary_request(jsonb,text,uuid),
    chat.file_temporary_pending(text),chat.file_temporary_accept(uuid,bigint),chat.file_temporary_commit(uuid,text,text,bigint,text),
    chat.file_temporary_key_for(uuid,text),chat.file_temporary_read_complete(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_temporary_request(jsonb,text,uuid),chat.file_temporary_pending(text),chat.file_temporary_accept(uuid,bigint),
    chat.file_temporary_read_complete(uuid,text),chat.file_transfer_download_as(jsonb,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_prepare(text,text,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_resolve_for(jsonb,text,text),chat.file_temporary_host_for(uuid,text),chat.file_temporary_commit(uuid,text,text,bigint,text),
    chat.file_temporary_key_for(uuid,text) TO service_role;
