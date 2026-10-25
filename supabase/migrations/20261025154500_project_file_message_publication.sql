CREATE SCHEMA IF NOT EXISTS file_private;
REVOKE ALL ON SCHEMA file_private FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA file_private TO authenticated;
DROP FUNCTION chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid);
CREATE FUNCTION file_private.publish_revision(p_item uuid,p_chat text,p_device text,p_path text,p_sha text,p_size bigint,
    p_filename text,p_type text,p_expected integer DEFAULT NULL,p_parent uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE g text:=chat.workspace_require_room_member(p_chat,chat.workspace_actor_for(auth.uid()::text));
    p chat.file_project_policies%ROWTYPE; w chat.workspace_items%ROWTYPE; n integer;
BEGIN
    SELECT policy.* INTO p FROM chat.file_project_policies policy JOIN identity.device_projects dp
        ON dp.device_id=policy.host_device_id AND dp.local_project_id=policy.host_project_id AND dp.chat_id=policy.chat_id
        JOIN identity.gugu_devices d ON d.device_id=dp.device_id
        WHERE policy.chat_id=g AND dp.device_id=p_device AND dp.user_id=auth.uid() AND d.user_id=auth.uid()
        FOR SHARE OF policy,dp,d;
    IF NOT FOUND THEN RAISE EXCEPTION 'Only the bound host can publish a local revision' USING HINT='file_transfer_denied'; END IF;
    SELECT * INTO w FROM chat.workspace_items WHERE id=p_item FOR UPDATE;
    IF FOUND THEN
        IF w.chat_id<>g OR w.kind<>'file' OR w.version IS DISTINCT FROM p_expected THEN
            RAISE EXCEPTION 'File revision conflict' USING HINT='file_transfer_conflict';
        END IF;
        INSERT INTO chat.workspace_item_versions(item_id,n,blob_id,content_type,size_bytes,made_by,made_at)
        VALUES(w.id,w.version,w.blob_id,w.content_type,w.size_bytes,w.created_by,w.updated_at) ON CONFLICT DO NOTHING;
        n:=w.version+1;
    ELSE
        IF p_expected IS NOT NULL THEN RAISE EXCEPTION 'File revision conflict' USING HINT='file_transfer_conflict'; END IF;
        n:=1;
        INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,created_by,parent_id)
        VALUES(p_item,g,'file',p_filename,p_type,p_size,auth.uid()::text,p_parent);
    END IF;
    INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type)
    VALUES(p_item,n,p_device,p.host_project_id,p_path,p_sha,p_size,chat.workspace_stored_name(p_filename),p_type);
    IF w.id IS NOT NULL THEN
        UPDATE chat.workspace_items SET version=n,blob_id=NULL,size_bytes=p_size,filename=p_filename,content_type=p_type,updated_by=auth.uid()::text WHERE id=w.id;
    END IF;
    RETURN jsonb_build_object('item_id',p_item,'version',n,'sha256',p_sha,'size_bytes',p_size,'envelope',chat.workspace_version_envelope(p_item,n));
END $$;
REVOKE ALL ON FUNCTION file_private.publish_revision(uuid,text,text,text,text,bigint,text,text,integer,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION file_private.publish_revision(uuid,text,text,text,text,bigint,text,text,integer,uuid) TO authenticated;
CREATE FUNCTION chat.file_device_publish(p_item uuid,p_chat text,p_device text,p_path text,p_sha text,p_size bigint,
    p_filename text,p_type text,p_expected integer DEFAULT NULL,p_parent uuid DEFAULT NULL,p_message jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE revision jsonb; message jsonb;
BEGIN
    revision:=file_private.publish_revision(p_item,p_chat,p_device,p_path,p_sha,p_size,p_filename,p_type,p_expected,p_parent);
    IF p_message IS NOT NULL THEN
        IF jsonb_typeof(p_message) IS DISTINCT FROM 'object' OR COALESCE((p_message->>'is_whisper')::boolean,false) THEN
            RAISE EXCEPTION 'A local project publication cannot be a whisper' USING HINT='file_transfer_denied';
        END IF;
        SELECT to_jsonb(sent) INTO message FROM chat.send_message_idempotent(
            p_message->>'message_id',p_chat,auth.uid()::text,ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_message->'to_user_ids','[]'::jsonb))),
            (revision->>'envelope')||chat.attachment_caption_suffix(p_message->>'caption'),
            'attachment',p_message->>'reply_to_message_id',p_message->>'thread_root_id',COALESCE((p_message->>'is_thread_root')::boolean,false),
            false,p_message->>'via_app',p_item,(revision->>'version')::integer
        ) AS sent;
    END IF;
    RETURN (revision-'envelope')||CASE WHEN message IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('message',message) END;
END $$;
REVOKE ALL ON FUNCTION chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb) TO authenticated;

-- A local file's content version is a body edit even though its bytes stay outside the database.
CREATE OR REPLACE FUNCTION chat.set_workspace_item_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
    IF NEW.inline_text IS DISTINCT FROM OLD.inline_text OR NEW.blob_id IS DISTINCT FROM OLD.blob_id
       OR (NEW.kind='file' AND NEW.version IS DISTINCT FROM OLD.version) THEN
        NEW.updated_at:=now();
    ELSE
        NEW.updated_at:=OLD.updated_at;
        NEW.updated_by:=OLD.updated_by;
    END IF;
    RETURN NEW;
END $$;
