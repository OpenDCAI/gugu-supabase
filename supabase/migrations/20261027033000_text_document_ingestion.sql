-- Text uploads enter the existing document editor. Blob bytes and pinned message versions stay immutable.
-- The Edge entry point uses the canonical client classifier at an immutable source revision; no second type table.
-- Large-document tiering is a separate release: kind stays document, threshold is configurable (128 KiB),
-- and it reuses the existing maintenance clock and blob GC only after zero providers, durable storage and CAS.

ALTER TABLE chat.file_blob_uploads ADD COLUMN document jsonb;
ALTER TABLE chat.file_blob_uploads ADD CONSTRAINT file_blob_uploads_document_shape CHECK (
    document IS NULL OR jsonb_typeof(document) IS NOT DISTINCT FROM 'object' AND jsonb_typeof(document->'text') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof(document->'content_type') IS NOT DISTINCT FROM 'string' AND octet_length(document->>'text')<=1048576);
-- A document version may retain its verified text projection beside the immutable original blob.
ALTER TABLE chat.workspace_item_versions DROP CONSTRAINT workspace_item_versions_one_body;
ALTER TABLE chat.workspace_item_versions ADD CONSTRAINT workspace_item_versions_one_body
    CHECK ((device_version IS NULL AND num_nonnulls(inline_text,blob_id)>=1)
        OR (device_version IS NOT NULL AND device_version=n AND inline_text IS NULL AND blob_id IS NULL));

