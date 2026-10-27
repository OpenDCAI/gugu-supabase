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
    IF (receipt.item_id IS NOT NULL OR receipt.document ? 'prepared') AND (receipt.document-'prepared') IS DISTINCT FROM p_document THEN
        RAISE EXCEPTION 'Committed upload classification cannot change' USING HINT='file_transfer_conflict';
    END IF;
    UPDATE chat.file_blob_uploads SET document=CASE WHEN document-'prepared'=p_document THEN document ELSE p_document END WHERE staging_key=p_key;
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





-- All body rounds, renames, stored replacements and device revisions use this one locked sequence.
-- Reuse an unrecorded head only when recording that head's first body snapshot. The caller publishes
-- the chosen number atomically with its body; allocating must not change the row before byte guards run.
CREATE FUNCTION chat.workspace_allocate_version(p_item uuid,p_reuse_head boolean DEFAULT false) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE head integer; recorded integer;
BEGIN
    SELECT version INTO STRICT head FROM chat.workspace_items WHERE id=p_item FOR UPDATE;
    SELECT COALESCE(max(n),0) INTO recorded FROM chat.workspace_item_versions WHERE item_id=p_item;
    IF p_reuse_head AND head>recorded THEN RETURN head; END IF;
    RETURN GREATEST(head,recorded)+1;
