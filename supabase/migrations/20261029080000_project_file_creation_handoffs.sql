-- #577/#791. A new file message on another machine uses the same encrypted handoff and host transaction.
-- NULL base_version means creation of v1, never a fabricated existing revision or an empty workspace placeholder.
ALTER TABLE chat.file_version_handoffs ALTER COLUMN base_version DROP NOT NULL;
ALTER TABLE chat.file_version_handoffs ADD CONSTRAINT file_version_handoffs_base_version_check
    CHECK(base_version IS NULL OR base_version>=1);

CREATE FUNCTION chat.file_version_handoff_request(p_id uuid,p_item uuid,p_expected integer,p_name text,p_type text,p_size bigint,
    p_sha text,p_ciphertext bigint,p_reserve bigint,p_message jsonb,p_as text,p_chat text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); r jsonb; host jsonb; h chat.file_version_handoffs%ROWTYPE;
    v chat.file_transfer_reservations%ROWTYPE; cfg jsonb; b uuid; object text; g text;
BEGIN
    IF p_expected IS NULL THEN
        IF p_chat IS NULL THEN RAISE EXCEPTION 'A new file needs its chat' USING HINT='file_transfer_invalid'; END IF;
        g:=chat.workspace_require_room_member(p_chat,actor);
    ELSIF p_expected<1 OR p_chat IS NOT NULL THEN
        RAISE EXCEPTION 'Choose a new file chat or an existing version' USING HINT='file_transfer_invalid';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    SELECT * INTO h FROM chat.file_version_handoffs WHERE id=p_id;
    IF FOUND THEN
        IF (h.requester_account,h.requester_actor,h.item_id,h.base_version,h.sha256,h.size_bytes)
           IS DISTINCT FROM (auth.uid()::text,actor,p_item,p_expected,p_sha,p_size)
           OR p_expected IS NULL AND (h.chat_id,h.file_name,h.content_type,h.ciphertext_bytes,h.message)
              IS DISTINCT FROM (g,p_name,p_type,p_ciphertext,COALESCE(p_message,'{}'::jsonb)||jsonb_build_object('chat_id',p_chat)) THEN
            RAISE EXCEPTION 'Handoff identity is immutable' USING HINT='file_transfer_conflict';
        END IF;
        RETURN chat.file_version_handoff_status(p_id,false);
    END IF;
    IF p_expected IS NULL THEN
        r:=chat.file_project_policy_for(g,actor);
        IF r IS NULL OR (r->>'proactive_upload')::boolean THEN
            RAISE EXCEPTION 'This chat does not keep new files on a host' USING HINT='file_transfer_invalid';
        END IF;
        IF EXISTS(SELECT 1 FROM chat.workspace_items WHERE id=p_item) THEN
            RAISE EXCEPTION 'File revision conflict' USING HINT='file_transfer_conflict';
        END IF;
    ELSE
        r:=chat.file_resolve_as(jsonb_build_object('item_id',p_item),actor);
        IF r->>'status'<>'ready' THEN RETURN r; END IF;
        IF r->>'source'<>'local' THEN
            RAISE EXCEPTION 'This file is not kept on a host machine' USING HINT='file_transfer_invalid';
        END IF;
    END IF;
    IF NOT chat.can_act_as(actor,r->>'chat_id') THEN
        RAISE EXCEPTION 'A file can be sent only as yourself or your own agent in this chat' USING HINT='file_transfer_denied';
    END IF;
    IF p_expected IS NOT NULL AND (r->>'current_version')::integer IS DISTINCT FROM p_expected THEN
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
    -- A topic shares its source's files and quota, but the message stays in the requested conversation.
    IF p_expected IS NULL THEN p_message:=COALESCE(p_message,'{}'::jsonb)||jsonb_build_object('chat_id',p_chat); END IF;
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

-- Keep the existing positional/named RPC signature; it delegates to the same implementation.
CREATE OR REPLACE FUNCTION chat.file_version_handoff_request(p_id uuid,p_item uuid,p_expected integer,p_name text,p_type text,p_size bigint,
    p_sha text,p_ciphertext bigint,p_reserve bigint,p_message jsonb,p_as text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    SELECT chat.file_version_handoff_request(p_id,p_item,p_expected,p_name,p_type,p_size,p_sha,p_ciphertext,p_reserve,p_message,p_as,NULL::text)
$$;

-- The base-revision FK still protects edits. Creations have no base row and must also reach the existing drain.
DO $pending$ DECLARE definition text; BEGIN
    SELECT pg_get_functiondef('chat.file_version_handoff_pending(text)'::regprocedure) INTO definition;
    IF position('FROM chat.file_version_handoffs h JOIN chat.file_device_revisions d' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected handoff pending predecessor';
    END IF;
    EXECUTE replace(definition,'FROM chat.file_version_handoffs h JOIN chat.file_device_revisions d',
        'FROM chat.file_version_handoffs h LEFT JOIN chat.file_device_revisions d');
END $pending$;

DO $message$ DECLARE definition text; BEGIN
    SELECT pg_get_functiondef('chat.file_version_handoff_publish(uuid,text,text,bigint)'::regprocedure) INTO definition;
    IF position('COALESCE(h.message->>''message_id'',h.id::text),h.chat_id,h.requester_actor,' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected handoff message predecessor';
    END IF;
    EXECUTE replace(definition,'COALESCE(h.message->>''message_id'',h.id::text),h.chat_id,h.requester_actor,',
        'COALESCE(h.message->>''message_id'',h.id::text),COALESCE(h.message->>''chat_id'',h.chat_id),h.requester_actor,');
END $message$;

-- Attribution comes only from the validated request, through the already-private publisher.
-- Its NULL p_by behavior for the host's own new files is unchanged.
DO $by$ DECLARE definition text; BEGIN
    SELECT pg_get_functiondef('file_private.publish_revision_by(uuid,text,text,text,text,bigint,text,text,integer,uuid,text)'::regprocedure) INTO definition;
    IF position('size_bytes,created_by,parent_id)' IN definition)=0 OR position('p_size,auth.uid()::text,p_parent);' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected publisher creation predecessor';
    END IF;
    definition:=replace(definition,'size_bytes,created_by,parent_id)','size_bytes,created_by,updated_by,parent_id)');
    definition:=replace(definition,'p_size,auth.uid()::text,p_parent);','p_size,COALESCE(p_by,auth.uid()::text),p_by,p_parent);');
    EXECUTE definition;
END $by$;
REVOKE ALL ON FUNCTION file_private.publish_revision_by(uuid,text,text,text,text,bigint,text,text,integer,uuid,text)
    FROM PUBLIC,anon,authenticated;

-- The foundation re-closes replaced chat functions too. Restore only their intended callers after all replacements.
REVOKE ALL ON FUNCTION chat.file_version_handoff_request(uuid,uuid,integer,text,text,bigint,text,bigint,bigint,jsonb,text),
    chat.file_version_handoff_request(uuid,uuid,integer,text,text,bigint,text,bigint,bigint,jsonb,text,text),
    chat.file_version_handoff_pending(text),chat.file_version_handoff_publish(uuid,text,text,bigint)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_version_handoff_request(uuid,uuid,integer,text,text,bigint,text,bigint,bigint,jsonb,text),
    chat.file_version_handoff_request(uuid,uuid,integer,text,text,bigint,text,bigint,bigint,jsonb,text,text),
    chat.file_version_handoff_pending(text),chat.file_version_handoff_publish(uuid,text,text,bigint)
    TO authenticated;
