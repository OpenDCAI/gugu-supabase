-- A file of a chat's folder is sent as an attachment card by reference, and a changed file is sent as its next version.
--   · chat.attachment_share: a message pinned to a folder file's version, no bytes moved. The file in the chat's own
--     folder (a topic: its source's) is pinned as it is; a file of another chat the sender can read gets an item in this
--     chat's 附件 pointing at the same blob, as a forward does.
--   · chat.attachment_commit takes p_item_id + p_expected_version: the upload becomes that file's next version and the
--     message pins it, in one transaction. The same bytes as that version pin it without a new version.
--   · chat.attachment_place_forward: a forward inside the chat whose folder holds the file pins that file.
--   · chat.message_history_as / message_search_as return file_item_id and file_version, so an agent reading history
--     knows which folder file an attachment is.

-- ── share ───────────────────────────────────────────────────────────────────────────
CREATE FUNCTION chat.attachment_place_share(p_item_id uuid, p_version integer, p_chat_id text, p_sender_user_id text, p_message_id text) RETURNS TABLE(item_id uuid, item_version integer, envelope text, file_blob_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_item chat.workspace_items%ROWTYPE;
    v_version INTEGER;
    v_blob UUID;
    v_resource TEXT;
    v_placed chat.workspace_items%ROWTYPE;
BEGIN
    PERFORM chat.attachment_sender_check(p_chat_id, p_sender_user_id);
    IF NULLIF(p_message_id, '') IS NULL THEN
        RAISE EXCEPTION 'attachment_share: a message id is required';
    END IF;
    v_item := chat.workspace_item_for(p_item_id::TEXT, p_sender_user_id, false);
    IF v_item.kind <> 'file' THEN
        RAISE EXCEPTION USING HINT = 'file_place_invalid',
            MESSAGE = format('%s is not a stored file (a text file people edit together, or a folder): send its link instead', v_item.filename);
    END IF;
    v_version := COALESCE(p_version, v_item.version);
    v_blob := chat.workspace_version_blob(v_item.id, v_version);
    IF v_blob IS NULL THEN
        RAISE EXCEPTION USING HINT = 'attachment_source_gone',
            MESSAGE = format('%s has no version %s any more (it is at version %s)', v_item.filename, v_version, v_item.version);
    END IF;
    v_resource := chat.workspace_require_room_member(p_chat_id, p_sender_user_id);
    IF v_item.chat_id = v_resource THEN
        RETURN QUERY SELECT v_item.id, v_version, chat.workspace_version_envelope(v_item.id, v_version), NULL::UUID;
        RETURN;
    END IF;
    v_placed := chat.attachment_item_for(p_chat_id, v_blob, v_item.filename, p_sender_user_id, p_message_id);
    RETURN QUERY SELECT v_placed.id, v_placed.version, chat.workspace_version_envelope(v_placed.id, v_placed.version), NULL::UUID;
END;
$$;
REVOKE ALL ON FUNCTION chat.attachment_place_share(uuid, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.attachment_place_share(uuid, integer, text, text, text) TO authenticated;

CREATE FUNCTION chat.attachment_share(p_item_id uuid, p_version integer, p_message_id text, p_chat_id text, p_sender_user_id text, p_to_user_ids text[] DEFAULT '{}'::text[], p_reply_to_message_id text DEFAULT NULL::text, p_thread_root_id text DEFAULT NULL::text, p_is_thread_root boolean DEFAULT false, p_via_app text DEFAULT NULL::text, p_caption text DEFAULT NULL::text) RETURNS SETOF chat.messages_view
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
    v_placed RECORD;
BEGIN
    SELECT * INTO v_placed FROM chat.attachment_place_share(p_item_id, p_version, p_chat_id, p_sender_user_id, p_message_id);
    RETURN QUERY
    SELECT * FROM chat.send_message_idempotent(
        p_message_id, p_chat_id, p_sender_user_id, COALESCE(p_to_user_ids, '{}'), v_placed.envelope || chat.attachment_caption_suffix(p_caption), 'attachment',
        p_reply_to_message_id, p_thread_root_id, COALESCE(p_is_thread_root, false), false, p_via_app,
        v_placed.item_id, v_placed.item_version, NULL, NULL);
END;
$$;
REVOKE ALL ON FUNCTION chat.attachment_share(uuid, integer, text, text, text, text[], text, text, boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.attachment_share(uuid, integer, text, text, text, text[], text, text, boolean, text, text) TO authenticated;

-- ── commit as a file's next version ───────────────────────────────────────────────────
CREATE FUNCTION chat.attachment_place_version(p_staging_key text, p_item_id uuid, p_expected_version integer, p_chat_id text, p_sender_user_id text, p_message_id text) RETURNS TABLE(item_id uuid, item_version integer, envelope text, file_blob_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_upload chat.file_blob_uploads%ROWTYPE;
    v_item chat.workspace_items%ROWTYPE;
    v_version INTEGER;
    v_envelope TEXT;
BEGIN
    PERFORM chat.attachment_sender_check(p_chat_id, p_sender_user_id);
    IF NULLIF(p_message_id, '') IS NULL THEN
        RAISE EXCEPTION 'attachment_commit: a message id is required';
    END IF;
    IF p_expected_version IS NULL THEN
        RAISE EXCEPTION USING HINT = 'file_place_invalid',
            MESSAGE = 'a next version names the version it starts from (expected_version)';
    END IF;
    SELECT * INTO v_upload FROM chat.file_blob_uploads u WHERE u.staging_key = p_staging_key FOR UPDATE;
    IF NOT FOUND OR v_upload.uploader IS DISTINCT FROM (SELECT auth.uid()::text) OR v_upload.expires_at <= now() THEN
        RAISE EXCEPTION USING HINT = 'attachment_upload_not_found',
            MESSAGE = format('no upload %s of yours is waiting to be sent', p_staging_key);
    END IF;
    IF v_upload.message_id IS NOT NULL THEN
        IF v_upload.message_id IS DISTINCT FROM p_message_id OR v_upload.item_id IS DISTINCT FROM p_item_id THEN
            RAISE EXCEPTION USING HINT = 'attachment_upload_used',
                MESSAGE = format('upload %s was already sent as message %s', p_staging_key, v_upload.message_id);
        END IF;
        -- 同一条消息重试:同一个条目、同一版、同一段正文。
        RETURN QUERY SELECT v_upload.item_id, v_upload.item_version, v_upload.envelope, NULL::UUID;
        RETURN;
    END IF;
    v_item := chat.workspace_item_for(p_item_id::TEXT, p_sender_user_id, true);
    IF v_item.chat_id IS DISTINCT FROM chat.workspace_require_room_member(p_chat_id, p_sender_user_id) THEN
        RAISE EXCEPTION USING HINT = 'message_file_not_here',
            MESSAGE = format('%s is in another chat''s folder: a next version is sent in the chat whose folder holds it', v_item.filename);
    END IF;
    IF v_item.kind = 'file' AND p_expected_version = v_item.version AND v_upload.blob_id = v_item.blob_id THEN
        -- 和起点那一版一样的字节:不出新版,钉住那一版。
        v_version := v_item.version;
    ELSE
        -- 是不是文件、起点是不是现在这一版、换版本与修剪:都是 file_replace_as 的规矩,只在这一处。
        SELECT r.version INTO v_version FROM chat.file_replace_as(p_staging_key, p_item_id::TEXT, p_sender_user_id, p_expected_version) r;
    END IF;
    v_envelope := chat.workspace_version_envelope(v_item.id, v_version);
    UPDATE chat.file_blob_uploads u
       SET message_id = p_message_id, item_id = v_item.id, item_version = v_version, envelope = v_envelope
     WHERE u.staging_key = p_staging_key;
    RETURN QUERY SELECT v_item.id, v_version, v_envelope, NULL::UUID;
END;
$$;
REVOKE ALL ON FUNCTION chat.attachment_place_version(text, uuid, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.attachment_place_version(text, uuid, integer, text, text, text) TO authenticated;

DROP FUNCTION chat.attachment_commit(text, text, text, text, text, text[], text, text, boolean, boolean, text, text);
CREATE FUNCTION chat.attachment_commit(p_staging_key text, p_message_id text, p_chat_id text, p_sender_user_id text, p_file_name text, p_to_user_ids text[] DEFAULT '{}'::text[], p_reply_to_message_id text DEFAULT NULL::text, p_thread_root_id text DEFAULT NULL::text, p_is_thread_root boolean DEFAULT false, p_is_whisper boolean DEFAULT false, p_via_app text DEFAULT NULL::text, p_caption text DEFAULT NULL::text, p_item_id uuid DEFAULT NULL::uuid, p_expected_version integer DEFAULT NULL::integer) RETURNS SETOF chat.messages_view
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
    v_placed RECORD;
BEGIN
    IF p_item_id IS NOT NULL THEN
        IF COALESCE(p_is_whisper, false) THEN
            RAISE EXCEPTION USING HINT = 'file_place_invalid',
                MESSAGE = 'a whisper carries its own bytes, outside the folder: it cannot be a folder file''s next version';
        END IF;
        SELECT * INTO v_placed FROM chat.attachment_place_version(p_staging_key, p_item_id, p_expected_version, p_chat_id, p_sender_user_id, p_message_id);
    ELSE
        SELECT * INTO v_placed FROM chat.attachment_place(p_staging_key, p_chat_id, p_sender_user_id, p_file_name, p_message_id, COALESCE(p_is_whisper, false));
    END IF;
    RETURN QUERY
    SELECT * FROM chat.send_message_idempotent(
        p_message_id, p_chat_id, p_sender_user_id, COALESCE(p_to_user_ids, '{}'), v_placed.envelope || chat.attachment_caption_suffix(p_caption), 'attachment',
        p_reply_to_message_id, p_thread_root_id, COALESCE(p_is_thread_root, false), COALESCE(p_is_whisper, false), p_via_app,
        v_placed.item_id, v_placed.item_version, NULL, v_placed.file_blob_id);
END;
$$;
REVOKE ALL ON FUNCTION chat.attachment_commit(text, text, text, text, text, text[], text, text, boolean, boolean, text, text, uuid, integer) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION chat.attachment_commit(text, text, text, text, text, text[], text, text, boolean, boolean, text, text, uuid, integer) TO authenticated;

-- ── forward inside the chat that holds the file: pin that file ──────────────────────────
CREATE OR REPLACE FUNCTION chat.attachment_place_forward(p_source_message_id text, p_chat_id text, p_sender_user_id text, p_message_id text, p_is_whisper boolean DEFAULT false) RETURNS TABLE(item_id uuid, item_version integer, envelope text, file_blob_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_source chat.messages%ROWTYPE;
    v_blob chat.file_blobs%ROWTYPE;
    v_blob_id UUID;
    v_name TEXT;
    v_item chat.workspace_items%ROWTYPE;
    v_source_item chat.workspace_items%ROWTYPE;
BEGIN
    PERFORM chat.attachment_sender_check(p_chat_id, p_sender_user_id);
    SELECT * INTO v_source FROM chat.messages m WHERE m.id = p_source_message_id AND m.deleted_at IS NULL;
    IF NOT FOUND OR NOT chat.can_read_message(p_source_message_id, p_sender_user_id) THEN
        RAISE EXCEPTION USING HINT = 'attachment_source_not_found',
            MESSAGE = format('message %s is not one you can read', p_source_message_id);
    END IF;
    IF v_source.retracted_at IS NOT NULL THEN
        RAISE EXCEPTION USING HINT = 'attachment_source_retracted', MESSAGE = format('message %s was retracted', p_source_message_id);
    END IF;
    -- ◇ 字节:悄悄话附件直接指着的,或者条目钉住的那一版;名字:信封里的,或者条目现在的。
    IF v_source.file_blob_id IS NOT NULL THEN
        v_blob_id := v_source.file_blob_id;
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = v_blob_id;
        v_name := chat.attachment_envelope_name(v_source.content, v_blob.size_bytes, v_blob.content_type);
    ELSIF v_source.file_item_id IS NOT NULL THEN
        v_blob_id := chat.workspace_version_blob(v_source.file_item_id, v_source.file_version);
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = v_blob_id;
        SELECT * INTO v_source_item FROM chat.workspace_items w WHERE w.id = v_source.file_item_id;
        v_name := v_source_item.filename;
    ELSE
        RAISE EXCEPTION USING HINT = 'attachment_source_gone',
            MESSAGE = 'that message has no file to forward (it was deleted from its folder, or it is not an attachment)';
    END IF;
    IF v_blob_id IS NULL THEN
        RAISE EXCEPTION USING HINT = 'attachment_source_gone', MESSAGE = 'that version of the file has no bytes left';
    END IF;
    -- ◇ 转成悄悄话:指同一份字节,不进目标的文件夹。
    IF COALESCE(p_is_whisper, false) THEN
        PERFORM chat.file_blob_take(v_blob_id);
        RETURN QUERY SELECT NULL::UUID, NULL::INTEGER, chat.attachment_envelope(v_name, v_blob.size_bytes, v_blob.content_type), v_blob_id;
        RETURN;
    END IF;
    -- ◇ 转进放着这个文件的会话(它自己、它的话题):钉住同一个文件的同一版,不在「附件」里另建。
    IF v_source_item.id IS NOT NULL
       AND v_source_item.chat_id = chat.workspace_require_room_member(p_chat_id, p_sender_user_id) THEN
        RETURN QUERY SELECT v_source_item.id, v_source.file_version, chat.workspace_version_envelope(v_source_item.id, v_source.file_version), NULL::UUID;
        RETURN;
    END IF;
    v_item := chat.attachment_item_for(p_chat_id, v_blob_id, v_name, p_sender_user_id, p_message_id);
    RETURN QUERY SELECT v_item.id, v_item.version, chat.workspace_version_envelope(v_item.id, v_item.version), NULL::UUID;
END;
$$;

-- ── history and search say which folder file an attachment is ───────────────────────────
DROP FUNCTION chat.message_history_as(text, text, text, bigint, integer);
CREATE FUNCTION chat.message_history_as(p_chat_id text, p_as_user_id text DEFAULT NULL::text, p_thread_root_id text DEFAULT NULL::text, p_before_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 20) RETURNS TABLE(id text, seq bigint, sender_user_id text, sender_name text, to_user_ids text[], content text, content_type text, reply_to_message_id text, thread_root_id text, created_at timestamp with time zone, file_item_id uuid, file_version integer)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := COALESCE(NULLIF(trim(COALESCE(p_as_user_id, '')), ''), (SELECT auth.uid()::text));
BEGIN
    IF v_actor IS NULL OR NOT chat.is_acting_as(v_actor) THEN
        RAISE EXCEPTION 'Not allowed to act as %', v_actor;
    END IF;
    RETURN QUERY
    SELECT m.id, m.seq::BIGINT, m.sender_user_id, COALESCE(u.display_name, '未知用户'), m.to_user_ids, m.content,
           m.content_type, m.reply_to_message_id, m.thread_root_id, m.created_at, m.file_item_id, m.file_version
      FROM chat.messages m
      LEFT JOIN identity.users u ON u.id = m.sender_user_id
     WHERE m.chat_id = p_chat_id
       AND m.deleted_at IS NULL
       AND m.thread_root_id IS NOT DISTINCT FROM NULLIF(p_thread_root_id, '')
       AND (p_before_seq IS NULL OR m.seq < p_before_seq)
       -- The one visibility rule; the actor's history floor is computed once per query.
       AND chat.message_visible_at((SELECT chat.history_floor(p_chat_id, v_actor)),
             m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, v_actor)
     ORDER BY m.seq DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
END;
$$;
REVOKE ALL ON FUNCTION chat.message_history_as(text, text, text, bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.message_history_as(text, text, text, bigint, integer) TO authenticated, service_role;

DROP FUNCTION chat.message_search_as(text, text, text, bigint, integer);
CREATE FUNCTION chat.message_search_as(p_chat_id text, p_query text, p_as_user_id text DEFAULT NULL::text, p_before_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 20) RETURNS TABLE(id text, seq bigint, sender_user_id text, sender_name text, content text, content_type text, thread_root_id text, created_at timestamp with time zone, file_item_id uuid, file_version integer)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := COALESCE(NULLIF(trim(COALESCE(p_as_user_id, '')), ''), (SELECT auth.uid()::text));
    v_pattern TEXT := '%' || replace(replace(replace(COALESCE(p_query, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
BEGIN
    IF v_actor IS NULL OR NOT chat.is_acting_as(v_actor) THEN
        RAISE EXCEPTION 'Not allowed to act as %', v_actor;
    END IF;
    RETURN QUERY
    SELECT m.id, m.seq::BIGINT, m.sender_user_id, COALESCE(u.display_name, '未知用户'), m.content,
           m.content_type, m.thread_root_id, m.created_at, m.file_item_id, m.file_version
      FROM chat.messages m
      LEFT JOIN identity.users u ON u.id = m.sender_user_id
     WHERE m.chat_id = p_chat_id
       AND m.deleted_at IS NULL
       AND m.content ILIKE v_pattern
       AND (p_before_seq IS NULL OR m.seq < p_before_seq)
       -- The one visibility rule; the actor's history floor is computed once per query.
       AND chat.message_visible_at((SELECT chat.history_floor(p_chat_id, v_actor)),
             m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, v_actor)
     ORDER BY m.seq DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
END;
$$;
REVOKE ALL ON FUNCTION chat.message_search_as(text, text, text, bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.message_search_as(text, text, text, bigint, integer) TO authenticated, service_role;
