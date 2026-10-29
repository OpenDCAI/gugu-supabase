-- #791. A project file kept on its host can get a next version only from that host (file_private.publish_revision,
-- file_device_read_only). A member on another machine, of this account or another, who changed a copy of it is refused.
-- A version handoff carries the changed copy to the host, which writes it as the next version through its own publisher:
--   1. the requester asks (file_version_handoff_request): the file is kept on its host, the copy is based on the current
--      version, the host machine is online; it gets an upload permit for the encrypted copy (the temporary transfers'
--      ledger: reservation, staging upload, blob, inventory, collector);
--   2. the requester commits the ciphertext and its key (file_version_handoff_commit); the host is woken on its device
--      channel, like a temporary transfer request;
--   3. the host reads it (pending, fetch), checks the plaintext against the committed SHA-256 and size, keeps the bytes in
--      its project and publishes (file_version_handoff_publish): the version is the requester's edit and the message is
--      the requester's, under the requester's own account, the way it was approved in step 1;
--   4. the requester reads the outcome (file_version_handoff_status), or withdraws it.
-- A host that is offline is not waited for: the request answers host_offline at once and names the machine.
CREATE TABLE chat.file_version_handoffs (
    id uuid PRIMARY KEY,
    item_id uuid NOT NULL,
    base_version integer NOT NULL,
    chat_id text NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
    host_device_id text NOT NULL,
    requester_account text NOT NULL,
    requester_actor text NOT NULL,
    file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 255),
    content_type text NOT NULL CHECK(content_type<>''),
    size_bytes bigint NOT NULL CHECK(size_bytes>=0),
    sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
    message jsonb NOT NULL CHECK(jsonb_typeof(message)='object'),
    state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready','published','retired')),
    outcome text CHECK(outcome IN ('conflict','cancelled','expired')),
    object_name text UNIQUE NOT NULL,
    ciphertext_bytes bigint NOT NULL CHECK(ciphertext_bytes>0),
    ciphertext_sha256 text,
    data_key text,
    blob_id uuid REFERENCES chat.file_blobs(id) ON DELETE SET NULL,
    version integer,
    message_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    ready_until timestamptz,
    FOREIGN KEY(item_id,base_version) REFERENCES chat.file_device_revisions(item_id,version) ON DELETE CASCADE
);
CREATE INDEX file_version_handoffs_ready ON chat.file_version_handoffs(host_device_id,created_at) WHERE state='ready';
CREATE INDEX file_version_handoffs_open ON chat.file_version_handoffs(created_at) WHERE state IN ('uploading','ready');
ALTER TABLE chat.file_version_handoffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.file_version_handoffs FROM PUBLIC,anon,authenticated;
GRANT ALL ON chat.file_version_handoffs TO service_role;

-- The copy's bytes leave the store as soon as the handoff is settled either way.
CREATE FUNCTION chat.file_version_handoff_collect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF OLD.blob_id IS NOT NULL AND (TG_OP='DELETE' OR NEW.state IN ('published','retired') AND OLD.state NOT IN ('published','retired')) THEN
        PERFORM chat.file_blob_enqueue(OLD.blob_id);
        UPDATE chat.file_blob_gc SET next_attempt_at=now() WHERE blob_id=OLD.blob_id AND status<>'running';
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER file_version_handoff_collect AFTER UPDATE OF state OR DELETE ON chat.file_version_handoffs
    FOR EACH ROW EXECUTE FUNCTION chat.file_version_handoff_collect();

