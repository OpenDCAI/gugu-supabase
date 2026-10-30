-- Keep the last content editor separate from the creator. Historical editors remain unknown.
ALTER TABLE chat.workspace_items ADD COLUMN updated_by text;
COMMENT ON COLUMN chat.workspace_items.updated_by IS
  'The person or agent who last changed the content; NULL when unknown. Written with the body by the file service or replacement RPC.';
GRANT UPDATE (updated_by) ON chat.workspace_items TO gugu_files;

CREATE OR REPLACE FUNCTION chat.set_workspace_item_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'chat', 'public' AS $$
BEGIN
    IF NEW.inline_text IS DISTINCT FROM OLD.inline_text OR NEW.blob_id IS DISTINCT FROM OLD.blob_id THEN
        NEW.updated_at := now();
    ELSE
        NEW.updated_at := OLD.updated_at;
        NEW.updated_by := OLD.updated_by;
    END IF;
    RETURN NEW;
END;
$$;

-- These flat API results also contain pointer/path, counts, chat metadata or pruned pointers.
-- The physical table row is not their return type. PostgreSQL requires recreating RETURNS TABLE
-- functions when adding a column; keep their existing fields, authorization and explicit grants.

DROP FUNCTION chat.workspace_list_as(text, text, integer, integer, text, text, text, boolean);
CREATE FUNCTION chat.workspace_list_as(p_chat_id text, p_as_user_id text, p_offset integer DEFAULT 0, p_limit integer DEFAULT NULL::integer, p_name text DEFAULT NULL::text, p_kind text DEFAULT NULL::text, p_folder text DEFAULT NULL::text, p_exact boolean DEFAULT false) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, total bigint, parent_id uuid, system_role text, path text, updated_by text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_name TEXT := NULLIF(btrim(COALESCE(p_name, '')), '');
    v_exact BOOLEAN := COALESCE(p_exact, false);
    v_key TEXT := lower(chat.workspace_stored_name(p_name));
    v_offset INTEGER := COALESCE(p_offset, 0);
    v_all BOOLEAN := p_folder IS NULL;
    v_parent UUID;
