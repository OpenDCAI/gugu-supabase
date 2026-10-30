-- Non-project permanent files expire by authenticated download activity, never by LRU.
-- Keep blob identity and references so existing upload/send can restore the same SHA.
ALTER TABLE chat.file_transfer_storage_refs ADD COLUMN last_download_at timestamptz;
-- Previously untracked downloads get a complete first retention interval after upgrade.
ALTER TABLE chat.file_transfer_storage_refs ADD COLUMN retention_started_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE chat.file_transfer_storage_refs ADD COLUMN expired_at timestamptz;
CREATE INDEX file_transfer_idle_refs ON chat.file_transfer_storage_refs
    (COALESCE(last_download_at,retention_started_at)) WHERE expired_at IS NULL;

CREATE FUNCTION chat.file_transfer_reference_expired(p_blob uuid,p_chat text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT EXISTS(SELECT 1 FROM chat.file_transfer_storage_refs r
        JOIN chat.file_transfer_storage o ON o.id=r.storage_id
        WHERE o.blob_id=p_blob AND r.chat_id=chat.file_transfer_group(p_chat) AND r.expired_at IS NOT NULL)
$$;
CREATE FUNCTION chat.file_transfer_expire(p_limit integer DEFAULT 500) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s jsonb; threshold_bytes bigint; idle_seconds bigint; r record; n integer:=0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid expiry batch size'; END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0)) THEN RETURN 0; END IF;
    SELECT settings INTO s FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*';
    -- Absent deployment policy preserves files; it never invents a deletion policy.
    IF NOT COALESCE(s ?& ARRAY['large_file_bytes','large_file_idle_seconds'],false) THEN RETURN 0; END IF;
    threshold_bytes:=chat.file_transfer_parameter(s,'large_file_bytes');
    idle_seconds:=chat.file_transfer_parameter(s,'large_file_idle_seconds');
    IF idle_seconds NOT BETWEEN 1 AND 2147483647 THEN RAISE EXCEPTION 'Invalid large file idle interval'; END IF;
    FOR r IN SELECT ref.storage_id,ref.chat_id,o.blob_id
        FROM chat.file_transfer_storage_refs ref JOIN chat.file_transfer_storage o ON o.id=ref.storage_id
        WHERE ref.expired_at IS NULL AND o.state='ready' AND o.blob_id IS NOT NULL
          AND o.size_bytes>threshold_bytes
          AND COALESCE(ref.last_download_at,ref.retention_started_at)<=now()-make_interval(secs=>idle_seconds::integer)
          AND NOT EXISTS(SELECT 1 FROM identity.device_projects p WHERE p.chat_id=ref.chat_id)
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

-- Preserve every original non-expiry protection, including private handoffs and legacy pointers.
CREATE OR REPLACE FUNCTION chat.file_blob_in_use(p_blob_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT EXISTS(SELECT 1 FROM chat.workspace_items w WHERE w.blob_id=p_blob_id
            AND NOT chat.file_transfer_reference_expired(p_blob_id,w.chat_id))
        OR EXISTS(SELECT 1 FROM chat.workspace_item_versions v JOIN chat.workspace_items w ON w.id=v.item_id
            WHERE v.blob_id=p_blob_id AND NOT chat.file_transfer_reference_expired(p_blob_id,w.chat_id))
        OR EXISTS(SELECT 1 FROM chat.file_blob_uploads u WHERE u.blob_id=p_blob_id AND u.expires_at>now())
        OR EXISTS(SELECT 1 FROM chat.messages m WHERE m.file_blob_id=p_blob_id
            AND NOT chat.file_transfer_reference_expired(p_blob_id,m.chat_id))
        OR EXISTS(SELECT 1 FROM chat.session_attachments a WHERE a.blob_id=p_blob_id AND a.revoked_at IS NULL)
        OR EXISTS(SELECT 1 FROM chat.file_transfer_reservations d JOIN chat.file_transfer_storage o
            ON d.subject='object:'||o.id::text WHERE o.blob_id=p_blob_id AND d.kind='download'
            AND d.expires_at>now() AND d.state IN ('reserved','issued'))
        OR EXISTS(SELECT 1 FROM chat.file_blobs b WHERE b.id=p_blob_id AND (
            EXISTS(SELECT 1 FROM chat.messages m WHERE m.storage_bucket_id=b.bucket_id AND m.storage_object_name=b.object_name
                AND NOT chat.file_transfer_reference_expired(p_blob_id,m.chat_id))
            OR EXISTS(SELECT 1 FROM chat.chats c WHERE c.avatar_storage_bucket_id=b.bucket_id AND c.avatar_storage_object_name=b.object_name)
            OR EXISTS(SELECT 1 FROM chat.group_outputs o WHERE o.storage_bucket_id=b.bucket_id AND o.storage_object_name=b.object_name)));
$$;

-- Extend existing entry points in place, guarded against a mismatched predecessor.
-- No compatibility RPC, second signer, restore endpoint or second physical GC.
DO $upgrade$
DECLARE r record; definition text;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('chat.file_transfer_download_as(jsonb,text,uuid)',
         $old$IF o.state<>'ready' OR o.size_bytes IS NULL THEN$old$,
         $new$IF EXISTS(SELECT 1 FROM chat.file_transfer_storage_refs WHERE storage_id=o.id AND chat_id=g AND expired_at IS NOT NULL) THEN
        RETURN r||jsonb_build_object('status','expired');
    END IF;
    IF o.state<>'ready' OR o.size_bytes IS NULL THEN$new$),
        ('chat.file_transfer_download_as(jsonb,text,uuid)',
         $old$UPDATE chat.file_transfer_reservations SET state='issued' WHERE id=v.id;$old$,
         $new$-- An approved fresh server request is activity; retries and provider logs are not.
    IF v.state='reserved' THEN
        UPDATE chat.file_transfer_storage_refs SET last_download_at=now() WHERE storage_id=o.id AND chat_id=g AND expired_at IS NULL;
    END IF;
    UPDATE chat.file_transfer_reservations SET state='issued' WHERE id=v.id;$new$),
        ('chat.file_managed_upload_registered(text,text)',
         $old$UPDATE chat.file_transfer_storage SET state='ready'
      WHERE bucket_id=b.bucket_id AND object_name=b.object_name;$old$,
         $new$IF u.blob_id IS NULL THEN
        UPDATE chat.file_transfer_storage SET state='ready' WHERE bucket_id=b.bucket_id AND object_name=b.object_name;
    END IF;$new$),
        ('chat.file_managed_upload_registered(text,text)',
         $old$UPDATE chat.file_transfer_uploads SET blob_id=b.id WHERE staging_key=p_key;$old$,
         $new$IF u.blob_id IS NULL THEN
        UPDATE chat.file_transfer_storage_refs SET expired_at=NULL,last_download_at=NULL,retention_started_at=now()
          WHERE storage_id=(SELECT id FROM chat.file_transfer_storage WHERE blob_id=b.id)
            AND chat_id=u.chat_id AND expired_at IS NOT NULL;
    END IF;
    UPDATE chat.file_transfer_uploads SET blob_id=b.id WHERE staging_key=p_key;$new$),
        ('chat.file_blob_register(text,text,text,bigint,text,integer,integer)',
         $old$PERFORM chat.file_blob_take(v_blob.id);$old$,
         $new$IF EXISTS(SELECT 1 FROM chat.file_transfer_storage o WHERE o.blob_id=v_blob.id AND o.state='gone') THEN
        -- Copy precedes registration; keep the old identity and verify the post-GC copy.
        v_created:=true;
    ELSE
        PERFORM chat.file_blob_take(v_blob.id);
    END IF;$new$),
        ('chat.file_blob_take(uuid)',
         $old$IF v_state = 'deleting' THEN$old$,
         $new$IF EXISTS(SELECT 1 FROM chat.file_transfer_storage WHERE blob_id=p_blob_id AND state='gone') THEN
        RAISE EXCEPTION 'File has expired; upload a new copy' USING HINT='file_transfer_expired';
    END IF;
    IF v_state = 'deleting' THEN$new$),
        ('chat.attachment_place_forward(text,text,text,text,boolean)',
         $old$-- ◇ 转成悄悄话:指同一份字节,不进目标的文件夹。$old$,
         $new$IF chat.file_transfer_reference_expired(v_blob_id,v_source.chat_id) THEN
        RAISE EXCEPTION 'File has expired; upload a new copy' USING HINT='file_transfer_expired';
    END IF;
    -- ◇ 转成悄悄话:指同一份字节,不进目标的文件夹。$new$),
        ('chat.attachment_place_share(uuid,integer,text,text,text)',
         $old$v_resource := chat.workspace_require_room_member(p_chat_id, p_sender_user_id);$old$,
         $new$IF chat.file_transfer_reference_expired(v_blob,v_item.chat_id) THEN
        RAISE EXCEPTION 'File has expired; upload a new copy' USING HINT='file_transfer_expired';
    END IF;
    v_resource := chat.workspace_require_room_member(p_chat_id, p_sender_user_id);$new$),
        ('chat.file_blob_gc_claim(integer,integer)',
         $old$IF p_limit < 1 OR p_limit > 500 OR p_stale_seconds < 30 THEN$old$,
         $new$IF NOT pg_try_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0)) THEN RETURN; END IF;
    IF p_limit < 1 OR p_limit > 500 OR p_stale_seconds < 30 THEN$new$),
        ('chat.file_blob_gc_claim(integer,integer)',
         $old$UPDATE chat.file_blobs b SET state = 'deleting' WHERE b.id = r.blob_id;$old$,
         $new$UPDATE chat.file_blobs b SET state = 'deleting' WHERE b.id = r.blob_id;
        UPDATE chat.file_transfer_storage o SET state='deleting' WHERE o.blob_id=r.blob_id;$new$),
        ('chat.file_blob_gc_finish(uuid,uuid)',
         $old$PERFORM 1 FROM chat.file_blob_gc g$old$,
         $new$PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    PERFORM 1 FROM chat.file_blob_gc g$new$),
        ('chat.file_blob_gc_finish(uuid,uuid)',
         $old$DELETE FROM chat.file_blobs b WHERE b.id = p_blob_id AND b.state = 'deleting';$old$,
         $new$-- Physical deletion succeeded before this call. Release capacity atomically.
    UPDATE chat.file_transfer_storage SET state='gone' WHERE blob_id=p_blob_id;
    IF EXISTS(SELECT 1 FROM chat.file_transfer_storage_refs ref JOIN chat.file_transfer_storage o ON o.id=ref.storage_id
        WHERE o.blob_id=p_blob_id AND ref.expired_at IS NOT NULL) THEN
        UPDATE chat.file_blobs SET state='live' WHERE id=p_blob_id AND state='deleting';
        IF NOT FOUND THEN RAISE EXCEPTION 'Expired blob is not being collected'; END IF;
        DELETE FROM chat.file_blob_gc WHERE blob_id=p_blob_id;
        RETURN;
    END IF;
    DELETE FROM chat.file_blobs b WHERE b.id = p_blob_id AND b.state = 'deleting';$new$)
    ) AS patches(signature,before_text,after_text)
    LOOP
        SELECT pg_get_functiondef(r.signature::regprocedure) INTO definition;
        IF position(r.before_text IN definition)=0 THEN RAISE EXCEPTION 'Unexpected predecessor: %',r.signature; END IF;
        EXECUTE replace(definition,r.before_text,r.after_text);
    END LOOP;
