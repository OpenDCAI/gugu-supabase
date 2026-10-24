-- Status display never signs a URL, reserves bytes, or renews last_download_at.
CREATE FUNCTION chat.file_resolve_as(p_ref jsonb,p_as text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); c record; r jsonb; item uuid; pinned integer; message text:=p_ref->>'message_id';
BEGIN
    IF jsonb_typeof(p_ref) IS DISTINCT FROM 'object' OR NOT (
        (p_ref ? 'item_id' AND p_ref-'item_id'-'version'='{}' AND jsonb_typeof(p_ref->'item_id')='string'
            AND (NOT (p_ref ? 'version') OR jsonb_typeof(p_ref->'version')='number' AND p_ref->>'version' ~ '^[1-9][0-9]{0,8}$'))
        OR (p_ref ? 'message_id' AND p_ref-'message_id'='{}' AND jsonb_typeof(p_ref->'message_id')='string')
        OR (p_ref ? 'attachment_id' AND p_ref-'attachment_id'='{}' AND jsonb_typeof(p_ref->'attachment_id')='string')) THEN
        RAISE EXCEPTION 'Invalid file reference' USING HINT='file_transfer_invalid';
    END IF;
    IF message IS NOT NULL THEN
        IF NOT chat.can_read_message(message,actor) THEN RETURN jsonb_build_object('status','gone'); END IF;
        SELECT file_item_id,file_version INTO item,pinned FROM chat.messages WHERE id=message AND retracted_at IS NULL;
        IF item IS NOT NULL THEN p_ref:=jsonb_build_object('item_id',item,'version',pinned); END IF;
    END IF;
    IF p_ref ? 'attachment_id' THEN
        SELECT * INTO c FROM chat.session_attachment_urls_as(ARRAY[(p_ref->>'attachment_id')::uuid],actor) LIMIT 1;
    ELSE SELECT * INTO c FROM chat.file_urls_as(jsonb_build_array(p_ref),actor) LIMIT 1;
    END IF;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','gone'); END IF;
    r:=to_jsonb(c);
    RETURN r||jsonb_build_object('source','managed-object','message_id',COALESCE(r->>'message_id',message),
        'status',CASE WHEN EXISTS(SELECT 1 FROM chat.file_transfer_storage o JOIN chat.file_transfer_storage_refs ref ON ref.storage_id=o.id
            WHERE o.bucket_id=c.bucket_id AND o.object_name=c.object_name AND ref.chat_id=chat.file_transfer_group(r->>'chat_id')
              AND ref.expired_at IS NOT NULL) THEN 'expired' ELSE 'ready' END);
END $$;
REVOKE ALL ON FUNCTION chat.file_resolve_as(jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_resolve_as(jsonb,text) TO authenticated;

-- The existing minute tick must discover expired files even when its GC queue is empty.
DO $tick$ DECLARE definition text; fence text:='IF NOT EXISTS (SELECT 1 FROM chat.file_blob_gc g WHERE g.status IN'; BEGIN
    SELECT pg_get_functiondef('chat.file_blob_gc_kick()'::regprocedure) INTO definition;
    IF position(fence IN definition)=0 THEN RAISE EXCEPTION 'Missing GC scheduler fence'; END IF;
    EXECUTE replace(definition,fence,'PERFORM chat.file_transfer_expire(500);'||chr(10)||'    '||fence);
END $tick$;