DROP FUNCTION chat.file_managed_upload_registered(text,text);
CREATE OR REPLACE FUNCTION chat.file_managed_upload_registered(p_key text,p_user text,p_document jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u chat.file_transfer_uploads%ROWTYPE; b chat.file_blobs%ROWTYPE; receipt chat.file_blob_uploads%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    SELECT * INTO u FROM chat.file_transfer_uploads WHERE staging_key=p_key AND account_id=p_user FOR UPDATE;
    SELECT * INTO receipt FROM chat.file_blob_uploads WHERE staging_key=p_key AND uploader=p_user;
    SELECT * INTO b FROM chat.file_blobs WHERE id=receipt.blob_id;
    IF u.staging_key IS NULL OR b.id IS NULL OR b.size_bytes>u.max_bytes OR u.blob_id IS NOT NULL AND u.blob_id<>b.id THEN
        RAISE EXCEPTION 'Upload registration is not within its reservation' USING HINT='file_transfer_conflict';
    END IF;
    PERFORM chat.file_transfer_track(b.id,u.chat_id,p_user);
    IF u.blob_id IS NULL THEN
        UPDATE chat.file_transfer_storage SET state='ready' WHERE bucket_id=b.bucket_id AND object_name=b.object_name;
    END IF;
    IF receipt.item_id IS NOT NULL AND receipt.document-'prepared' IS DISTINCT FROM p_document THEN
        RAISE EXCEPTION 'Committed upload classification cannot change' USING HINT='file_transfer_conflict';
    END IF;
    UPDATE chat.file_blob_uploads SET document=CASE WHEN receipt.document-'prepared' IS NOT DISTINCT FROM p_document THEN receipt.document ELSE p_document END WHERE staging_key=p_key;
    IF u.blob_id IS NULL THEN
        UPDATE chat.file_transfer_storage_refs SET expired_at=NULL,last_download_at=NULL,retention_started_at=now()
          WHERE storage_id=(SELECT id FROM chat.file_transfer_storage WHERE blob_id=b.id)
            AND chat_id=u.chat_id AND expired_at IS NOT NULL;
    END IF;
    UPDATE chat.file_transfer_uploads SET blob_id=b.id WHERE staging_key=p_key;
    UPDATE chat.file_transfer_reservations SET actual_bytes=b.size_bytes WHERE id=u.reservation_id;
END $$;
REVOKE ALL ON FUNCTION chat.file_managed_upload_registered(text,text,jsonb) FROM PUBLIC,anon,authenticated,gugu_files;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_registered(text,text,jsonb) TO service_role;

-- Private: only inspected bytes, either from registration or the service-only old-item importer, reach this function.
CREATE FUNCTION chat.workspace_import_document(p_item uuid,p_version integer,p_blob uuid,p_document jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w chat.workspace_items%ROWTYPE;
BEGIN
    IF p_document IS NULL OR jsonb_typeof(p_document->'text') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_document->'content_type') IS DISTINCT FROM 'string'
       OR octet_length(p_document->>'text')>1048576 THEN
        RAISE EXCEPTION 'Verified document content is required';
    END IF;
    SELECT * INTO w FROM chat.workspace_items WHERE id=p_item FOR UPDATE;
    IF w.kind='document' AND EXISTS(SELECT 1 FROM chat.workspace_item_versions WHERE item_id=w.id AND n=p_version AND blob_id=p_blob) THEN RETURN false; END IF;
    IF NOT FOUND OR w.version IS DISTINCT FROM p_version OR w.blob_id IS DISTINCT FROM p_blob THEN
        RAISE EXCEPTION 'File changed during document import' USING HINT='workspace_version_conflict';
    END IF;
    IF w.kind<>'file' OR w.ystate IS NOT NULL THEN RAISE EXCEPTION 'Only stored files are imported'; END IF;
    -- Record the original bytes before the ordinary file service starts recording document edit rounds.
    INSERT INTO chat.workspace_item_versions(item_id,n,blob_id,inline_text,content_type,size_bytes,made_by,made_at)
    VALUES(w.id,w.version,w.blob_id,p_document->>'text',p_document->>'content_type',w.size_bytes,w.created_by,w.updated_at)
    ON CONFLICT(item_id,n) DO UPDATE SET inline_text=EXCLUDED.inline_text
      WHERE chat.workspace_item_versions.blob_id=EXCLUDED.blob_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Original version does not match the inspected blob'; END IF;
    UPDATE chat.workspace_items SET kind='document',inline_text=p_document->>'text',
      content_type=p_document->>'content_type' WHERE id=w.id;
    RETURN true;
END $$;
REVOKE ALL ON FUNCTION chat.workspace_import_document(uuid,integer,uuid,jsonb) FROM PUBLIC,anon,authenticated,gugu_files;
GRANT EXECUTE ON FUNCTION chat.workspace_import_document(uuid,integer,uuid,jsonb) TO service_role;

CREATE FUNCTION chat.workspace_ingest_upload(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u chat.file_blob_uploads%ROWTYPE;
BEGIN
    SELECT * INTO u FROM chat.file_blob_uploads WHERE staging_key=p_key;
    IF u.document IS NOT NULL AND u.item_id IS NOT NULL AND EXISTS(SELECT 1 FROM chat.workspace_items WHERE id=u.item_id AND kind='file') THEN
        PERFORM chat.workspace_import_document(u.item_id,u.item_version,u.blob_id,u.document);
    END IF;
END $$;
REVOKE ALL ON FUNCTION chat.workspace_ingest_upload(text) FROM PUBLIC,anon,authenticated,service_role,gugu_files;

-- One-shot importer pagination: all candidates still go through the same byte classifier, never a SQL suffix table.
CREATE FUNCTION chat.workspace_document_import_candidates(p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS TABLE(id uuid,version integer,blob_id uuid,filename text,content_type text,bucket_id text,object_name text,size_bytes bigint,sha256 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT w.id,w.version,w.blob_id,w.filename,w.content_type,b.bucket_id,b.object_name,b.size_bytes,b.sha256
      FROM chat.workspace_items w JOIN chat.file_blobs b ON b.id=w.blob_id
     WHERE w.kind='file' AND b.size_bytes<=1048576 AND NOT chat.file_transfer_reference_expired(b.id,w.chat_id)
       AND (p_after IS NULL OR w.id>p_after) ORDER BY w.id LIMIT LEAST(GREATEST(p_limit,1),20);
$$;
REVOKE ALL ON FUNCTION chat.workspace_document_import_candidates(uuid,integer) FROM PUBLIC,anon,authenticated,gugu_files;
GRANT EXECUTE ON FUNCTION chat.workspace_document_import_candidates(uuid,integer) TO service_role;

-- Import changes representation, not the author's content or edit timestamp.
CREATE OR REPLACE FUNCTION chat.set_workspace_item_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
    IF (NEW.inline_text IS DISTINCT FROM OLD.inline_text AND NOT
          (OLD.kind='file' AND NEW.kind='document' AND NEW.blob_id IS NOT NULL))
       OR NEW.blob_id IS DISTINCT FROM OLD.blob_id
       OR (NEW.kind='file' AND NEW.blob_id IS NULL AND NEW.version IS DISTINCT FROM OLD.version) THEN
        NEW.updated_at:=now();
    ELSE
        NEW.updated_at:=OLD.updated_at;
        NEW.updated_by:=OLD.updated_by;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION chat.set_workspace_item_updated_at() FROM PUBLIC,anon,authenticated,service_role,gugu_files;

CREATE FUNCTION chat.workspace_document_payload(p_item uuid,p_version integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT jsonb_build_object('text',v.inline_text,'content_type',v.content_type)
    FROM chat.workspace_item_versions v JOIN chat.workspace_items w ON w.id=v.item_id
    WHERE v.item_id=p_item AND v.n=p_version AND w.kind='document' AND v.inline_text IS NOT NULL AND v.blob_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION chat.workspace_document_payload(uuid,integer) FROM PUBLIC,anon,authenticated,service_role,gugu_files;

-- One-use authorization on the existing upload receipt; only the verified file service may prepare it.
CREATE FUNCTION chat.files_replace_stage(p_item uuid,p_user text,p_actor text,p_key text,p_expected integer,p_prepared jsonb DEFAULT NULL,p_finish boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w chat.workspace_items%ROWTYPE; u chat.file_blob_uploads%ROWTYPE; base text;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM chat.files_authorize(p_item,p_user,p_actor)) THEN RAISE EXCEPTION 'File not found' USING HINT='file_transfer_denied'; END IF;
    SELECT * INTO w FROM chat.workspace_items WHERE id=p_item;
    SELECT * INTO u FROM chat.file_blob_uploads WHERE staging_key=p_key FOR UPDATE;
    IF u.uploader IS DISTINCT FROM p_user OR w.kind<>'document' OR u.document IS NULL THEN RAISE EXCEPTION 'Verified text upload required' USING HINT='file_place_invalid'; END IF;
    IF p_finish THEN
        IF u.document->'prepared'->>'item' IS DISTINCT FROM p_item::text OR u.document->'prepared'->>'actor' IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'Replacement receipt changed'; END IF;
        IF u.item_id IS NULL THEN UPDATE chat.file_blob_uploads SET document=document-'prepared' WHERE staging_key=p_key;
        ELSIF u.item_id IS DISTINCT FROM p_item THEN RAISE EXCEPTION 'Upload already used'; END IF;
        RETURN jsonb_build_object('epoch',CASE WHEN u.item_id=p_item THEN (u.document->'prepared'->>'epoch')::integer+1 ELSE NULL END);
    END IF;
    IF u.item_id=p_item THEN RETURN jsonb_build_object('committed',true); END IF;
    IF u.item_id IS NOT NULL OR u.expires_at<=clock_timestamp() OR w.version IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'File version changed' USING HINT='workspace_version_conflict'; END IF;
    SELECT inline_text INTO base FROM chat.workspace_item_versions WHERE item_id=p_item AND blob_id=chat.workspace_version_blob(p_item,p_expected) ORDER BY n DESC LIMIT 1;
    IF base IS NULL THEN RAISE EXCEPTION 'The referenced version has no text projection' USING HINT='workspace_version_conflict'; END IF;
    IF p_prepared IS NOT NULL THEN
        IF (p_prepared->>'epoch')::integer IS DISTINCT FROM w.epoch OR jsonb_typeof(p_prepared->'state') IS DISTINCT FROM 'string'
           OR jsonb_typeof(p_prepared->'text') IS DISTINCT FROM 'string' OR octet_length(p_prepared->>'text')>1048576 THEN RAISE EXCEPTION 'Document changed' USING HINT='workspace_version_conflict'; END IF;
        UPDATE chat.file_blob_uploads SET document=jsonb_set(document,'{prepared}',p_prepared||jsonb_build_object('item',p_item,'actor',p_actor,'expected',p_expected,'expires',clock_timestamp()+interval '30 seconds')) WHERE staging_key=p_key;
    END IF;
    RETURN jsonb_build_object('epoch',w.epoch,'text',base,'document',u.document);
END $$;
REVOKE ALL ON FUNCTION chat.files_replace_stage(uuid,text,text,text,integer,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.files_replace_stage(uuid,text,text,text,integer,jsonb,boolean) TO gugu_files;

-- Amend only existing ingestion/message guards; retain their membership, version and envelope checks.
DO $text_ingest$
DECLARE r record; definition text;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('chat.file_replace_as(text,text,text,integer)',
         $old$        IF v_item.kind <> 'file' THEN
$old$,
         $new$        IF v_item.kind='document' AND (v_upload.document->'prepared'->>'item' IS DISTINCT FROM v_item.id::text
           OR v_upload.document->'prepared'->>'actor' IS DISTINCT FROM v_actor
           OR (v_upload.document->'prepared'->>'expected')::integer IS DISTINCT FROM p_expected_version
           OR (v_upload.document->'prepared'->>'epoch')::integer IS DISTINCT FROM v_item.epoch
           OR (v_upload.document->'prepared'->>'expires')::timestamptz<=clock_timestamp()) THEN
            RAISE EXCEPTION 'Document replacement is not prepared or has expired' USING HINT='workspace_version_conflict';
        END IF;
        IF v_item.kind NOT IN ('file','document') THEN
$new$),
        ('chat.file_replace_as(text,text,text,integer)',
         $old$        IF v_upload.blob_id = v_item.blob_id THEN
$old$,
         $new$        IF v_item.kind='file' AND v_upload.blob_id = v_item.blob_id THEN
$new$),
        ('chat.file_replace_as(text,text,text,integer)',
         $old$        v_next := v_item.version + 1;
$old$,
         $new$        v_next := CASE WHEN v_item.kind='document' AND v_upload.blob_id=chat.workspace_version_blob(v_item.id,v_item.version) THEN v_item.version
            ELSE GREATEST(v_item.version,(SELECT COALESCE(max(n),0) FROM chat.workspace_item_versions WHERE item_id=v_item.id))+1 END;
$new$),
        ('chat.file_replace_as(text,text,text,integer)',
         $old$        VALUES (v_item.id, v_next, v_blob.id, v_blob.content_type, v_blob.size_bytes, v_actor);
        UPDATE chat.workspace_items w
           SET blob_id = v_blob.id, size_bytes = v_blob.size_bytes, content_type = v_blob.content_type, version = v_next, updated_by = v_actor
         WHERE w.id = v_item.id;
        UPDATE chat.file_blob_uploads u SET item_id = v_item.id, item_version = v_next WHERE u.staging_key = p_staging_key;
$old$,
         $new$        VALUES (v_item.id, v_next, v_blob.id, v_blob.content_type, v_blob.size_bytes, v_actor) ON CONFLICT(item_id,n) DO NOTHING;
        IF v_item.kind='document' THEN
            UPDATE chat.workspace_item_versions SET inline_text=v_upload.document->>'text' WHERE item_id=v_item.id AND n=v_next;
            UPDATE chat.workspace_items w SET ystate=decode(v_upload.document->'prepared'->>'state','hex'),inline_text=v_upload.document->'prepared'->>'text',epoch=w.epoch+1 WHERE w.id=v_item.id;
        END IF;
        UPDATE chat.workspace_items w SET blob_id=v_blob.id,version=v_next,updated_by=v_actor,
            content_type=CASE WHEN v_item.kind='document' THEN v_upload.document->>'content_type' ELSE v_blob.content_type END,
            size_bytes=CASE WHEN v_item.kind='document' THEN octet_length(v_upload.document->'prepared'->>'text') ELSE v_blob.size_bytes END WHERE w.id=v_item.id;
        UPDATE chat.file_blob_uploads u SET item_id=v_item.id,item_version=v_next,
            document=CASE WHEN v_item.kind='document' THEN jsonb_set(u.document,'{prepared}',(u.document->'prepared')-'state'-'text') ELSE u.document END WHERE u.staging_key=p_staging_key;
$new$),
        ('chat.files_record_version(uuid,text,text)',
         $old$       AND v.n NOT IN (SELECT k.n FROM chat.workspace_item_versions k WHERE k.item_id = p_item_id ORDER BY k.n DESC LIMIT v_keep);
$old$,
         $new$       AND v.n NOT IN (SELECT k.n FROM chat.workspace_item_versions k WHERE k.item_id = p_item_id ORDER BY k.n DESC LIMIT v_keep)
       AND NOT EXISTS(SELECT 1 FROM chat.messages m WHERE m.file_item_id=v.item_id AND m.file_version=v.n);
$new$),
        ('chat.file_place_as(text,text,text,text,text,text[])',
         $old$    END IF;
    RETURN QUERY
$old$,
         $new$    END IF;
    PERFORM chat.workspace_ingest_upload(p_staging_key);
    RETURN QUERY
$new$),
        ('chat.attachment_place(text,text,text,text,text,boolean)',
         $old$     WHERE u.staging_key = p_staging_key;
    RETURN QUERY SELECT v_item.id, v_item.version, v_envelope, NULL::UUID;
$old$,
         $new$     WHERE u.staging_key = p_staging_key;
    PERFORM chat.workspace_ingest_upload(p_staging_key);
    RETURN QUERY SELECT v_item.id, v_item.version, v_envelope, NULL::UUID;
$new$),
        ('chat.messages_file_ref()',
         $old$    SELECT * INTO v_item FROM chat.workspace_items w WHERE w.id = NEW.file_item_id FOR SHARE;
    IF NOT FOUND OR v_item.chat_id IS DISTINCT FROM v_resource OR v_item.kind <> 'file' THEN
        RAISE EXCEPTION USING HINT = 'message_file_not_here',
$old$,
         $new$    SELECT * INTO v_item FROM chat.workspace_items w WHERE w.id = NEW.file_item_id FOR SHARE;
    IF NOT FOUND OR v_item.chat_id IS DISTINCT FROM v_resource OR v_item.kind = 'folder' THEN
        RAISE EXCEPTION USING HINT = 'message_file_not_here',
$new$),
        ('chat.attachment_item_for(text,uuid,text,text,text)',
         $old$    SELECT * INTO v_item FROM chat.workspace_items w
     WHERE w.chat_id = p_chat_id AND w.parent_id = v_folder AND w.kind = 'file' AND w.blob_id = p_blob_id
       AND chat.workspace_same_series(w.name_key, v_stored)
$old$,
         $new$    SELECT * INTO v_item FROM chat.workspace_items w
     WHERE w.chat_id = p_chat_id AND w.parent_id = v_folder AND w.kind IN ('file','document') AND chat.workspace_version_blob(w.id,w.version)=p_blob_id
       AND chat.workspace_same_series(w.name_key, v_stored)
$new$),
        ('chat.attachment_place_share(uuid,integer,text,text,text)',
         $old$    v_item := chat.workspace_item_for(p_item_id::TEXT, p_sender_user_id, false);
    IF v_item.kind <> 'file' THEN
        RAISE EXCEPTION USING HINT = 'file_place_invalid',
$old$,
         $new$    v_item := chat.workspace_item_for(p_item_id::TEXT, p_sender_user_id, false);
    IF v_item.kind = 'folder' THEN
        RAISE EXCEPTION USING HINT = 'file_place_invalid',
$new$),
        ('chat.attachment_place_share(uuid,integer,text,text,text)',
         $old$    v_placed := chat.attachment_item_for(p_chat_id, v_blob, v_item.filename, p_sender_user_id, p_message_id);
    RETURN QUERY SELECT v_placed.id, v_placed.version, chat.workspace_version_envelope(v_placed.id, v_placed.version), NULL::UUID;
$old$,
         $new$    v_placed := chat.attachment_item_for(p_chat_id, v_blob, v_item.filename, p_sender_user_id, p_message_id);
    IF chat.workspace_document_payload(v_item.id,v_version) IS NOT NULL THEN
        PERFORM chat.workspace_import_document(v_placed.id,v_placed.version,v_blob,chat.workspace_document_payload(v_item.id,v_version));
    END IF;
    RETURN QUERY SELECT v_placed.id, v_placed.version, chat.workspace_version_envelope(v_placed.id, v_placed.version), NULL::UUID;
$new$),
        ('chat.attachment_place_forward(text,text,text,text,boolean)',
         $old$    v_item := chat.attachment_item_for(p_chat_id, v_blob_id, v_name, p_sender_user_id, p_message_id);
    RETURN QUERY SELECT v_item.id, v_item.version, chat.workspace_version_envelope(v_item.id, v_item.version), NULL::UUID;
$old$,
         $new$    v_item := chat.attachment_item_for(p_chat_id, v_blob_id, v_name, p_sender_user_id, p_message_id);
    IF chat.workspace_document_payload(v_source_item.id,v_source.file_version) IS NOT NULL THEN
        PERFORM chat.workspace_import_document(v_item.id,v_item.version,v_blob_id,chat.workspace_document_payload(v_source_item.id,v_source.file_version));
    END IF;
    RETURN QUERY SELECT v_item.id, v_item.version, chat.workspace_version_envelope(v_item.id, v_item.version), NULL::UUID;
$new$) ) AS patches(signature,old_body,new_body) LOOP
        SELECT pg_get_functiondef(r.signature::regprocedure) INTO definition;
        IF position(r.old_body IN definition)=0 OR
           length(definition)-length(replace(definition,r.old_body,''))<>length(r.old_body) THEN
            RAISE EXCEPTION 'Unexpected text-ingest predecessor: %',r.signature;
        END IF;
        EXECUTE replace(definition,r.old_body,r.new_body);
    END LOOP;
END $text_ingest$;
GRANT EXECUTE ON FUNCTION chat.file_replace_as(text,text,text,integer),chat.file_place_as(text,text,text,text,text,text[]),
    chat.attachment_place(text,text,text,text,text,boolean),
    chat.attachment_place_share(uuid,integer,text,text,text),
    chat.attachment_place_forward(text,text,text,text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.files_record_version(uuid,text,text) TO gugu_files;
NOTIFY pgrst,'reload schema';
