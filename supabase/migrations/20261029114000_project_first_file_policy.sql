-- A previously installed later publisher release must never be overwritten by this older contract.
-- Fresh installations apply this release first; an out-of-order deployment needs a later reconciliation release.
DO $order$ BEGIN
    IF EXISTS(SELECT 1 FROM gugu_install.releases WHERE version='20261029144500_explicit_message_actor') THEN
        RAISE EXCEPTION 'Install the project first-file release before the explicit actor release; this database needs a later reconciliation release'
            USING HINT='project_file_release_order';
    END IF;
END $order$;

-- #577: a project group's first file must not depend on its host having sent a seed file.
-- Resolve the existing binding on the first policy read, including projects published before their chat exists.
-- Only a project owned by a room owner/admin can establish the default; a member cannot nominate their machine.
-- An explicit binding (also while temporarily unlisted) always wins, as before.
CREATE OR REPLACE FUNCTION chat.file_project_policy_for(p_chat text,p_as text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE g text:=chat.workspace_require_room_member(p_chat,chat.workspace_actor_for(p_as));
BEGIN
    IF NOT EXISTS(SELECT 1 FROM chat.file_project_policies WHERE chat_id=g) THEN
        INSERT INTO chat.file_project_policies(chat_id,host_device_id,host_project_id)
        SELECT g,dp.device_id,dp.local_project_id
          FROM identity.device_projects dp JOIN identity.gugu_devices d ON d.device_id=dp.device_id AND d.user_id=dp.user_id
          JOIN chat.chat_members m ON m.chat_id=dp.chat_id AND m.user_id=dp.user_id::text AND m.role IN ('owner','admin')
         WHERE dp.chat_id=g
         ORDER BY dp.group_representative DESC,dp.created_at,dp.device_id,dp.local_project_id
         LIMIT 1
        ON CONFLICT(chat_id) DO NOTHING;
    END IF;
    RETURN (SELECT to_jsonb(p)||jsonb_build_object('host_account_id',dp.user_id,'host_label',d.label,'host_online',d.status='online')
            ||chat.file_storage_policy(g)
        FROM chat.file_project_policies p JOIN identity.device_projects dp
        ON dp.device_id=p.host_device_id AND dp.local_project_id=p.host_project_id AND dp.chat_id=p.chat_id
        LEFT JOIN identity.gugu_devices d ON d.device_id=p.host_device_id WHERE p.chat_id=g);
END $$;

-- Both host publications use the existing source-message array. Keep the public publisher SECURITY INVOKER;
-- only this private metadata write is privileged, and it requires the actual message/file pair and bound host.
CREATE OR REPLACE FUNCTION file_private.link_project_message(p_item uuid,p_message text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM chat.workspace_items w
        JOIN chat.messages m ON m.id=p_message AND m.file_item_id=w.id AND NOT m.is_whisper
        JOIN chat.chats c ON c.id=m.chat_id AND COALESCE(c.source_chat_id,c.id)=w.chat_id
        JOIN chat.file_project_policies p ON p.chat_id=w.chat_id
        JOIN identity.device_projects dp ON dp.device_id=p.host_device_id AND dp.local_project_id=p.host_project_id AND dp.chat_id=p.chat_id
        JOIN identity.gugu_devices d ON d.device_id=dp.device_id AND d.user_id=dp.user_id
        WHERE w.id=p_item AND dp.user_id=auth.uid() AND chat.is_chat_member(w.chat_id,auth.uid()::text)
          AND EXISTS(SELECT 1 FROM chat.file_device_revisions r WHERE r.item_id=w.id AND r.version=m.file_version
              AND r.host_device_id=dp.device_id AND r.host_project_id=dp.local_project_id)) THEN
        RAISE EXCEPTION 'Only the bound host can link its published file message' USING HINT='file_transfer_denied';
    END IF;
    UPDATE chat.workspace_items SET source_message_ids=array_append(source_message_ids,p_message)
        WHERE id=p_item AND NOT p_message=ANY(source_message_ids);
END $$;
REVOKE ALL ON FUNCTION file_private.link_project_message(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION file_private.link_project_message(uuid,text) TO authenticated;

-- Complete publisher definitions from the current dev contract. The directory insertion trigger allocates the
-- stored name; use that exact result for the revision and its message. Preserve the existing authorization and
-- transaction boundaries. Later delegated-subject releases must retain this allocation contract.
CREATE OR REPLACE FUNCTION file_private.publish_revision_by(p_item uuid,p_chat text,p_device text,p_path text,p_sha text,p_size bigint,
    p_filename text,p_type text,p_expected integer DEFAULT NULL,p_parent uuid DEFAULT NULL,p_by text DEFAULT NULL) RETURNS jsonb
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
        INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,created_by,updated_by,parent_id)
        VALUES(p_item,g,'file',p_filename,p_type,p_size,COALESCE(p_by,auth.uid()::text),p_by,p_parent) RETURNING filename INTO p_filename;
    END IF;
    INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type)
    VALUES(p_item,n,p_device,p.host_project_id,p_path,p_sha,p_size,chat.workspace_stored_name(p_filename),p_type);
    IF w.id IS NOT NULL THEN
        UPDATE chat.workspace_items SET version=n,blob_id=NULL,size_bytes=p_size,filename=p_filename,content_type=p_type,updated_by=COALESCE(p_by,auth.uid()::text) WHERE id=w.id;
    END IF;
    RETURN jsonb_build_object('item_id',p_item,'version',n,'sha256',p_sha,'size_bytes',p_size,'envelope',chat.workspace_version_envelope(p_item,n));
