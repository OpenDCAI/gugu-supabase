-- Session-direct files reuse private attachment blobs without creating chat messages.
CREATE TABLE chat.session_attachments (
    id uuid PRIMARY KEY,
    owner_user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    sender_user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    sender_session_id text NOT NULL,
    recipient_user_ids text[] NOT NULL CHECK (cardinality(recipient_user_ids) BETWEEN 1 AND 32),
    blob_id uuid REFERENCES chat.file_blobs(id) ON DELETE SET NULL,
    staging_key text NOT NULL UNIQUE,
    file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    CHECK (revoked_at IS NOT NULL OR blob_id IS NOT NULL)
);
ALTER TABLE chat.session_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.session_attachments FROM PUBLIC,anon,authenticated;
ALTER TABLE chat.file_blob_uploads ADD COLUMN session_attachment_id uuid;

CREATE OR REPLACE FUNCTION chat.file_upload_take(p_staging_key text) RETURNS chat.file_blob_uploads
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_upload chat.file_blob_uploads%ROWTYPE;
BEGIN
    SELECT * INTO v_upload FROM chat.file_blob_uploads u WHERE u.staging_key = p_staging_key FOR UPDATE;
    IF NOT FOUND OR v_upload.uploader IS DISTINCT FROM (SELECT auth.uid()::text) OR v_upload.expires_at <= now() THEN
        RAISE EXCEPTION USING HINT = 'attachment_upload_not_found',
            MESSAGE = format('no upload %s of yours is waiting to be placed', p_staging_key);
    END IF;
    IF v_upload.message_id IS NOT NULL OR v_upload.session_attachment_id IS NOT NULL THEN
        RAISE EXCEPTION USING HINT = 'attachment_upload_used',
            MESSAGE = format('upload %s was already sent as message %s', p_staging_key, v_upload.message_id);
    END IF;
    IF v_upload.item_id IS NULL THEN
        PERFORM chat.file_blob_take(v_upload.blob_id);
    END IF;
    RETURN v_upload;
END;
$$;