BEGIN
    IF v_offset < 0 OR p_limit < 0 THEN
        RAISE EXCEPTION 'workspace_list: offset and limit must not be negative';
    END IF;
    IF p_kind IS NOT NULL AND p_kind NOT IN ('document', 'file', 'folder') THEN
        RAISE EXCEPTION 'workspace_list: kind must be document, file or folder, got %', p_kind;
    END IF;
    p_chat_id := chat.workspace_require_room_member(p_chat_id, v_actor);
    IF NOT v_all THEN
        v_parent := chat.workspace_folder_for(p_chat_id, p_folder, v_actor, false);
    END IF;
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT r.id AS item_id, r.filename::TEXT AS item_path, 1 AS depth
          FROM chat.workspace_items r
         WHERE r.chat_id = p_chat_id AND r.parent_id IS NULL
        UNION ALL
        SELECT c.id, t.item_path || '/' || c.filename, t.depth + 1
          FROM chat.workspace_items c
          JOIN tree t ON c.parent_id = t.item_id
         WHERE t.depth < 64
    )
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at,
           count(*) OVER (), w.parent_id, w.system_role, t.item_path, w.updated_by
      FROM chat.workspace_items w
      JOIN tree t ON t.item_id = w.id
     WHERE w.chat_id = p_chat_id
       AND (v_all OR w.parent_id = v_parent OR (v_parent IS NULL AND w.parent_id IS NULL))
       AND (p_kind IS NULL OR w.kind = p_kind)
       AND (v_name IS NULL
            OR (v_exact AND w.name_key = v_key)
            OR (NOT v_exact AND w.filename ILIKE '%' || replace(replace(replace(v_name, '\', '\\'), '%', '\%'), '_', '\_') || '%'))
     ORDER BY w.created_at DESC, w.id DESC
    OFFSET v_offset
     LIMIT p_limit;
END;
$$;
REVOKE ALL ON FUNCTION chat.workspace_list_as(text, text, integer, integer, text, text, text, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_list_as(text, text, integer, integer, text, text, text, boolean) TO authenticated;

DROP FUNCTION chat.workspace_get_as(text, text);
CREATE FUNCTION chat.workspace_get_as(p_item_id text, p_as_user_id text) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, inline_text text, epoch integer, parent_id uuid, system_role text, path text, updated_by text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_item chat.workspace_items%ROWTYPE;
BEGIN
    v_item := chat.workspace_item_for(p_item_id, v_actor);
    RETURN QUERY
    SELECT v_item.id, v_item.chat_id, v_item.kind, v_item.filename, v_item.content_type, v_item.size_bytes, chat.file_blob_pointer(v_item.blob_id),
           v_item.source_message_ids, v_item.created_by, v_item.version, v_item.created_at, v_item.updated_at,
           v_item.inline_text, v_item.epoch, v_item.parent_id, v_item.system_role, chat.workspace_path_of(v_item.id), v_item.updated_by;
END;
$$;
REVOKE ALL ON FUNCTION chat.workspace_get_as(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_get_as(text, text) TO authenticated;

DROP FUNCTION chat.workspace_search(text, text[], integer, text);
CREATE FUNCTION chat.workspace_search(p_query text DEFAULT NULL::text, p_suffixes text[] DEFAULT NULL::text[], p_limit integer DEFAULT 50, p_as_user_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, parent_id uuid, system_role text, path text, epoch integer, chat_name text, chat_kind text, updated_by text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(COALESCE(p_as_user_id, (SELECT auth.uid()::text)));
    v_query TEXT := NULLIF(btrim(COALESCE(p_query, '')), '');
    v_suffixes TEXT[] := (SELECT array_agg(lower(s)) FROM unnest(p_suffixes) s);
BEGIN
    IF p_limit IS NOT NULL AND (p_limit < 1 OR p_limit > 200) THEN
        RAISE EXCEPTION 'workspace_search: limit must be 1 to 200, got %', p_limit;
    END IF;
    RETURN QUERY
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at,
           w.parent_id, w.system_role, p.item_path, w.epoch, c.name, c.kind, w.updated_by
      FROM chat.workspace_placed_for(v_actor) p
      JOIN chat.workspace_items w ON w.id = p.item_id
      JOIN chat.chats c ON c.id = w.chat_id
     WHERE w.kind <> 'folder'
       AND (v_query IS NULL
            OR p.item_path ILIKE '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%')
       AND (v_suffixes IS NULL OR lower(substring(w.filename FROM '\.[^.]+$')) = ANY (v_suffixes))
     ORDER BY w.updated_at DESC, w.id DESC
     LIMIT COALESCE(p_limit, 50);
END;
$_$;
REVOKE ALL ON FUNCTION chat.workspace_search(text, text[], integer, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_search(text, text[], integer, text) TO authenticated;

DROP FUNCTION chat.workspace_recent(integer, text);
CREATE FUNCTION chat.workspace_recent(p_limit integer DEFAULT 50, p_as_user_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, parent_id uuid, system_role text, path text, epoch integer, chat_name text, chat_kind text, opened_at timestamp with time zone, updated_by text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(COALESCE(p_as_user_id, (SELECT auth.uid()::text)));
BEGIN
    IF p_limit IS NOT NULL AND (p_limit < 1 OR p_limit > 200) THEN
        RAISE EXCEPTION 'workspace_recent: limit must be 1 to 200, got %', p_limit;
    END IF;
    RETURN QUERY
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at,
           w.parent_id, w.system_role, p.item_path, w.epoch, c.name, c.kind, o.opened_at, w.updated_by
      FROM chat.workspace_item_opens o
      JOIN chat.workspace_items w ON w.id = o.item_id
      JOIN chat.workspace_placed_for(v_actor) p ON p.item_id = w.id
      JOIN chat.chats c ON c.id = w.chat_id
     WHERE o.user_id = (SELECT auth.uid()::text)
     ORDER BY o.opened_at DESC, w.id DESC
     LIMIT COALESCE(p_limit, 50);
END;
$$;
REVOKE ALL ON FUNCTION chat.workspace_recent(integer, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_recent(integer, text) TO authenticated;

DROP FUNCTION chat.workspace_replace_file_as(text, text, text, bigint, text, integer);
CREATE FUNCTION chat.workspace_replace_file_as(p_item_id text, p_as_user_id text, p_pointer text, p_size_bytes bigint, p_content_type text DEFAULT NULL::text, p_expected_version integer DEFAULT NULL::integer) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, pruned_pointers text[], parent_id uuid, system_role text, path text, updated_by text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_keep CONSTANT INTEGER := 50;
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_item chat.workspace_items%ROWTYPE;
    v_type TEXT;
    v_next INTEGER;
    v_pruned TEXT[];
    v_blob UUID;
BEGIN
    v_item := chat.workspace_item_for(p_item_id, v_actor, true);
    IF v_item.kind <> 'file' THEN
        RAISE EXCEPTION 'workspace_replace_file: % is a live text file; change it through the file service', p_item_id;
    END IF;
    IF p_pointer IS NULL OR chat.workspace_require_room_member(split_part(p_pointer, '/', 1), v_actor) IS DISTINCT FROM v_item.chat_id THEN
        RAISE EXCEPTION 'workspace_replace_file: pointer must live under %/', v_item.chat_id;
    END IF;
    IF p_pointer = chat.file_blob_pointer(v_item.blob_id) THEN
        RAISE EXCEPTION 'workspace_replace_file: that is the content the file already has';
    END IF;
    IF p_size_bytes IS NULL OR p_size_bytes < 0 THEN
        RAISE EXCEPTION 'workspace_replace_file: size_bytes is required';
    END IF;
    IF p_expected_version IS NOT NULL AND p_expected_version <> v_item.version THEN
        RAISE EXCEPTION 'workspace item % version conflict: expected %, got %', p_item_id, p_expected_version, v_item.version
            USING HINT = 'workspace_version_conflict', DETAIL = v_item.version::TEXT;
    END IF;
    v_type := COALESCE(NULLIF(btrim(COALESCE(p_content_type, '')), ''), v_item.content_type);
    v_next := v_item.version + 1;

    INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
    VALUES (v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at)
    ON CONFLICT ON CONSTRAINT workspace_item_versions_pkey DO NOTHING;
    v_blob := chat.file_blob_for_pointer(p_pointer, p_size_bytes, v_type, v_actor);
    INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by)
    VALUES (v_item.id, v_next, v_blob, v_type, p_size_bytes, v_actor);

    UPDATE chat.workspace_items w
       SET blob_id = v_blob, size_bytes = p_size_bytes, content_type = v_type, version = v_next, updated_by = v_actor
     WHERE w.id = v_item.id;

    WITH gone AS (
        DELETE FROM chat.workspace_item_versions v
         WHERE v.item_id = v_item.id
           AND v.n NOT IN (SELECT k.n FROM chat.workspace_item_versions k WHERE k.item_id = v_item.id ORDER BY k.n DESC LIMIT v_keep)
           AND NOT EXISTS (SELECT 1 FROM chat.messages m WHERE m.file_item_id = v.item_id AND m.file_version = v.n)
        RETURNING v.blob_id
    )
    SELECT COALESCE(array_agg(chat.file_blob_pointer(g.blob_id)) FILTER (WHERE chat.file_blob_pointer(g.blob_id) IS NOT NULL), '{}') INTO v_pruned FROM gone g;

    RETURN QUERY
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at, v_pruned,
           w.parent_id, w.system_role, chat.workspace_path_of(w.id), w.updated_by
      FROM chat.workspace_items w
     WHERE w.id = v_item.id;
END;
$$;
REVOKE ALL ON FUNCTION chat.workspace_replace_file_as(text, text, text, bigint, text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_replace_file_as(text, text, text, bigint, text, integer) TO authenticated;

DROP FUNCTION chat.file_replace_as(text, text, text, integer);
CREATE FUNCTION chat.file_replace_as(p_staging_key text, p_item_id text, p_as_user_id text, p_expected_version integer DEFAULT NULL::integer) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, pruned_pointers text[], parent_id uuid, system_role text, path text, updated_by text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_keep CONSTANT INTEGER := 50;
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_item chat.workspace_items%ROWTYPE;
    v_upload chat.file_blob_uploads%ROWTYPE;
    v_blob chat.file_blobs%ROWTYPE;
    v_next INTEGER;
    v_pruned TEXT[] := '{}';
BEGIN
    v_item := chat.workspace_item_for(p_item_id, v_actor, true);
    v_upload := chat.file_upload_take(p_staging_key);
    IF v_upload.item_id IS NOT NULL THEN
        -- 重试:上次已经把这个文件换成了这份字节(换到别的条目上的上传不能再用)。
        IF v_upload.item_id IS DISTINCT FROM v_item.id THEN
            RAISE EXCEPTION USING HINT = 'attachment_upload_used',
                MESSAGE = format('upload %s was already placed elsewhere', p_staging_key);
        END IF;
    ELSE
        IF v_item.kind <> 'file' THEN
            RAISE EXCEPTION USING HINT = 'file_place_invalid',
                MESSAGE = format('file_replace_as: %s is a live text file; change it through the file service', p_item_id);
        END IF;
        IF p_expected_version IS NOT NULL AND p_expected_version <> v_item.version THEN
            RAISE EXCEPTION USING HINT = 'workspace_version_conflict', DETAIL = v_item.version::TEXT,
                MESSAGE = format('workspace item %s version conflict: expected %s, got %s', p_item_id, p_expected_version, v_item.version);
        END IF;
        IF v_upload.blob_id = v_item.blob_id THEN
            RAISE EXCEPTION USING HINT = 'file_place_invalid', MESSAGE = 'file_replace_as: that is the content the file already has';
        END IF;
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = v_upload.blob_id;
        v_next := v_item.version + 1;
        -- 被替换的这一版:第一次换版本时它还不在历史里(建文件时不写历史),补上。
        INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
        VALUES (v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at)
        ON CONFLICT ON CONSTRAINT workspace_item_versions_pkey DO NOTHING;
        INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by)
        VALUES (v_item.id, v_next, v_blob.id, v_blob.content_type, v_blob.size_bytes, v_actor);
        UPDATE chat.workspace_items w
           SET blob_id = v_blob.id, size_bytes = v_blob.size_bytes, content_type = v_blob.content_type, version = v_next, updated_by = v_actor
         WHERE w.id = v_item.id;
        UPDATE chat.file_blob_uploads u SET item_id = v_item.id, item_version = v_next WHERE u.staging_key = p_staging_key;
        WITH gone AS (
            DELETE FROM chat.workspace_item_versions v
             WHERE v.item_id = v_item.id
               AND v.n NOT IN (SELECT k.n FROM chat.workspace_item_versions k WHERE k.item_id = v_item.id ORDER BY k.n DESC LIMIT v_keep)
               -- 聊天记录钉着的那一版不裁:它是「当时发的那一版」,得一直读得到。
               AND NOT EXISTS (SELECT 1 FROM chat.messages m WHERE m.file_item_id = v.item_id AND m.file_version = v.n)
            RETURNING v.blob_id
        )
        SELECT COALESCE(array_agg(chat.file_blob_pointer(g.blob_id)) FILTER (WHERE chat.file_blob_pointer(g.blob_id) IS NOT NULL), '{}') INTO v_pruned FROM gone g;
    END IF;
    RETURN QUERY
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at, v_pruned,
           w.parent_id, w.system_role, chat.workspace_path_of(w.id), w.updated_by
      FROM chat.workspace_items w
     WHERE w.id = v_item.id;
END;
$$;
REVOKE ALL ON FUNCTION chat.file_replace_as(text, text, text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.file_replace_as(text, text, text, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
