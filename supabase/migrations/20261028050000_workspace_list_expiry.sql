-- The folder lists, per file, when its cloud copy expires and whether the reader uploaded it: what 「临时 · 还剩 N 天」
-- and the 「设为临时 / 一直保留」 menu need. Two columns appended; the existing ones and their order are unchanged.
-- is_mine follows file_storage_mark_as: the copy's uploader account (a person, or their agent's owner) is the reader's —
-- the account of whoever acts, so an agent reading sees its owner's uploads as its own. A file with no cloud copy (a
-- project file kept on its machine, a live document) has neither: both NULL.
DO $list$ DECLARE definition text; BEGIN
    SELECT pg_get_functiondef('chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean)'::regprocedure) INTO definition;
    IF position('path text, updated_by text, metadata jsonb)' IN definition)=0
       OR position('t.item_path, w.updated_by, w.metadata' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected workspace list predecessor';
    END IF;
    definition:=replace(definition,'path text, updated_by text, metadata jsonb)',
        'path text, updated_by text, metadata jsonb, expires_at timestamp with time zone, is_mine boolean)');
    definition:=replace(definition,'t.item_path, w.updated_by, w.metadata',
        $sel$t.item_path, w.updated_by, w.metadata, copy.expires_at, copy.account_id = chat.file_transfer_account(v_actor)$sel$);
    definition:=replace(definition,'      JOIN tree t ON t.item_id = w.id',
        $join$      JOIN tree t ON t.item_id = w.id
      LEFT JOIN LATERAL (SELECT r.expires_at, r.account_id FROM chat.file_transfer_storage o
          JOIN chat.file_transfer_storage_refs r ON r.storage_id = o.id
         WHERE o.blob_id = w.blob_id AND r.chat_id = chat.file_transfer_group(w.chat_id) AND r.expired_at IS NULL) copy ON true$join$);
    DROP FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean);
    EXECUTE definition;
END $list$;
REVOKE ALL ON FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) TO authenticated;

NOTIFY pgrst,'reload schema';