END $$;
REVOKE ALL ON FUNCTION chat.workspace_allocate_version(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role,gugu_files;
COMMENT ON COLUMN chat.workspace_items.version IS 'One monotonic file sequence, allocated with workspace_allocate_version; shared by metadata and body history.';




CREATE OR REPLACE FUNCTION chat.workspace_version_blob(p_item_id uuid,p_n integer) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT v.blob_id FROM chat.workspace_item_versions v WHERE v.item_id=p_item_id AND v.n=p_n
    UNION ALL
    SELECT w.blob_id FROM chat.workspace_items w WHERE w.id=p_item_id AND w.version=p_n
      AND NOT EXISTS(SELECT 1 FROM chat.workspace_item_versions v WHERE v.item_id=p_item_id AND v.n=p_n)
    LIMIT 1;
$$;

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


REVOKE ALL ON FUNCTION chat.messages_file_ref() FROM PUBLIC,anon,authenticated,service_role,gugu_files;

NOTIFY pgrst, 'reload schema';

-- The file service verifies the JWT and drains the current Y.Doc. Only its restricted DB role may
-- prepare a generation on an existing, inspected upload receipt. The caller's original JWT still
-- commits through PostgREST, so attachment_commit retains message RLS and file/message atomicity.
CREATE FUNCTION chat.files_publication_input(p_item uuid,p_user text,p_actor text,p_key text,p_expected integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w chat.workspace_items%ROWTYPE; u chat.file_blob_uploads%ROWTYPE; base text;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM chat.files_authorize(p_item,p_user,p_actor)) THEN
        RAISE EXCEPTION 'File not found' USING HINT='file_transfer_denied';
    END IF;
    SELECT * INTO w FROM chat.workspace_items WHERE id=p_item FOR SHARE;
    SELECT * INTO u FROM chat.file_blob_uploads WHERE staging_key=p_key;
    IF w.kind<>'document' OR u.uploader IS DISTINCT FROM p_user OR u.expires_at<=now()
       OR u.document IS NULL THEN
        RAISE EXCEPTION 'A verified, unused text upload is required' USING HINT='file_place_invalid';
    END IF;
    IF u.item_id=p_item AND (u.document->'prepared'->>'expected_version')::integer=p_expected THEN
        RETURN jsonb_build_object('committed',true);
    END IF;
    IF u.item_id IS NOT NULL THEN RAISE EXCEPTION 'Upload already used' USING HINT='attachment_upload_used'; END IF;
    IF p_expected IS NULL OR w.version<>p_expected THEN
        RAISE EXCEPTION 'File version changed' USING HINT='workspace_version_conflict';
    END IF;
    SELECT inline_text INTO base FROM chat.workspace_item_versions WHERE item_id=p_item AND n<=p_expected ORDER BY n DESC LIMIT 1;
    RETURN jsonb_build_object('document',u.document,'epoch',w.epoch,'text',COALESCE(base,w.inline_text,''));
END $$;
REVOKE ALL ON FUNCTION chat.files_publication_input(uuid,text,text,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.files_publication_input(uuid,text,text,text,integer) TO gugu_files;

CREATE FUNCTION chat.files_prepare_publication(p_item uuid,p_user text,p_actor text,p_key text,p_expected integer,p_epoch integer,p_text text,p_state bytea,p_file_text text DEFAULT NULL,p_same_body boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE checked jsonb;
BEGIN
    -- Keep the item lock through preparation; the final caller-JWT transaction rechecks version/epoch.
    PERFORM 1 FROM chat.workspace_items WHERE id=p_item FOR UPDATE;
    checked:=chat.files_publication_input(p_item,p_user,p_actor,p_key,p_expected);
    IF (checked->>'epoch')::integer IS DISTINCT FROM p_epoch OR p_state IS NULL OR p_text IS NULL
       OR octet_length(p_text)>1048576 OR octet_length(COALESCE(p_file_text,p_text))>1048576 THEN
        RAISE EXCEPTION 'Document generation changed' USING HINT='workspace_version_conflict';
    END IF;
    UPDATE chat.file_blob_uploads SET document=jsonb_set(document,'{prepared}',jsonb_build_object(
        'item_id',p_item,'user',p_user,'actor',p_actor,'expected_version',p_expected,'epoch',p_epoch,
        'text',p_text,'state',encode(p_state,'hex'),'file_text',COALESCE(p_file_text,p_text),
        'prior',checked->>'text','same_body',p_same_body)) WHERE staging_key=p_key;
END $$;
REVOKE ALL ON FUNCTION chat.files_prepare_publication(uuid,text,text,text,integer,integer,text,bytea,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.files_prepare_publication(uuid,text,text,text,integer,integer,text,bytea,text,boolean) TO gugu_files;

-- Resolves an uncertain HTTP reply using the existing idempotent receipt. Clearing an unused
-- preparation under its row lock prevents a delayed caller-JWT transaction from committing later.
CREATE FUNCTION chat.files_abort_publication(p_item uuid,p_user text,p_actor text,p_key text,p_epoch integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u chat.file_blob_uploads%ROWTYPE; current_epoch integer;
BEGIN
    SELECT * INTO u FROM chat.file_blob_uploads WHERE staging_key=p_key FOR UPDATE;
    IF u.uploader IS DISTINCT FROM p_user OR u.document->'prepared'->>'item_id' IS DISTINCT FROM p_item::text
       OR u.document->'prepared'->>'actor' IS DISTINCT FROM p_actor OR (u.document->'prepared'->>'epoch')::integer IS DISTINCT FROM p_epoch THEN
        RAISE EXCEPTION 'Publication receipt changed';
    END IF;
    IF u.item_id IS NULL THEN
        UPDATE chat.file_blob_uploads SET document=document-'prepared' WHERE staging_key=p_key;
        RETURN NULL;
    END IF;
    SELECT epoch INTO current_epoch FROM chat.workspace_items WHERE id=p_item;
    IF u.item_id IS DISTINCT FROM p_item OR current_epoch IS DISTINCT FROM p_epoch+1 THEN RAISE EXCEPTION 'Publication receipt changed'; END IF;
    RETURN current_epoch;
END $$;
REVOKE ALL ON FUNCTION chat.files_abort_publication(uuid,text,text,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.files_abort_publication(uuid,text,text,text,integer) TO gugu_files;

-- Filling the blob for an already recorded document body changes its storage, never its content.
-- The proof is the same restricted-role preparation on the upload receipt, not a client text tag.
CREATE OR REPLACE FUNCTION chat.workspace_bytes_pinned() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item uuid; n integer; body text;
BEGIN
    IF NEW.blob_id IS NOT DISTINCT FROM OLD.blob_id THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='workspace_item_versions' THEN
        item:=OLD.item_id; n:=OLD.n; body:=OLD.inline_text;
        IF OLD.blob_id IS NOT NULL OR NEW.n<>n THEN
            RAISE EXCEPTION 'Published version keeps its bytes' USING HINT='workspace_version_bytes_fixed';
        END IF;
    ELSE
        IF NEW.version>OLD.version THEN RETURN NEW; END IF;
        IF OLD.kind<>'document' OR NEW.kind<>OLD.kind OR NEW.version<>OLD.version
           OR NEW.inline_text IS DISTINCT FROM OLD.inline_text THEN
            RAISE EXCEPTION 'File changes its bytes only as a new version' USING HINT='workspace_version_bytes_fixed';
        END IF;
        item:=OLD.id; n:=OLD.version; body:=OLD.inline_text;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM chat.file_blob_uploads u WHERE u.blob_id=NEW.blob_id
        AND u.uploader=auth.uid()::text AND u.document->'prepared'->>'item_id'=item::text
        AND (u.document->'prepared'->>'expected_version')::integer=n
        AND CASE WHEN TG_TABLE_NAME='workspace_item_versions' THEN
            u.document->'prepared'->>'prior'=body AND NEW.inline_text=u.document->'prepared'->>'file_text'
          ELSE u.document->'prepared'->>'text'=body END
        AND u.expires_at>now()) THEN
        RAISE EXCEPTION 'Published version keeps its bytes' USING HINT='workspace_version_bytes_fixed';
    END IF;
    RETURN NEW;
END $$;

-- Existing mutation entry points use the shared allocator without changing their authorization.




CREATE OR REPLACE FUNCTION chat.file_replace_as(p_staging_key text, p_item_id text, p_as_user_id text, p_expected_version integer DEFAULT NULL::integer) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, pruned_pointers text[], parent_id uuid, system_role text, path text, updated_by text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_keep CONSTANT INTEGER := 50;
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_item chat.workspace_items%ROWTYPE;
    v_upload chat.file_blob_uploads%ROWTYPE;
    v_blob chat.file_blobs%ROWTYPE;
    v_next INTEGER;
    v_pruned TEXT[] := '{}';
    prepared jsonb; current_body chat.workspace_item_versions%ROWTYPE;
BEGIN
    v_item := chat.workspace_item_for(p_item_id, v_actor, true);
    v_upload := chat.file_upload_take(p_staging_key);
    IF v_upload.item_id IS NOT NULL THEN
        -- 重试:上次已经把这个文件换成了这份字节(换到别的条目上的上传不能再用)。
        IF v_upload.item_id IS DISTINCT FROM v_item.id THEN
            RAISE EXCEPTION USING HINT = 'attachment_upload_used',
                MESSAGE = format('upload %s was already placed elsewhere', p_staging_key);
        END IF;
    ELSE
        IF v_item.kind='document' THEN
            prepared:=v_upload.document->'prepared';
            IF prepared IS NULL OR prepared->>'item_id'<>v_item.id::text
               OR prepared->>'user' IS DISTINCT FROM auth.uid()::text OR prepared->>'actor' IS DISTINCT FROM v_actor
               OR (prepared->>'expected_version')::integer IS DISTINCT FROM v_item.version
               OR p_expected_version IS DISTINCT FROM v_item.version OR (prepared->>'epoch')::integer IS DISTINCT FROM v_item.epoch THEN
                RAISE EXCEPTION 'Publish the document through the file service' USING HINT='workspace_version_conflict';
            END IF;
            SELECT b.* INTO v_blob FROM chat.file_blobs b WHERE b.id=v_upload.blob_id;
            SELECT v.* INTO current_body FROM chat.workspace_item_versions v WHERE v.item_id=v_item.id AND v.n=v_item.version;
            -- Identical content published twice pins the same body number; a first blob fills the same snapshot.
            IF COALESCE((prepared->>'same_body')::boolean,false) AND current_body.blob_id IS NOT NULL THEN
                -- The same readable body keeps its immutable published bytes, even if JSON formatting differs.
                v_next:=v_item.version;
                SELECT b.* INTO v_blob FROM chat.file_blobs b WHERE b.id=current_body.blob_id;
            ELSIF (COALESCE((prepared->>'same_body')::boolean,false) AND current_body.blob_id IS NULL)
               OR (current_body.inline_text IS NOT DISTINCT FROM prepared->>'text' AND current_body.blob_id IS NULL)
               OR (current_body.item_id IS NULL AND v_item.inline_text IS NOT DISTINCT FROM prepared->>'text')
               OR (current_body.blob_id=v_blob.id AND current_body.inline_text IS NOT DISTINCT FROM v_upload.document->>'text') THEN
                v_next:=v_item.version;
                INSERT INTO chat.workspace_item_versions(item_id,n,inline_text,blob_id,content_type,size_bytes,made_by)
                VALUES(v_item.id,v_next,prepared->>'file_text',v_blob.id,v_item.content_type,v_blob.size_bytes,v_actor)
                ON CONFLICT(item_id,n) DO UPDATE SET blob_id=EXCLUDED.blob_id,inline_text=EXCLUDED.inline_text;
            ELSE
                INSERT INTO chat.workspace_item_versions(item_id,n,inline_text,content_type,size_bytes,made_by,made_at)
                VALUES(v_item.id,v_item.version,v_item.inline_text,v_item.content_type,octet_length(v_item.inline_text),v_item.updated_by,v_item.updated_at)
                ON CONFLICT DO NOTHING;
                v_next:=chat.workspace_allocate_version(v_item.id);
                INSERT INTO chat.workspace_item_versions(item_id,n,inline_text,blob_id,content_type,size_bytes,made_by)
                VALUES(v_item.id,v_next,prepared->>'file_text',v_blob.id,v_item.content_type,v_blob.size_bytes,v_actor);
            END IF;
            UPDATE chat.workspace_items w SET ystate=decode(prepared->>'state','hex'),inline_text=prepared->>'text',
                blob_id=v_blob.id,size_bytes=octet_length(prepared->>'text'),version=v_next,epoch=w.epoch+1,updated_by=v_actor WHERE w.id=v_item.id;
            UPDATE chat.file_blob_uploads SET item_id=v_item.id,item_version=v_next WHERE staging_key=p_staging_key;
        ELSIF v_item.kind<>'file' THEN
            RAISE EXCEPTION 'A folder cannot be replaced' USING HINT='file_place_invalid';
        ELSE
        IF p_expected_version IS NOT NULL AND p_expected_version <> v_item.version THEN
            RAISE EXCEPTION USING HINT = 'workspace_version_conflict', DETAIL = v_item.version::TEXT,
                MESSAGE = format('workspace item %s version conflict: expected %s, got %s', p_item_id, p_expected_version, v_item.version);
        END IF;
        IF v_upload.blob_id = v_item.blob_id THEN
            RAISE EXCEPTION USING HINT = 'file_place_invalid', MESSAGE = 'file_replace_as: that is the content the file already has';
        END IF;
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = v_upload.blob_id;
        v_next := chat.workspace_allocate_version(v_item.id);
        -- 被替换的这一版:第一次换版本时它还不在历史里(建文件时不写历史),补上。
        INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
        VALUES (v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at)
        ON CONFLICT ON CONSTRAINT workspace_item_versions_pkey DO NOTHING;
        INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by)
        VALUES (v_item.id, v_next, v_blob.id, v_blob.content_type, v_blob.size_bytes, v_actor);
        UPDATE chat.workspace_items w
           SET blob_id = v_blob.id, size_bytes = v_blob.size_bytes, content_type = v_blob.content_type, version = v_next, updated_by = v_actor
         WHERE w.id = v_item.id;
        UPDATE chat.file_blob_uploads u SET item_id = v_item.id, item_version = v_next WHERE u.staging_key = p_staging_key;
        END IF;
        WITH gone AS (
            DELETE FROM chat.workspace_item_versions v
             WHERE v.item_id = v_item.id
               AND v.n NOT IN (SELECT k.n FROM chat.workspace_item_versions k WHERE k.item_id = v_item.id ORDER BY k.n DESC LIMIT v_keep)
               -- 聊天记录钉着的那一版不裁:它是「当时发的那一版」,得一直读得到。
               AND NOT EXISTS (SELECT 1 FROM chat.messages m WHERE m.file_item_id = v.item_id AND m.file_version = v.n)
            RETURNING v.blob_id
        )
        SELECT COALESCE(array_agg(chat.file_blob_pointer(g.blob_id)) FILTER (WHERE chat.file_blob_pointer(g.blob_id) IS NOT NULL), '{}') INTO v_pruned FROM gone g;
    END IF;
    PERFORM chat.workspace_ingest_upload(p_staging_key);
    RETURN QUERY
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at, v_pruned,
           w.parent_id, w.system_role, chat.workspace_path_of(w.id), w.updated_by
      FROM chat.workspace_items w
     WHERE w.id = v_item.id;
END;
$$;
REVOKE ALL ON FUNCTION chat.file_replace_as(text,text,text,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION chat.file_replace_as(text,text,text,integer) TO authenticated;



-- The existing attachment constructor also reuses an unchanged, already published document.

REVOKE ALL ON FUNCTION chat.attachment_item_for(text,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role,gugu_files;

CREATE FUNCTION chat.workspace_document_payload(p_item uuid,p_version integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT jsonb_build_object('text',v.inline_text,'content_type',v.content_type)
    FROM chat.workspace_item_versions v JOIN chat.workspace_items w ON w.id=v.item_id
    WHERE v.item_id=p_item AND v.n=p_version AND w.kind='document' AND v.inline_text IS NOT NULL AND v.blob_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION chat.workspace_document_payload(uuid,integer) FROM PUBLIC,anon,authenticated,service_role,gugu_files;





-- Reuse the existing upload/version receipt inside the original share transaction, including cross-chat shares.
CREATE FUNCTION chat.attachment_publish_share(p_key text,p_item uuid,p_expected integer,p_sender text,p_message text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w chat.workspace_items%ROWTYPE; n integer;
BEGIN
    w:=chat.workspace_item_for(p_item::text,p_sender,true);
    SELECT item_version INTO n FROM chat.attachment_place_version(p_key,p_item,p_expected,w.chat_id,p_sender,p_message);
    RETURN n;
END $$;
REVOKE ALL ON FUNCTION chat.attachment_publish_share(text,uuid,integer,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION chat.attachment_publish_share(text,uuid,integer,text,text) TO authenticated;
DROP FUNCTION chat.attachment_share(uuid,integer,text,text,text,text[],text,text,boolean,text,text);
CREATE FUNCTION chat.attachment_share(p_item_id uuid, p_version integer, p_message_id text, p_chat_id text, p_sender_user_id text, p_to_user_ids text[] DEFAULT '{}'::text[], p_reply_to_message_id text DEFAULT NULL::text, p_thread_root_id text DEFAULT NULL::text, p_is_thread_root boolean DEFAULT false, p_via_app text DEFAULT NULL::text, p_caption text DEFAULT NULL::text,p_staging_key text DEFAULT NULL::text) RETURNS SETOF chat.messages_view
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
    v_placed RECORD;
BEGIN
    IF p_staging_key IS NOT NULL THEN
        p_version:=chat.attachment_publish_share(p_staging_key,p_item_id,p_version,p_sender_user_id,p_message_id);
    END IF;
    SELECT * INTO v_placed FROM chat.attachment_place_share(p_item_id, p_version, p_chat_id, p_sender_user_id, p_message_id);
    RETURN QUERY
    SELECT * FROM chat.send_message_idempotent(
        p_message_id, p_chat_id, p_sender_user_id, COALESCE(p_to_user_ids, '{}'), v_placed.envelope || chat.attachment_caption_suffix(p_caption), 'attachment',
        p_reply_to_message_id, p_thread_root_id, COALESCE(p_is_thread_root, false), false, p_via_app,
        v_placed.item_id, v_placed.item_version, NULL, NULL);
END;
$$;
REVOKE ALL ON FUNCTION chat.attachment_share(uuid,integer,text,text,text,text[],text,text,boolean,text,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION chat.attachment_share(uuid,integer,text,text,text,text[],text,text,boolean,text,text,text) TO authenticated;
NOTIFY pgrst,'reload schema';

DROP FUNCTION chat.file_managed_upload_for(text,text);
CREATE FUNCTION chat.file_managed_upload_for(p_key text,p_user text,p_optional boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u chat.file_transfer_uploads%ROWTYPE; r chat.file_transfer_reservations%ROWTYPE;
BEGIN
    SELECT * INTO u FROM chat.file_transfer_uploads WHERE staging_key=p_key AND account_id=p_user;
    IF NOT FOUND AND p_optional THEN RETURN NULL; END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'Upload has no quota reservation' USING HINT='file_transfer_denied'; END IF;
    SELECT * INTO r FROM chat.file_transfer_reservations WHERE id=u.reservation_id;
    IF u.blob_id IS NULL AND r.expires_at<=now() THEN RAISE EXCEPTION 'Upload permit expired' USING HINT='file_transfer_expired'; END IF;
    RETURN to_jsonb(u)||jsonb_build_object('expires_at',r.expires_at,'state',r.state,'document',(SELECT document FROM chat.file_blob_uploads WHERE staging_key=p_key));
END $$;
REVOKE ALL ON FUNCTION chat.file_managed_upload_for(text,text,boolean) FROM PUBLIC,anon,authenticated,gugu_files;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_for(text,text,boolean) TO service_role;

-- Amend the installed entry points in place, as the existing expiry/download releases do.
-- A mismatched predecessor aborts installation; message RLS, expiry and all untouched checks stay intact.
DO $text_ingest$
DECLARE r record; definition text;
BEGIN
    FOR r IN SELECT * FROM (VALUES
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
        ('chat.files_record_version(uuid,text,text)',
         $old$    v_last chat.workspace_item_versions%ROWTYPE;
BEGIN
$old$,
         $new$    v_last chat.workspace_item_versions%ROWTYPE;
    v_next integer;
BEGIN
$new$),
        ('chat.files_record_version(uuid,text,text)',
         $old$
    INSERT INTO chat.workspace_item_versions (item_id, n, inline_text, content_type, size_bytes, made_by)
    VALUES (p_item_id, COALESCE(v_last.n, 0) + 1, p_text, v_item.content_type, octet_length(p_text),
            -- 作者不明(一次加载里第一笔改动之前的样子):文件从建好起正文没变过,那就是建它的人写的。
$old$,
         $new$
    v_next:=chat.workspace_allocate_version(p_item_id,true);
    INSERT INTO chat.workspace_item_versions (item_id, n, inline_text, content_type, size_bytes, made_by)
    VALUES (p_item_id, v_next, p_text, v_item.content_type, octet_length(p_text),
            -- 作者不明(一次加载里第一笔改动之前的样子):文件从建好起正文没变过,那就是建它的人写的。
$new$),
        ('chat.files_record_version(uuid,text,text)',
         $old$
    DELETE FROM chat.workspace_item_versions v
     WHERE v.item_id = p_item_id
       AND v.n NOT IN (SELECT k.n FROM chat.workspace_item_versions k WHERE k.item_id = p_item_id ORDER BY k.n DESC LIMIT v_keep);
    RETURN true;
$old$,
         $new$
    UPDATE chat.workspace_items SET version=v_next WHERE id=p_item_id;

    DELETE FROM chat.workspace_item_versions v
     WHERE v.item_id = p_item_id
       AND v.n NOT IN (SELECT k.n FROM chat.workspace_item_versions k WHERE k.item_id = p_item_id ORDER BY k.n DESC LIMIT v_keep)
       AND NOT EXISTS(SELECT 1 FROM chat.messages m WHERE m.file_item_id=v.item_id AND m.file_version=v.n);
    RETURN true;
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
        ('chat.workspace_move_as(text,text,text,text,integer)',
         $old$           filename = COALESCE(NULLIF(btrim(COALESCE(p_name, '')), ''), w.filename),
           version = w.version + 1
     WHERE w.id = v_item.id;
$old$,
         $new$           filename = COALESCE(NULLIF(btrim(COALESCE(p_name, '')), ''), w.filename),
           version = chat.workspace_allocate_version(v_item.id)
     WHERE w.id = v_item.id;
$new$),
        ('chat.workspace_replace_file_as(text,text,text,bigint,text,integer)',
         $old$    v_type := COALESCE(NULLIF(btrim(COALESCE(p_content_type, '')), ''), v_item.content_type);
    v_next := v_item.version + 1;

$old$,
         $new$    v_type := COALESCE(NULLIF(btrim(COALESCE(p_content_type, '')), ''), v_item.content_type);
    v_next := chat.workspace_allocate_version(v_item.id);

$new$),
        ('file_private.publish_revision(uuid,text,text,text,text,bigint,text,text,integer,uuid)',
         $old$        VALUES(w.id,w.version,w.blob_id,w.content_type,w.size_bytes,w.created_by,w.updated_at) ON CONFLICT DO NOTHING;
        n:=w.version+1;
    ELSE
        IF p_expected IS NOT NULL THEN RAISE EXCEPTION 'File revision conflict' USING HINT='file_transfer_conflict'; END IF;
        n:=1;
        INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,created_by,parent_id)
$old$,
         $new$        VALUES(w.id,w.version,w.blob_id,w.content_type,w.size_bytes,w.created_by,w.updated_at) ON CONFLICT DO NOTHING;
    ELSE
        IF p_expected IS NOT NULL THEN RAISE EXCEPTION 'File revision conflict' USING HINT='file_transfer_conflict'; END IF;
        INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,created_by,parent_id)
$new$),
        ('file_private.publish_revision(uuid,text,text,text,text,bigint,text,text,integer,uuid)',
         $old$    END IF;
    INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type)
$old$,
         $new$    END IF;
    n:=chat.workspace_allocate_version(p_item,w.id IS NULL);
    INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type)
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
$new$)) AS patches(signature,old_body,new_body) LOOP
        SELECT pg_get_functiondef(r.signature::regprocedure) INTO definition;
        IF position(r.old_body IN definition)=0 OR
           length(definition)-length(replace(definition,r.old_body,''))<>length(r.old_body) THEN
            RAISE EXCEPTION 'Unexpected text-ingest predecessor: %',r.signature;
        END IF;
        EXECUTE replace(definition,r.old_body,r.new_body);
    END LOOP;
END $text_ingest$;
-- The installation DDL guard closes replaced API functions. Restore only their intended grants.
GRANT EXECUTE ON FUNCTION chat.file_place_as(text,text,text,text,text,text[]),
    chat.attachment_place(text,text,text,text,text,boolean),chat.workspace_move_as(text,text,text,text,integer),
    chat.workspace_replace_file_as(text,text,text,bigint,text,integer),
    file_private.publish_revision(uuid,text,text,text,text,bigint,text,text,integer,uuid),
    chat.attachment_place_share(uuid,integer,text,text,text),
    chat.attachment_place_forward(text,text,text,text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.files_record_version(uuid,text,text) TO gugu_files;
NOTIFY pgrst,'reload schema';
