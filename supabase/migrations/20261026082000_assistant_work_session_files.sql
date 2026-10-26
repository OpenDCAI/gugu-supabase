-- Work delivery uses the existing native session-file receipt, not a workspace
-- copy. Keep its original sender, addressed recipient, hash and byte count.
CREATE FUNCTION identity.assistant_work_attachment(p_ref jsonb,p_event jsonb,p_work identity.assistant_work)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_target text; v_sender text;
BEGIN
    IF p_work.owner_user_id IS DISTINCT FROM auth.uid()::text OR jsonb_typeof(p_ref) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Attachment reference is not visible to this account' USING ERRCODE = '42501';
    END IF;
    IF p_ref ? 'item_id' AND p_ref - 'item_id' = '{}' THEN
        IF NOT EXISTS (SELECT 1 FROM chat.workspace_items i WHERE i.id::text = p_ref->>'item_id'
          AND chat.history_floor(i.chat_id,p_work.owner_user_id) IS NOT NULL) THEN
            RAISE EXCEPTION 'Attachment reference is not visible to this account' USING ERRCODE = '42501';
        END IF;
        RETURN;
    END IF;
    IF p_ref - ARRAY['attachment_id','file_name','sha256','size_bytes','content_type'] <> '{}'
      OR COALESCE(p_ref->>'attachment_id','') !~ '^[0-9a-fA-F-]{36}$'
      OR COALESCE(p_ref->>'sha256','') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(p_ref->'size_bytes') IS DISTINCT FROM 'number'
      OR COALESCE(p_ref->>'size_bytes','') !~ '^[0-9]{1,18}$'
      OR jsonb_typeof(p_ref->'file_name') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_ref->'content_type') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Invalid session attachment metadata' USING ERRCODE = '22023';
    END IF;
    IF p_event->>'to_session_id' = p_work.coordinator_session_id THEN v_target := p_work.assistant_user_id;
    ELSE SELECT x->>'agent_user_id' INTO v_target FROM jsonb_array_elements(p_work.executors) x WHERE x->>'session_id' = p_event->>'to_session_id';
    END IF;
    IF p_event->>'from_session_id' = p_work.coordinator_session_id THEN v_sender := p_work.assistant_user_id;
    ELSE SELECT x->>'agent_user_id' INTO v_sender FROM jsonb_array_elements(p_work.executors) x WHERE x->>'session_id' = p_event->>'from_session_id';
    END IF;
    IF v_target IS NULL OR NOT EXISTS (
      SELECT 1 FROM chat.session_attachments a JOIN chat.file_blobs b ON b.id = a.blob_id
      WHERE a.id = (p_ref->>'attachment_id')::uuid AND a.owner_user_id = p_work.owner_user_id
        AND a.revoked_at IS NULL AND b.state = 'live'
        AND a.sender_session_id = p_event->>'from_session_id'
        AND (v_sender IS NULL OR a.sender_user_id = v_sender)
        AND v_target = ANY(a.recipient_user_ids)
        AND a.file_name = p_ref->>'file_name' AND b.sha256 = p_ref->>'sha256'
        AND b.size_bytes = (p_ref->>'size_bytes')::bigint AND b.content_type = p_ref->>'content_type'
    ) THEN RAISE EXCEPTION 'Session attachment metadata or addressed recipient is not valid' USING ERRCODE = '42501'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_attachment(jsonb,jsonb,identity.assistant_work) FROM PUBLIC,anon,authenticated;

-- Preserve the reviewed RPC, its grants and security attributes. Fail if its
-- unique attachment-validation boundary differs from the installed contract.
DO $migration$
DECLARE
    v_definition text := pg_get_functiondef('identity.assistant_work_commit(text,text,uuid,uuid,jsonb,jsonb)'::regprocedure);
    v_boundary constant text := $boundary$            IF jsonb_typeof(v_ref) <> 'object' OR v_ref - ARRAY['item_id'] <> '{}' OR NOT EXISTS (
              SELECT 1 FROM chat.workspace_items i
              WHERE i.id::text = v_ref->>'item_id' AND chat.history_floor(i.chat_id,v_owner) IS NOT NULL
            ) THEN RAISE EXCEPTION 'Attachment reference is not visible to this account' USING ERRCODE = '42501'; END IF;$boundary$;
BEGIN
    IF (length(v_definition) - length(replace(v_definition,v_boundary,''))) <> length(v_boundary) THEN
        RAISE EXCEPTION 'Assistant work attachment validation boundary differs';
    END IF;
    EXECUTE replace(v_definition,v_boundary,'            PERFORM identity.assistant_work_attachment(v_ref,v_event,v_work);');
END;
$migration$;
-- The installation's DDL guard closes API functions even on replacement.
-- Restore only the reviewed caller role after the complete replacement.
GRANT EXECUTE ON FUNCTION identity.assistant_work_commit(text,text,uuid,uuid,jsonb,jsonb) TO authenticated;
