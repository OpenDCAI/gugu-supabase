-- Sending a folder file by reference (attachment_share) checked only for a cloud blob behind the version, so a project
-- file kept on its host — a local revision, no blob — was refused as if the version were gone, in words that contradict
-- themselves: "itinerary.md has no version 1 any more (it is at version 1)".
--   · A version with a local revision is there: in its own chat (a topic: its source's) it is pinned as it is.
--   · It has no bytes in the cloud to place in another chat, so sending it there is refused, saying so.
--   · A version that is truly not there says whether it is gone or not made yet.
DO $share_local$
DECLARE definition text; r record;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('chat.attachment_place_share(uuid,integer,text,text,text)',
         $old$    v_blob := chat.workspace_version_blob(v_item.id, v_version);
    IF v_blob IS NULL THEN
        RAISE EXCEPTION USING HINT = 'attachment_source_gone',
            MESSAGE = format('%s has no version %s any more (it is at version %s)', v_item.filename, v_version, v_item.version);
    END IF;
$old$,
         $new$    v_blob := chat.workspace_version_blob(v_item.id, v_version);
    -- A project file kept on its host has a local revision for the version instead of a blob: it is there.
    IF v_blob IS NULL AND NOT EXISTS(SELECT 1 FROM chat.file_device_revisions d WHERE d.item_id = v_item.id AND d.version = v_version) THEN
        RAISE EXCEPTION USING HINT = 'attachment_source_gone',
            MESSAGE = CASE WHEN v_version > v_item.version
                THEN format('%s has no version %s yet (it is at version %s)', v_item.filename, v_version, v_item.version)
                ELSE format('%s has no version %s any more (it is at version %s)', v_item.filename, v_version, v_item.version) END;
    END IF;
$new$),
        ('chat.attachment_place_share(uuid,integer,text,text,text)',
         $old$    v_placed := chat.attachment_item_for(p_chat_id, v_blob, v_item.filename, p_sender_user_id, p_message_id);
$old$,
         $new$    IF v_blob IS NULL THEN
        RAISE EXCEPTION USING HINT = 'file_transfer_read_only',
            MESSAGE = format('%s is kept on its host computer: it can be sent only in its own chat', v_item.filename);
    END IF;
    v_placed := chat.attachment_item_for(p_chat_id, v_blob, v_item.filename, p_sender_user_id, p_message_id);
$new$)
    ) AS patches(signature, old_body, new_body) LOOP
        SELECT pg_get_functiondef(r.signature::regprocedure) INTO definition;
        IF position(r.old_body IN definition) = 0 OR
           length(definition) - length(replace(definition, r.old_body, '')) <> length(r.old_body) THEN
            RAISE EXCEPTION 'Unexpected attachment_share predecessor: %', r.signature;
        END IF;
        EXECUTE replace(definition, r.old_body, r.new_body);
    END LOOP;
END $share_local$;
NOTIFY pgrst, 'reload schema';