-- One body for a host's local revision; who the edit is recorded for is the only difference. publish_revision keeps its
-- signature and grant (the host's own edit); publish_revision_by is reachable only from the definer functions here.
DO $by$ DECLARE definition text; BEGIN
    SELECT pg_get_functiondef('file_private.publish_revision(uuid,text,text,text,text,bigint,text,text,integer,uuid)'::regprocedure) INTO definition;
    IF position('updated_by=auth.uid()::text' IN definition)=0 OR position('p_parent uuid DEFAULT NULL::uuid)' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected publish_revision predecessor';
    END IF;
    definition:=replace(definition,'file_private.publish_revision(','file_private.publish_revision_by(');
    definition:=replace(definition,'p_parent uuid DEFAULT NULL::uuid)','p_parent uuid DEFAULT NULL::uuid, p_by text DEFAULT NULL)');
    definition:=replace(definition,'updated_by=auth.uid()::text','updated_by=COALESCE(p_by,auth.uid()::text)');
    EXECUTE definition;
END $by$;
REVOKE ALL ON FUNCTION file_private.publish_revision_by(uuid,text,text,text,text,bigint,text,text,integer,uuid,text) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION file_private.publish_revision(p_item uuid,p_chat text,p_device text,p_path text,p_sha text,p_size bigint,
    p_filename text,p_type text,p_expected integer DEFAULT NULL,p_parent uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    SELECT file_private.publish_revision_by(p_item,p_chat,p_device,p_path,p_sha,p_size,p_filename,p_type,p_expected,p_parent,NULL)
$$;

-- Members are told which machine keeps the chat's files, and whether it is online, so a refusal can name it.
CREATE OR REPLACE FUNCTION chat.file_project_policy_for(p_chat text,p_as text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g text:=chat.workspace_require_room_member(p_chat,chat.workspace_actor_for(p_as));
BEGIN
    -- The host account is whose setting applies; members are told so where a file says which machine keeps it.
    RETURN (SELECT to_jsonb(p)||jsonb_build_object('host_account_id',dp.user_id,'host_label',d.label,'host_online',d.status='online')
            ||chat.file_storage_policy(g)
        FROM chat.file_project_policies p JOIN identity.device_projects dp
        ON dp.device_id=p.host_device_id AND dp.local_project_id=p.host_project_id AND dp.chat_id=p.chat_id
        LEFT JOIN identity.gugu_devices d ON d.device_id=p.host_device_id WHERE p.chat_id=g);
END $$;

CREATE FUNCTION chat.file_version_handoff_host(p_device text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT jsonb_build_object('host_device_id',p_device,'host_label',d.label,'host_account_id',d.user_id,'host_online',COALESCE(d.status='online',false))
    FROM (SELECT 1) one LEFT JOIN identity.gugu_devices d ON d.device_id=p_device
$$;

CREATE FUNCTION chat.file_version_handoff_request(p_id uuid,p_item uuid,p_expected integer,p_name text,p_type text,p_size bigint,
    p_sha text,p_ciphertext bigint,p_reserve bigint,p_message jsonb,p_as text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); r jsonb; host jsonb; h chat.file_version_handoffs%ROWTYPE;
    v chat.file_transfer_reservations%ROWTYPE; cfg jsonb; b uuid; object text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    SELECT * INTO h FROM chat.file_version_handoffs WHERE id=p_id;
    IF FOUND THEN
        IF (h.requester_account,h.requester_actor,h.item_id,h.base_version,h.sha256,h.size_bytes)
           IS DISTINCT FROM (auth.uid()::text,actor,p_item,p_expected,p_sha,p_size) THEN
            RAISE EXCEPTION 'Handoff identity is immutable' USING HINT='file_transfer_conflict';
        END IF;
        RETURN chat.file_version_handoff_status(p_id,false);
    END IF;
    r:=chat.file_resolve_as(jsonb_build_object('item_id',p_item),actor);
    IF r->>'status'<>'ready' THEN RETURN r; END IF;
    IF r->>'source'<>'local' THEN
        RAISE EXCEPTION 'This file is not kept on a host machine' USING HINT='file_transfer_invalid';
    END IF;
    IF NOT chat.can_act_as(actor,r->>'chat_id') THEN
        RAISE EXCEPTION 'A next version can be sent only as yourself or your own agent in this chat' USING HINT='file_transfer_denied';
    END IF;
    IF (r->>'current_version')::integer IS DISTINCT FROM p_expected THEN
        RETURN jsonb_build_object('status','conflict','item_id',p_item,'current_version',(r->>'current_version')::integer);
    END IF;
    host:=chat.file_version_handoff_host(r->>'host_device_id');
    IF NOT (host->>'host_online')::boolean THEN RETURN jsonb_build_object('status','host_offline','item_id',p_item)||host; END IF;
    cfg:=chat.file_transfer_settings('group',r->>'chat_id');
    IF p_size IS NULL OR p_size<0 OR p_ciphertext IS NULL OR p_ciphertext<1 OR p_reserve IS NULL OR p_reserve<p_ciphertext
       OR p_reserve>chat.file_transfer_parameter(cfg,'file_max_bytes') THEN
        RAISE EXCEPTION 'Invalid next version upload' USING HINT='file_transfer_too_large';
    END IF;
    IF chat.file_temporary_usage(r->>'chat_id')+p_reserve>chat.file_transfer_parameter(cfg,'temporary_group_bytes') THEN
        RAISE EXCEPTION 'Temporary storage quota is exhausted' USING HINT='file_transfer_group_storage_full';
    END IF;
    IF (SELECT count(*) FROM chat.file_version_handoffs WHERE requester_account=auth.uid()::text
        AND created_at>now()-make_interval(secs=>chat.file_transfer_parameter(cfg,'sign_window_seconds')::integer))
        >=chat.file_transfer_parameter(cfg,'sign_account_count') THEN
        RAISE EXCEPTION 'Too many next version requests' USING HINT='file_transfer_rate_limited';
    END IF;
    IF jsonb_typeof(COALESCE(p_message,'{}'::jsonb))<>'object' OR COALESCE((p_message->>'is_whisper')::boolean,false)
       OR COALESCE(p_message,'{}'::jsonb)-ARRAY['message_id','caption','to_user_ids','reply_to_message_id','thread_root_id','is_thread_root','via_app']<>'{}'::jsonb THEN
        RAISE EXCEPTION 'Invalid next version message' USING HINT='file_transfer_invalid';
    END IF;
    -- Under temporary/: the copy is held and collected like a temporary transfer and counts against the same group quota.
    object:='temporary/handoff/'||(r->>'chat_id')||'/'||p_item::text||'/'||p_id::text;
    v:=chat.file_transfer_reserve(p_id,'upload',auth.uid()::text,r->>'chat_id',p_reserve,object);
    INSERT INTO chat.file_blobs(bucket_id,object_name,content_type,created_by) VALUES('temporary',object,'application/octet-stream',auth.uid()::text) RETURNING id INTO b;
    INSERT INTO chat.file_transfer_uploads(staging_key,reservation_id,account_id,chat_id,actor_id,max_bytes)
    VALUES(object,p_id,auth.uid()::text,r->>'chat_id',actor,p_reserve);
    UPDATE chat.file_transfer_reservations SET state='issued' WHERE id=v.id;
    INSERT INTO chat.file_version_handoffs(id,item_id,base_version,chat_id,host_device_id,requester_account,requester_actor,file_name,content_type,
        size_bytes,sha256,message,object_name,ciphertext_bytes,blob_id)
    VALUES(p_id,p_item,p_expected,r->>'chat_id',r->>'host_device_id',auth.uid()::text,actor,p_name,p_type,p_size,p_sha,COALESCE(p_message,'{}'::jsonb),
        object,p_ciphertext,b);
    RETURN jsonb_build_object('status','uploading','handoff_id',p_id,'item_id',p_item,'staging_key',object,'max_bytes',p_reserve,
        'signed_at',v.created_at,'expires_at',v.expires_at)||host;
END $$;

-- Service only: which object the requester's commitment is checked against.
CREATE FUNCTION chat.file_version_handoff_upload(p_id uuid,p_account text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE h chat.file_version_handoffs%ROWTYPE;
BEGIN
    SELECT * INTO h FROM chat.file_version_handoffs WHERE id=p_id AND requester_account=p_account;
    IF NOT FOUND THEN RAISE EXCEPTION 'Handoff is not the caller''s' USING HINT='file_transfer_denied'; END IF;
    RETURN jsonb_build_object('object_name',h.object_name,'ciphertext_bytes',h.ciphertext_bytes,'state',h.state);
END $$;

-- Service only: the edge function has checked the stored ciphertext against this commitment.
CREATE FUNCTION chat.file_version_handoff_commit(p_id uuid,p_account text,p_sha text,p_size bigint,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h chat.file_version_handoffs%ROWTYPE; b uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    SELECT * INTO h FROM chat.file_version_handoffs WHERE id=p_id AND requester_account=p_account FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Handoff is not the caller''s' USING HINT='file_transfer_denied'; END IF;
    IF p_sha IS NULL OR p_sha!~'^[0-9a-f]{64}$' OR p_key IS NULL OR p_key!~'^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$'
       OR h.ciphertext_bytes IS DISTINCT FROM p_size THEN
        RAISE EXCEPTION 'Invalid next version commitment' USING HINT='file_transfer_conflict';
    END IF;
    IF h.state='ready' AND (h.ciphertext_sha256,h.data_key) IS NOT DISTINCT FROM (p_sha,p_key) THEN RETURN chat.file_version_handoff_status_of(h); END IF;
    IF h.state<>'uploading' OR NOT EXISTS(SELECT 1 FROM chat.file_transfer_reservations WHERE id=h.id AND state='issued' AND expires_at>now()) THEN
        RAISE EXCEPTION 'Handoff is no longer open' USING HINT='file_transfer_conflict';
    END IF;
    UPDATE chat.file_blobs SET sha256=p_sha,size_bytes=p_size WHERE id=h.blob_id AND bucket_id='temporary' AND object_name=h.object_name AND state='live' RETURNING id INTO b;
    IF NOT FOUND THEN RAISE EXCEPTION 'Handoff upload is being collected' USING HINT='file_transfer_conflict'; END IF;
    UPDATE chat.file_transfer_reservations SET actual_bytes=p_size WHERE id=h.id;
    PERFORM chat.file_transfer_track(b,h.chat_id,h.requester_actor);
    UPDATE chat.file_transfer_uploads SET blob_id=b WHERE reservation_id=h.id;
    UPDATE chat.file_version_handoffs SET state='ready',ciphertext_sha256=p_sha,data_key=p_key,ready_until=now()+interval '10 minutes'
        WHERE id=h.id RETURNING * INTO h;
    PERFORM realtime.send(jsonb_build_object('handoff_id',h.id),'files.handoff','gugu:'||h.host_device_id||':rpc',true);
    RETURN chat.file_version_handoff_status_of(h);
END $$;

-- What the host device has to write; never the key.
CREATE FUNCTION chat.file_version_handoff_pending(p_device text) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM identity.gugu_devices WHERE device_id=p_device AND user_id=auth.uid()) THEN
        RAISE EXCEPTION 'Device is not owned by the caller' USING HINT='file_transfer_denied';
    END IF;
    RETURN QUERY SELECT jsonb_build_object('id',h.id,'item_id',h.item_id,'base_version',h.base_version,'chat_id',h.chat_id,
            'host_device_id',h.host_device_id,'requester_actor',h.requester_actor,'file_name',h.file_name,'content_type',h.content_type,
            'size_bytes',h.size_bytes,'sha256',h.sha256,'ciphertext_bytes',h.ciphertext_bytes,'ciphertext_sha256',h.ciphertext_sha256,
            'relative_path',d.relative_path,'ready_until',h.ready_until)
        FROM chat.file_version_handoffs h JOIN chat.file_device_revisions d ON d.item_id=h.item_id AND d.version=h.base_version
        WHERE h.host_device_id=p_device AND h.state='ready' AND h.ready_until>now() ORDER BY h.created_at LIMIT 200;
END $$;

-- Service only: the host's download capability for the ciphertext, with its key, on the existing download budget.
CREATE FUNCTION chat.file_version_handoff_fetch(p_id uuid,p_host text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h chat.file_version_handoffs%ROWTYPE; v chat.file_transfer_reservations%ROWTYPE;
BEGIN
    SELECT * INTO h FROM chat.file_version_handoffs WHERE id=p_id;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM identity.gugu_devices d WHERE d.device_id=h.host_device_id AND d.user_id::text=p_host)
       OR NOT chat.is_chat_member(h.chat_id,p_host) THEN
        RAISE EXCEPTION 'Handoff is not for this host' USING HINT='file_transfer_denied';
    END IF;
    IF h.state<>'ready' OR h.ready_until<=now() THEN RAISE EXCEPTION 'Handoff is no longer ready' USING HINT='file_transfer_conflict'; END IF;
    v:=chat.file_transfer_reserve(gen_random_uuid(),'download',p_host,h.chat_id,h.ciphertext_bytes,h.object_name);
    UPDATE chat.file_transfer_reservations SET state='issued' WHERE id=v.id;
    RETURN jsonb_build_object('handoff_id',h.id,'object_name',h.object_name,'ciphertext_bytes',h.ciphertext_bytes,
        'ciphertext_sha256',h.ciphertext_sha256,'key',h.data_key,'download_id',v.id,'signed_at',v.created_at,'expires_at',v.expires_at);
END $$;

-- The host has kept the bytes in its project at p_path. The version is the requester's edit and the message is the
-- requester's: both were approved for this requester in file_version_handoff_request, and the message is sent under the
-- requester's own account, so every message rule (membership, acting as an own agent, group rules) applies to them now.
CREATE FUNCTION chat.file_version_handoff_publish(p_id uuid,p_path text,p_sha text,p_size bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h chat.file_version_handoffs%ROWTYPE; revision jsonb; sent_message jsonb; hint text;
    claims text:=current_setting('request.jwt.claims',true); sub text:=current_setting('request.jwt.claim.sub',true);
BEGIN
    SELECT * INTO h FROM chat.file_version_handoffs WHERE id=p_id FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM identity.gugu_devices d WHERE d.device_id=h.host_device_id AND d.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'Handoff is not for this host' USING HINT='file_transfer_denied';
    END IF;
    IF h.state<>'ready' OR h.ready_until<=now() THEN RETURN chat.file_version_handoff_status_of(h); END IF;
    IF (p_sha,p_size) IS DISTINCT FROM (h.sha256,h.size_bytes) THEN
        RAISE EXCEPTION 'Handoff bytes differ from the commitment' USING HINT='file_transfer_conflict';
    END IF;
    BEGIN
        revision:=file_private.publish_revision_by(h.item_id,h.chat_id,h.host_device_id,p_path,p_sha,p_size,h.file_name,h.content_type,
            h.base_version,NULL,h.requester_actor);
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS hint=PG_EXCEPTION_HINT;
        IF hint IS DISTINCT FROM 'file_transfer_conflict' THEN RAISE; END IF;
        UPDATE chat.file_version_handoffs SET state='retired',outcome='conflict',data_key=NULL WHERE id=h.id RETURNING * INTO h;
        RETURN chat.file_version_handoff_status_of(h);
    END;
    BEGIN
        PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',h.requester_account,'role','authenticated')::text,true);
        PERFORM set_config('request.jwt.claim.sub',h.requester_account,true);
        SELECT to_jsonb(sent) INTO sent_message FROM chat.send_message_idempotent(
            COALESCE(h.message->>'message_id',h.id::text),h.chat_id,h.requester_actor,
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(h.message->'to_user_ids','[]'::jsonb))),
            (revision->>'envelope')||chat.attachment_caption_suffix(h.message->>'caption'),
            'attachment',h.message->>'reply_to_message_id',h.message->>'thread_root_id',COALESCE((h.message->>'is_thread_root')::boolean,false),
            false,h.message->>'via_app',h.item_id,(revision->>'version')::integer
        ) AS sent;
        PERFORM set_config('request.jwt.claims',COALESCE(claims,''),true),set_config('request.jwt.claim.sub',COALESCE(sub,''),true);
    EXCEPTION WHEN OTHERS THEN
        PERFORM set_config('request.jwt.claims',COALESCE(claims,''),true),set_config('request.jwt.claim.sub',COALESCE(sub,''),true);
        RAISE;
    END;
    UPDATE chat.file_version_handoffs SET state='published',version=(revision->>'version')::integer,message_id=sent_message->>'id',data_key=NULL
        WHERE id=h.id RETURNING * INTO h;
    RETURN chat.file_version_handoff_status_of(h)||jsonb_build_object('message',sent_message);
END $$;

CREATE FUNCTION chat.file_version_handoff_status_of(h chat.file_version_handoffs) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT jsonb_build_object('handoff_id',(h).id,'item_id',(h).item_id,'base_version',(h).base_version,
        'status',CASE (h).state WHEN 'retired' THEN (h).outcome ELSE (h).state END,
        'version',(h).version,'message_id',(h).message_id,
        'current_version',(SELECT w.version FROM chat.workspace_items w WHERE w.id=(h).item_id))
        ||chat.file_version_handoff_host((h).host_device_id)
$$;

-- The requester's view. p_cancel withdraws a handoff the host has not written; once it is written it stays written.
CREATE FUNCTION chat.file_version_handoff_status(p_id uuid,p_cancel boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h chat.file_version_handoffs%ROWTYPE;
BEGIN
    SELECT * INTO h FROM chat.file_version_handoffs WHERE id=p_id AND requester_account=auth.uid()::text FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','gone'); END IF;
    IF h.state IN ('uploading','ready') AND (p_cancel OR h.state='ready' AND h.ready_until<=now()
        OR h.state='uploading' AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_reservations v WHERE v.id=h.id AND v.state='issued' AND v.expires_at>now())) THEN
        UPDATE chat.file_version_handoffs SET state='retired',outcome=CASE WHEN p_cancel THEN 'cancelled' ELSE 'expired' END,data_key=NULL
            WHERE id=h.id RETURNING * INTO h;
    END IF;
    RETURN chat.file_version_handoff_status_of(h);
END $$;

-- The sweep: open handoffs past their window are retired (their bytes collected); settled rows go after 30 days.
CREATE FUNCTION chat.file_version_handoff_expire(p_limit integer DEFAULT 500) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n integer;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid handoff expiry batch size'; END IF;
    WITH due AS (SELECT h.id FROM chat.file_version_handoffs h WHERE h.state IN ('uploading','ready') AND (h.state='ready' AND h.ready_until<=now()
            OR h.state='uploading' AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_reservations v WHERE v.id=h.id AND v.state='issued' AND v.expires_at>now()))
        ORDER BY h.created_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
    UPDATE chat.file_version_handoffs h SET state='retired',outcome='expired',data_key=NULL FROM due WHERE h.id=due.id;
    GET DIAGNOSTICS n=ROW_COUNT;
    DELETE FROM chat.file_version_handoffs WHERE state IN ('published','retired') AND created_at<now()-interval '30 days';
    RETURN n;
END $$;

REVOKE ALL ON FUNCTION chat.file_version_handoff_collect(),chat.file_version_handoff_host(text),
    chat.file_version_handoff_request(uuid,uuid,integer,text,text,bigint,text,bigint,bigint,jsonb,text),
    chat.file_version_handoff_upload(uuid,text),chat.file_version_handoff_commit(uuid,text,text,bigint,text),chat.file_version_handoff_pending(text),
    chat.file_version_handoff_fetch(uuid,text),chat.file_version_handoff_publish(uuid,text,text,bigint),chat.file_version_handoff_status_of(chat.file_version_handoffs),
    chat.file_version_handoff_status(uuid,boolean),chat.file_version_handoff_expire(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_project_policy_for(text,text),
    file_private.publish_revision(uuid,text,text,text,text,bigint,text,text,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_version_handoff_request(uuid,uuid,integer,text,text,bigint,text,bigint,bigint,jsonb,text),
    chat.file_version_handoff_pending(text),chat.file_version_handoff_publish(uuid,text,text,bigint),chat.file_version_handoff_status(uuid,boolean)
    TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_version_handoff_upload(uuid,text),chat.file_version_handoff_commit(uuid,text,text,bigint,text),chat.file_version_handoff_fetch(uuid,text),
    chat.file_version_handoff_expire(integer) TO service_role;
