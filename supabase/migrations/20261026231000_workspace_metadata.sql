-- Shared file metadata. Each feature owns one top-level namespace, independently of
-- the file's opening application, content, versions and blob-reference ledger.
ALTER TABLE chat.workspace_items
    ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD CONSTRAINT workspace_items_metadata_object CHECK (jsonb_typeof(metadata) = 'object');

COMMENT ON COLUMN chat.workspace_items.metadata IS
    'Namespaced file metadata: app for application data, document for document state. Update only the namespace owned by the caller; this does not grant access to the file or its blobs.';

-- Internal only: feature-specific entry points validate the actor and their own
-- namespace (including document/blob references) before calling this function.
CREATE FUNCTION chat.workspace_set_metadata(p_item_id uuid, p_key text, p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
    v_metadata jsonb;
BEGIN
    IF p_key IS NULL OR btrim(p_key) = '' THEN
        RAISE EXCEPTION 'workspace metadata needs a namespace';
    END IF;
    IF p_value IS NOT NULL AND jsonb_typeof(p_value) <> 'object' THEN
        RAISE EXCEPTION 'workspace metadata namespace must be an object, or SQL NULL to remove it';
    END IF;

    UPDATE chat.workspace_items AS w
       SET metadata = CASE WHEN p_value IS NULL THEN w.metadata - p_key
                           ELSE jsonb_set(w.metadata, ARRAY[p_key], p_value, true) END
     WHERE w.id = p_item_id
     RETURNING w.metadata INTO v_metadata;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'workspace item not found: %', p_item_id USING HINT = 'workspace_item_not_found';
    END IF;
    RETURN v_metadata;
END;
$$;

REVOKE ALL ON FUNCTION chat.workspace_set_metadata(uuid, text, jsonb)
    FROM PUBLIC, anon, authenticated, service_role, gugu_files;

COMMENT ON FUNCTION chat.workspace_set_metadata(uuid, text, jsonb) IS
    'Internal atomic replacement/removal of one metadata namespace. No client grant: call only after feature-specific authorization and reference validation.';

NOTIFY pgrst, 'reload schema';
