-- file_urls_as checked message visibility as a filter on the message scan. The planner attached that
-- filter to whichever message index it chose before joining to the caller's refs, so every call (even
-- one for a single item reference) evaluated chat.can_read_message for every legacy chat-media message
-- and every whisper-blob message in the database: about 15k buffer reads and 0.4-0.7 s per call on a
-- staging copy, and the main cost of file_resolve_as and file_transfer_download_as.
--
-- Decide visibility once per message the caller named, then read only those messages by primary key.
-- Results, signature, grants and the 200-reference bound are unchanged.
CREATE OR REPLACE FUNCTION chat.file_urls_as(p_refs jsonb, p_as_user_id text)
RETURNS TABLE(item_id uuid, version integer, message_id text, current_version integer, chat_id text, file_name text,
              bucket_id text, object_name text, sha256 text, size_bytes bigint, content_type text, width integer, height integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_messages TEXT[];
BEGIN
    IF jsonb_typeof(p_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_refs) > 200 THEN
        RAISE EXCEPTION 'file_urls_as: refs is an array of at most 200 {item_id, version} or {message_id}';
    END IF;
    SELECT array_agg(DISTINCT r.value ->> 'message_id') INTO v_messages
      FROM jsonb_array_elements(p_refs) AS r(value)
     WHERE r.value ->> 'message_id' IS NOT NULL
       AND chat.can_read_message(r.value ->> 'message_id', v_actor);
    RETURN QUERY
    WITH asked AS (
        SELECT CASE WHEN r.value ->> 'item_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN (r.value ->> 'item_id')::uuid END AS ref_item,
               CASE WHEN r.value ->> 'version' ~ '^[0-9]{1,9}$' THEN (r.value ->> 'version')::INTEGER END AS ref_version
          FROM jsonb_array_elements(p_refs) AS r(value)
    ), picked AS MATERIALIZED (
        -- Only the primary key can serve this filter, so the lookup stays bounded by the refs.
        SELECT m.id, m.chat_id, m.content, m.content_type, m.file_item_id, m.file_blob_id,
               m.storage_bucket_id, m.storage_object_name
          FROM chat.messages m
         WHERE m.id = ANY(v_messages) AND m.retracted_at IS NULL
    )
    SELECT DISTINCT w.id, COALESCE(a.ref_version, w.version), NULL::TEXT, w.version, w.chat_id, w.filename, b.bucket_id,
           b.object_name, b.sha256, b.size_bytes, b.content_type, b.width, b.height
      FROM asked a
      JOIN chat.workspace_items w ON w.id = a.ref_item
      JOIN chat.chats c ON c.id = w.chat_id AND c.kind IN ('group', 'topic', 'dm', 'ai')
      JOIN chat.file_blobs b ON b.id = chat.workspace_version_blob(w.id, COALESCE(a.ref_version, w.version))
     WHERE chat.is_chat_member(w.chat_id, v_actor)
    UNION
    SELECT NULL::UUID, NULL::INTEGER, m.id, NULL::INTEGER, m.chat_id,
           chat.attachment_envelope_name(m.content, b.size_bytes, b.content_type), b.bucket_id,
           b.object_name, b.sha256, b.size_bytes, b.content_type, b.width, b.height
      FROM picked m
      JOIN chat.file_blobs b ON b.id = m.file_blob_id
    -- Legacy cards: the bytes are the chat-media object named by the storage columns; size and type come from it.
    UNION
    SELECT NULL::UUID, NULL::INTEGER, m.id, NULL::INTEGER, m.chat_id, chat.legacy_attachment_name(m.content),
           m.storage_bucket_id, m.storage_object_name, NULL::TEXT, NULLIF(o.metadata ->> 'size', '')::BIGINT,
           COALESCE(NULLIF(o.metadata ->> 'mimetype', ''), 'application/octet-stream'), NULL::INTEGER, NULL::INTEGER
      FROM picked m
      JOIN storage.objects o ON o.bucket_id = m.storage_bucket_id AND o.name = m.storage_object_name
     WHERE m.content_type = 'attachment' AND m.file_item_id IS NULL AND m.file_blob_id IS NULL
       AND m.storage_bucket_id = 'chat-media';
END;
$$;
-- Replacing a function re-closes it to API roles; restore the existing grant.
GRANT EXECUTE ON FUNCTION chat.file_urls_as(jsonb, text) TO authenticated;