CREATE OR REPLACE FUNCTION chat.file_blob_in_use(p_blob_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
    SELECT EXISTS (SELECT 1 FROM chat.workspace_items w WHERE w.blob_id = p_blob_id)
        OR EXISTS (SELECT 1 FROM chat.workspace_item_versions v WHERE v.blob_id = p_blob_id)
        OR EXISTS (SELECT 1 FROM chat.file_blob_uploads u WHERE u.blob_id = p_blob_id AND u.expires_at > now())
        -- 悄悄话附件直接指着它(撤回、软删的行还在,也算)。
        OR EXISTS (SELECT 1 FROM chat.messages m WHERE m.file_blob_id = p_blob_id)
        OR EXISTS (SELECT 1 FROM chat.session_attachments a WHERE a.blob_id = p_blob_id AND a.revoked_at IS NULL)
        -- 老式引用:存储列指着这个对象的消息、群头像、group_outputs(只有不在 OSS 的对象才可能有)。
        OR EXISTS (
            SELECT 1 FROM chat.file_blobs b
             WHERE b.id = p_blob_id AND b.bucket_id <> 'oss'
               AND (EXISTS (SELECT 1 FROM chat.messages m WHERE m.storage_bucket_id = b.bucket_id AND m.storage_object_name = b.object_name)
                    OR EXISTS (SELECT 1 FROM chat.chats c WHERE c.avatar_storage_bucket_id = b.bucket_id AND c.avatar_storage_object_name = b.object_name)
                    OR EXISTS (SELECT 1 FROM chat.group_outputs o WHERE o.storage_bucket_id = b.bucket_id AND o.storage_object_name = b.object_name)));
$$;

CREATE FUNCTION chat.session_attachment_commit(
    p_staging_key text, p_attachment_id uuid, p_sender_user_id text,
    p_sender_session_id text, p_recipient_user_ids text[], p_file_name text
) RETURNS TABLE(attachment_id uuid, file_name text, sha256 text, size_bytes bigint, content_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_owner text := auth.uid()::text;
    v_actor text := chat.workspace_actor_for(p_sender_user_id);
    v_recipients text[];
    v_upload chat.file_blob_uploads%ROWTYPE;
    v_existing chat.session_attachments%ROWTYPE;
BEGIN
    IF v_owner IS NULL OR NOT EXISTS (SELECT 1 FROM identity.users u WHERE u.id=v_actor AND u.type='agent' AND u.owner_user_id=v_owner) THEN
        RAISE EXCEPTION 'session attachments require the sending Agent identity' USING HINT='session_attachment_denied';
    END IF;
    SELECT array_agg(DISTINCT x ORDER BY x) INTO v_recipients FROM unnest(p_recipient_user_ids) x;
    IF p_attachment_id IS NULL OR p_sender_session_id IS NULL OR length(p_sender_session_id)=0
       OR p_file_name IS NULL OR length(p_file_name) NOT BETWEEN 1 AND 255
       OR COALESCE(cardinality(v_recipients),0) NOT BETWEEN 1 AND 32
       OR EXISTS (SELECT 1 FROM unnest(v_recipients) x WHERE x=v_actor OR NOT EXISTS (
           SELECT 1 FROM identity.users u WHERE u.id=x AND u.type='agent' AND u.owner_user_id=v_owner)) THEN
        RAISE EXCEPTION 'invalid session attachment recipients or metadata' USING HINT='session_attachment_denied';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('session-attachment:'||p_attachment_id::text,0));
    SELECT * INTO v_existing FROM chat.session_attachments a WHERE a.id=p_attachment_id;
    IF FOUND THEN
        IF v_existing.owner_user_id IS DISTINCT FROM v_owner OR v_existing.sender_user_id IS DISTINCT FROM v_actor
           OR v_existing.staging_key IS DISTINCT FROM p_staging_key OR v_existing.sender_session_id IS DISTINCT FROM p_sender_session_id
           OR v_existing.recipient_user_ids IS DISTINCT FROM v_recipients OR v_existing.file_name IS DISTINCT FROM p_file_name
           OR v_existing.revoked_at IS NOT NULL THEN
            RAISE EXCEPTION 'session attachment request was already used differently' USING HINT='session_attachment_denied';
        END IF;
    ELSE
        v_upload := chat.file_upload_take(p_staging_key);
        IF v_upload.item_id IS NOT NULL THEN
            RAISE EXCEPTION 'upload was already placed' USING HINT='attachment_upload_used';
        END IF;
        INSERT INTO chat.session_attachments(id,owner_user_id,sender_user_id,sender_session_id,recipient_user_ids,blob_id,staging_key,file_name)
        VALUES(p_attachment_id,v_owner,v_actor,p_sender_session_id,v_recipients,v_upload.blob_id,p_staging_key,p_file_name);
        UPDATE chat.file_blob_uploads SET session_attachment_id=p_attachment_id WHERE staging_key=p_staging_key;
    END IF;
    RETURN QUERY SELECT a.id,a.file_name,b.sha256,b.size_bytes,b.content_type
      FROM chat.session_attachments a JOIN chat.file_blobs b ON b.id=a.blob_id WHERE a.id=p_attachment_id;
END;
$$;

CREATE FUNCTION chat.session_attachment_urls_as(p_ids uuid[],p_as_user_id text)
RETURNS TABLE(attachment_id uuid,file_name text,bucket_id text,object_name text,sha256 text,size_bytes bigint,content_type text,width integer,height integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor text := chat.workspace_actor_for(p_as_user_id);
BEGIN
    IF COALESCE(cardinality(p_ids),0) NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'expected 1 to 32 attachment ids'; END IF;
    RETURN QUERY SELECT a.id,a.file_name,b.bucket_id,b.object_name,b.sha256,b.size_bytes,b.content_type,b.width,b.height
      FROM chat.session_attachments a JOIN chat.file_blobs b ON b.id=a.blob_id
     WHERE a.id=ANY(p_ids) AND a.owner_user_id=auth.uid()::text AND a.revoked_at IS NULL AND b.state='live'
       AND (v_actor=a.owner_user_id OR v_actor=a.sender_user_id OR v_actor=ANY(a.recipient_user_ids));
END;
$$;

CREATE FUNCTION chat.session_attachment_revoke(p_id uuid,p_as_user_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor text := chat.workspace_actor_for(p_as_user_id);
BEGIN
    UPDATE chat.session_attachments a SET revoked_at=COALESCE(a.revoked_at,now())
     WHERE a.id=p_id AND a.owner_user_id=auth.uid()::text AND (v_actor=a.owner_user_id OR v_actor=a.sender_user_id);
    IF NOT FOUND THEN RAISE EXCEPTION 'session attachment is not yours to revoke' USING HINT='session_attachment_denied'; END IF;
END;
$$;

CREATE FUNCTION chat.session_attachment_lost_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF TG_OP='DELETE' OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
        PERFORM chat.file_blob_enqueue(OLD.blob_id);
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER session_attachment_lost_reference AFTER DELETE OR UPDATE ON chat.session_attachments
FOR EACH ROW EXECUTE FUNCTION chat.session_attachment_lost_reference();

REVOKE ALL ON FUNCTION chat.session_attachment_commit(text,uuid,text,text,text[],text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION chat.session_attachment_urls_as(uuid[],text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION chat.session_attachment_revoke(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION chat.session_attachment_lost_reference() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.session_attachment_commit(text,uuid,text,text,text[],text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.session_attachment_urls_as(uuid[],text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.session_attachment_revoke(uuid,text) TO authenticated,service_role;
