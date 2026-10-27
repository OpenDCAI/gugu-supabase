-- Explicit App data ownership is presentation metadata; access remains membership-based.

DROP FUNCTION chat.workspace_get_as(text, text);
CREATE FUNCTION chat.workspace_get_as(p_item_id text, p_as_user_id text) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, inline_text text, epoch integer, parent_id uuid, system_role text, path text, updated_by text, metadata jsonb)
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
           v_item.inline_text, v_item.epoch, v_item.parent_id, v_item.system_role, chat.workspace_path_of(v_item.id), v_item.updated_by, v_item.metadata;
END;
$$;
REVOKE ALL ON FUNCTION chat.workspace_get_as(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_get_as(text, text) TO authenticated;

DROP FUNCTION chat.workspace_list_as(text, text, integer, integer, text, text, text, boolean);
CREATE FUNCTION chat.workspace_list_as(p_chat_id text, p_as_user_id text, p_offset integer DEFAULT 0, p_limit integer DEFAULT NULL::integer, p_name text DEFAULT NULL::text, p_kind text DEFAULT NULL::text, p_folder text DEFAULT NULL::text, p_exact boolean DEFAULT false) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, total bigint, parent_id uuid, system_role text, path text, updated_by text, metadata jsonb)
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
           count(*) OVER (), w.parent_id, w.system_role, t.item_path, w.updated_by, w.metadata
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

DROP FUNCTION chat.workspace_search(text, text[], integer, text);
CREATE FUNCTION chat.workspace_search(p_query text DEFAULT NULL::text, p_suffixes text[] DEFAULT NULL::text[], p_limit integer DEFAULT 50, p_as_user_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, parent_id uuid, system_role text, path text, epoch integer, chat_name text, chat_kind text, updated_by text, metadata jsonb)
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
           w.parent_id, w.system_role, p.item_path, w.epoch, c.name, c.kind, w.updated_by, w.metadata
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
CREATE FUNCTION chat.workspace_recent(p_limit integer DEFAULT 50, p_as_user_id text DEFAULT NULL::text) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, parent_id uuid, system_role text, path text, epoch integer, chat_name text, chat_kind text, opened_at timestamp with time zone, updated_by text, metadata jsonb)
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
           w.parent_id, w.system_role, p.item_path, w.epoch, c.name, c.kind, o.opened_at, w.updated_by, w.metadata
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

-- A feature-specific door authorizes the actor before invoking the closed namespace helper.
CREATE FUNCTION chat.workspace_mark_app_data_as(p_item_id text, p_as_user_id text, p_app jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE
    v_actor text := chat.workspace_actor_for(p_as_user_id);
    v_item chat.workspace_items%ROWTYPE;
BEGIN
    IF jsonb_typeof(p_app) IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_app->'publisher') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_app->'id') IS DISTINCT FROM 'string'
       OR btrim(p_app->>'publisher') = '' OR btrim(p_app->>'id') = ''
       OR (p_app - 'publisher' - 'id') <> '{}'::jsonb THEN
        RAISE EXCEPTION 'App data needs an App identity {publisher, id}';
    END IF;
    v_item := chat.workspace_item_for(p_item_id, v_actor, true);
    IF v_item.kind = 'folder' THEN RAISE EXCEPTION 'A folder cannot be App data'; END IF;
    IF v_item.metadata ? 'app' THEN
        IF v_item.metadata->'app' IS DISTINCT FROM p_app THEN
            RAISE EXCEPTION 'This file is already data of another App' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN v_item.metadata;
    END IF;
    RETURN chat.workspace_set_metadata(v_item.id, 'app', p_app);
END;
$$;
REVOKE ALL ON FUNCTION chat.workspace_mark_app_data_as(text,text,jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_mark_app_data_as(text,text,jsonb) TO authenticated;

-- The new entry and its marker commit together. Existing creation and naming rules stay single-source.
CREATE FUNCTION chat.workspace_create_app_document_as(
    p_chat_id text, p_as_user_id text, p_title text, p_app jsonb,
    p_content text DEFAULT '', p_content_type text DEFAULT NULL,
    p_source_message_ids text[] DEFAULT NULL, p_folder text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE
    v_created record;
    v_metadata jsonb;
BEGIN
    SELECT * INTO v_created FROM chat.workspace_create_document_as(
        p_chat_id,p_as_user_id,p_title,p_content,p_content_type,p_source_message_ids,p_folder);
    v_metadata := chat.workspace_mark_app_data_as(v_created.id::text,p_as_user_id,p_app);
    RETURN to_jsonb(v_created) || jsonb_build_object('metadata',v_metadata);
END;
$$;
REVOKE ALL ON FUNCTION chat.workspace_create_app_document_as(text,text,text,jsonb,text,text,text[],text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_create_app_document_as(text,text,text,jsonb,text,text,text[],text) TO authenticated;

NOTIFY pgrst, 'reload schema';