END $$;
REVOKE ALL ON FUNCTION file_private.publish_revision_by(uuid,text,text,text,text,bigint,text,text,integer,uuid,text)
    FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION chat.file_device_publish(p_item uuid,p_chat text,p_device text,p_path text,p_sha text,p_size bigint,
    p_filename text,p_type text,p_expected integer DEFAULT NULL,p_parent uuid DEFAULT NULL,p_message jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE revision jsonb; message jsonb; sender text;
BEGIN
    IF p_message IS NOT NULL THEN
        IF jsonb_typeof(p_message) IS DISTINCT FROM 'object' OR COALESCE((p_message->>'is_whisper')::boolean,false) THEN
            RAISE EXCEPTION 'A local project publication cannot be a whisper' USING HINT='file_transfer_denied';
        END IF;
        sender:=COALESCE(NULLIF(p_message->>'sender_user_id',''),auth.uid()::text);
        IF NOT chat.can_act_as(sender,p_chat) THEN
            RAISE EXCEPTION 'A project file can be sent only as yourself or your own agent in this chat' USING ERRCODE='42501',HINT='file_transfer_denied';
        END IF;
    END IF;
    revision:=file_private.publish_revision(p_item,p_chat,p_device,p_path,p_sha,p_size,p_filename,p_type,p_expected,p_parent);
    IF p_message IS NOT NULL THEN
        SELECT to_jsonb(sent) INTO message FROM chat.send_message_idempotent(
            p_message->>'message_id',p_chat,sender,ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_message->'to_user_ids','[]'::jsonb))),
            (revision->>'envelope')||chat.attachment_caption_suffix(p_message->>'caption'),
            'attachment',p_message->>'reply_to_message_id',p_message->>'thread_root_id',COALESCE((p_message->>'is_thread_root')::boolean,false),
            false,p_message->>'via_app',p_item,(revision->>'version')::integer
        ) AS sent;
        PERFORM file_private.link_project_message(p_item,message->>'id');
    END IF;
    RETURN (revision-'envelope')||CASE WHEN message IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('message',message) END;
END $$;

CREATE OR REPLACE FUNCTION chat.file_version_handoff_publish(p_id uuid,p_path text,p_sha text,p_size bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h chat.file_version_handoffs%ROWTYPE; revision jsonb; sent_message jsonb; hint text;
    claims text:=current_setting('request.jwt.claims',true); sub text:=current_setting('request.jwt.claim.sub',true);
BEGIN
    SELECT * INTO h FROM chat.file_version_handoffs WHERE id=p_id FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM identity.gugu_devices d WHERE d.device_id=h.host_device_id AND d.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'Handoff is not for this host' USING HINT='file_transfer_denied';
    END IF;
    IF h.state<>'ready' OR h.ready_until<=now() THEN RETURN chat.file_version_handoff_status_of(h); END IF;
    IF (p_sha,p_size) IS DISTINCT FROM (h.sha256,h.size_bytes) THEN
        RAISE EXCEPTION 'Handoff bytes differ from the commitment' USING HINT='file_transfer_conflict';
    END IF;
    BEGIN
        revision:=file_private.publish_revision_by(h.item_id,h.chat_id,h.host_device_id,p_path,p_sha,p_size,h.file_name,h.content_type,
            h.base_version,NULL,h.requester_actor);
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS hint=PG_EXCEPTION_HINT;
        IF hint IS DISTINCT FROM 'file_transfer_conflict' THEN RAISE; END IF;
        UPDATE chat.file_version_handoffs SET state='retired',outcome='conflict',data_key=NULL WHERE id=h.id RETURNING * INTO h;
        RETURN chat.file_version_handoff_status_of(h);
    END;
    BEGIN
        PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',h.requester_account,'role','authenticated')::text,true);
        PERFORM set_config('request.jwt.claim.sub',h.requester_account,true);
        SELECT to_jsonb(sent) INTO sent_message FROM chat.send_message_idempotent(
            COALESCE(h.message->>'message_id',h.id::text),COALESCE(h.message->>'chat_id',h.chat_id),h.requester_actor,
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(h.message->'to_user_ids','[]'::jsonb))),
            (revision->>'envelope')||chat.attachment_caption_suffix(h.message->>'caption'),
            'attachment',h.message->>'reply_to_message_id',h.message->>'thread_root_id',COALESCE((h.message->>'is_thread_root')::boolean,false),
            false,h.message->>'via_app',h.item_id,(revision->>'version')::integer
        ) AS sent;
        PERFORM set_config('request.jwt.claims',COALESCE(claims,''),true),set_config('request.jwt.claim.sub',COALESCE(sub,''),true);
    EXCEPTION WHEN OTHERS THEN
        PERFORM set_config('request.jwt.claims',COALESCE(claims,''),true),set_config('request.jwt.claim.sub',COALESCE(sub,''),true);
        RAISE;
    END;
    PERFORM file_private.link_project_message(h.item_id,sent_message->>'id');
    UPDATE chat.file_version_handoffs SET state='published',version=(revision->>'version')::integer,message_id=sent_message->>'id',data_key=NULL
        WHERE id=h.id RETURNING * INTO h;
    RETURN chat.file_version_handoff_status_of(h)||jsonb_build_object('message',sent_message);
END $$;

-- The installation DDL guard closes replaced RPCs. Preserve their existing authenticated-only surface.
REVOKE ALL ON FUNCTION chat.file_project_policy_for(text,text),
    chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb),
    chat.file_version_handoff_publish(uuid,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_project_policy_for(text,text),
    chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb),
    chat.file_version_handoff_publish(uuid,text,text,bigint) TO authenticated;
NOTIFY pgrst,'reload schema';