END $upgrade$;

CREATE FUNCTION chat.file_transfer_group_usage(p_chat text,p_as text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); g text:=chat.workspace_require_room_member(p_chat,actor);
    cfg jsonb:=chat.file_transfer_settings('group',g); used_bytes bigint; cap bigint; warning bigint;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM chat.chat_members WHERE chat_id=g AND user_id=actor AND role IN ('owner','admin')) THEN
        RAISE EXCEPTION 'Only group administrators can read group quota usage' USING HINT='file_transfer_denied';
    END IF;
    cap:=chat.file_transfer_parameter(cfg,'storage_group_bytes');
    warning:=chat.file_transfer_parameter(cfg,'storage_warning_percent');
    IF warning NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid storage warning percent'; END IF;
    used_bytes:=chat.file_transfer_usage('upload','group',g);
    RETURN jsonb_build_object('used_and_reserved_bytes',used_bytes,'limit_bytes',cap,
        'warning',used_bytes::numeric*100>=cap::numeric*warning,'full',used_bytes>=cap);
END $$;
REVOKE ALL ON FUNCTION chat.file_transfer_reference_expired(uuid,text),chat.file_transfer_expire(integer),
    chat.file_transfer_group_usage(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_transfer_expire(integer) TO service_role;
GRANT EXECUTE ON FUNCTION chat.file_transfer_group_usage(text,text) TO authenticated;

-- The installation DDL guard closes replaced functions too; restore only their existing API grants.
GRANT EXECUTE ON FUNCTION chat.file_transfer_download_as(jsonb,text,uuid),
    chat.attachment_place_forward(text,text,text,text,boolean),
    chat.attachment_place_share(uuid,integer,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_registered(text,text),
    chat.file_blob_register(text,text,text,bigint,text,integer,integer),
    chat.file_blob_gc_claim(integer,integer),chat.file_blob_gc_finish(uuid,uuid) TO service_role;

-- Completion now owns this update atomically; remove the superseded service-only second step.
DROP FUNCTION chat.file_transfer_object_gone(text,text);
