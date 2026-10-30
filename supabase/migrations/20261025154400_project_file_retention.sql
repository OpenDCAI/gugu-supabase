-- Temporary retention reuses inventory, held upload bytes and the existing collector. Permanent objects never enter LRU.
CREATE FUNCTION chat.file_temporary_usage(p_chat text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT COALESCE((SELECT sum(o.size_bytes) FROM chat.file_transfer_storage o WHERE o.bucket_id='temporary' AND o.state<>'gone'
        AND EXISTS(SELECT 1 FROM chat.file_transfer_storage_refs r WHERE r.storage_id=o.id AND r.chat_id=p_chat)),0)
        +COALESCE((SELECT sum(greatest(0,bytes-actual_bytes)) FROM chat.file_transfer_reservations WHERE chat_id=p_chat
            AND kind='upload' AND state IN ('reserved','issued') AND subject LIKE 'temporary/%'),0)
$$;
CREATE FUNCTION chat.file_temporary_collect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF OLD.blob_id IS NOT NULL AND (TG_OP='DELETE' OR NEW.state='retired' AND OLD.state<>'retired') THEN
        PERFORM chat.file_blob_enqueue(OLD.blob_id);
        UPDATE chat.file_blob_gc SET next_attempt_at=now() WHERE blob_id=OLD.blob_id AND status<>'running';
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER file_temporary_collect AFTER UPDATE OF state OR DELETE ON chat.file_temporary_transfers FOR EACH ROW EXECUTE FUNCTION chat.file_temporary_collect();

CREATE FUNCTION chat.file_temporary_expire(p_limit integer DEFAULT 500,p_request uuid DEFAULT NULL,p_host text DEFAULT NULL,p_needed bigint DEFAULT 0) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t chat.file_temporary_transfers%ROWTYPE; n integer:=0; g text; needed bigint; cfg jsonb; available bigint;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid temporary expiry batch size'; END IF;
    IF p_request IS NOT NULL THEN g:=chat.file_temporary_host_for(p_request,p_host)->>'chat_id'; END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0)) THEN RETURN 0; END IF;
    IF NOT EXISTS(SELECT 1 FROM chat.file_temporary_transfers WHERE state<>'retired') THEN RETURN 0; END IF;
    cfg:=chat.file_transfer_settings();
    FOR t IN SELECT * FROM chat.file_temporary_transfers WHERE state<>'retired' AND
        (NOT chat.file_temporary_current(file_temporary_transfers) OR state='ready' AND (serve_until<=now() OR created_at<=now()-interval '30 days')
         OR state='requested' AND created_at<=now()-make_interval(secs=>chat.file_transfer_parameter(cfg,'upload_permit_seconds')::integer)
         OR state='uploading' AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_reservations v WHERE v.id=file_temporary_transfers.id AND v.state='issued' AND v.expires_at>now()))
        ORDER BY created_at LIMIT p_limit FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE chat.file_temporary_transfers SET state='retired',data_key=NULL WHERE id=t.id;
        n:=n+1;
    END LOOP;
    IF g IS NULL THEN RETURN n; END IF;
    cfg:=chat.file_transfer_settings('group',g);
    IF p_needed IS NULL OR p_needed<1 OR p_needed>chat.file_transfer_parameter(cfg,'temporary_group_bytes')
       OR p_needed>chat.file_transfer_parameter(cfg,'file_max_bytes') THEN
        RAISE EXCEPTION 'Temporary upload exceeds configured limits' USING HINT='file_transfer_too_large';
    END IF;
    IF EXISTS(SELECT 1 FROM chat.file_transfer_reservations WHERE id=p_request) THEN RETURN n; END IF;
    available:=least(chat.file_transfer_parameter(cfg,'temporary_group_bytes')-chat.file_temporary_usage(g),
        chat.file_transfer_parameter(cfg,'storage_group_bytes')-chat.file_transfer_usage('upload','group',g));
    needed:=p_needed-available;
    -- Retire only confirmed temporary generations. Capacity is still held until physical deletion succeeds.
    FOR t IN SELECT generation.* FROM chat.file_temporary_transfers generation
        JOIN chat.file_transfer_storage o ON o.blob_id=generation.blob_id AND o.bucket_id='temporary' AND o.state='ready'
        JOIN chat.file_transfer_storage_refs ref ON ref.storage_id=o.id AND ref.chat_id=g
        WHERE generation.chat_id=g AND generation.state='ready'
        ORDER BY COALESCE(ref.last_download_at,generation.created_at),generation.id LIMIT p_limit FOR UPDATE OF generation SKIP LOCKED
    LOOP
        EXIT WHEN needed<=0;
        UPDATE chat.file_temporary_transfers SET state='retired',data_key=NULL WHERE id=t.id;
        needed:=needed-t.ciphertext_bytes; n:=n+1;
    END LOOP;
    RETURN n;
END $$;

-- Keep active uploads alive even after their source is removed; a signed upload can still arrive until its deadline.
DO $gc$ DECLARE definition text; fence text:='SELECT EXISTS'; BEGIN
    SELECT pg_get_functiondef('chat.file_blob_in_use(uuid)'::regprocedure) INTO definition;
    IF position(fence IN definition)=0 THEN RAISE EXCEPTION 'Missing blob retention predecessor'; END IF;
    EXECUTE replace(definition,fence,$body$SELECT EXISTS(SELECT 1 FROM chat.file_temporary_transfers t WHERE t.blob_id=p_blob_id AND t.state='ready'
        AND t.serve_until>now() AND t.created_at>now()-interval '30 days' AND chat.file_temporary_current(t))
        OR EXISTS(SELECT 1 FROM chat.file_blobs b JOIN chat.file_transfer_reservations v ON v.subject=b.object_name
            WHERE b.id=p_blob_id AND b.bucket_id='temporary' AND v.kind='upload' AND v.state IN ('reserved','issued') AND v.expires_at>now())
        OR EXISTS$body$);
    SELECT pg_get_functiondef('chat.file_blob_gc_kick()'::regprocedure) INTO definition;
    IF position('PERFORM chat.file_transfer_expire(500);' IN definition)=0 THEN RAISE EXCEPTION 'Missing idle scheduler predecessor'; END IF;
    EXECUTE replace(definition,'PERFORM chat.file_transfer_expire(500);','PERFORM chat.file_temporary_expire(500); PERFORM chat.file_transfer_expire(500);');
END $gc$;
REVOKE ALL ON FUNCTION chat.file_temporary_usage(text),chat.file_temporary_collect(),chat.file_temporary_expire(integer,uuid,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_temporary_expire(integer,uuid,text,bigint) TO service_role;
