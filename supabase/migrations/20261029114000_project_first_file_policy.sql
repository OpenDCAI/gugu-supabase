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
CREATE FUNCTION file_private.link_project_message(p_item uuid,p_message text) RETURNS void
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

-- Extend the existing transactions after the authoritative message has been inserted. A rejected send rolls back
-- its revision and backlink together. Handoff claims have been restored to the host before this metadata write.
DO $links$ DECLARE definition text; before_text text; BEGIN
    SELECT pg_get_functiondef('chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb)'::regprocedure) INTO definition;
    before_text:=$old$        ) AS sent;
    END IF;$old$;
    IF position(before_text IN definition)=0 THEN RAISE EXCEPTION 'Unexpected host publication predecessor'; END IF;
    EXECUTE replace(definition,before_text,$new$        ) AS sent;
        PERFORM file_private.link_project_message(p_item,message->>'id');
    END IF;$new$);

    SELECT pg_get_functiondef('chat.file_version_handoff_publish(uuid,text,text,bigint)'::regprocedure) INTO definition;
    before_text:=$old$    UPDATE chat.file_version_handoffs SET state='published',version=$old$;
    IF position(before_text IN definition)=0 THEN RAISE EXCEPTION 'Unexpected handoff publication predecessor'; END IF;
    EXECUTE replace(definition,before_text,$new$    PERFORM file_private.link_project_message(h.item_id,sent_message->>'id');
    UPDATE chat.file_version_handoffs SET state='published',version=$new$);
END $links$;

-- The installation DDL guard closes replaced RPCs. Preserve their existing authenticated-only surface.
REVOKE ALL ON FUNCTION chat.file_project_policy_for(text,text),
    chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb),
    chat.file_version_handoff_publish(uuid,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_project_policy_for(text,text),
    chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb),
    chat.file_version_handoff_publish(uuid,text,text,bigint) TO authenticated;
NOTIFY pgrst,'reload schema';
