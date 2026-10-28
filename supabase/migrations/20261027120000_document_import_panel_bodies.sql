-- A published assistant panel body is an immutable file snapshot (assistant_panel_guard_body). The legacy document
-- importer offered such bodies as candidates, and converting one was refused by that guard, stopping the import.
-- One predicate now decides "published body" for both: the guard refuses to change it, the importer never offers it.
CREATE FUNCTION identity.assistant_panel_body_published(p_item uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM identity.assistant_panel_items WHERE body_item_id = p_item)
        OR EXISTS (SELECT 1 FROM identity.assistant_panel_changes WHERE payload->>'bodyItemId' = p_item::text);
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_body_published(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION identity.assistant_panel_guard_body() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM chat.chats WHERE id = OLD.chat_id) THEN RETURN OLD; END IF;
    IF identity.assistant_panel_body_published(OLD.id) THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'Published assistant panel bodies must be removed through the panel' USING ERRCODE = '55000';
        END IF;
        IF NEW.blob_id IS DISTINCT FROM OLD.blob_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.chat_id IS DISTINCT FROM OLD.chat_id THEN
            RAISE EXCEPTION 'Published assistant panel bodies are immutable; create a new file' USING ERRCODE = '55000';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_panel_guard_body() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION chat.workspace_document_import_candidates(p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS TABLE(id uuid,version integer,blob_id uuid,filename text,content_type text,bucket_id text,object_name text,size_bytes bigint,sha256 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT w.id,w.version,w.blob_id,w.filename,w.content_type,b.bucket_id,b.object_name,b.size_bytes,b.sha256
      FROM chat.workspace_items w JOIN chat.file_blobs b ON b.id=w.blob_id
     WHERE w.kind='file' AND b.size_bytes<=1048576 AND NOT chat.file_transfer_reference_expired(b.id,w.chat_id)
       AND NOT identity.assistant_panel_body_published(w.id)
       AND (p_after IS NULL OR w.id>p_after) ORDER BY w.id LIMIT LEAST(GREATEST(p_limit,1),20);
$$;
REVOKE ALL ON FUNCTION chat.workspace_document_import_candidates(uuid,integer) FROM PUBLIC,anon,authenticated,gugu_files;
GRANT EXECUTE ON FUNCTION chat.workspace_document_import_candidates(uuid,integer) TO service_role;
