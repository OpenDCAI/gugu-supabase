-- The folder list carries what the group files redesign shows per file (design §10), four columns appended after
-- expires_at / is_mine; the existing ones and their order are unchanged.
--   storage_class   'image' | 'temporary' | 'kept' for a live cloud copy, as file_storage_overview_as classes it;
--                   NULL when there is none (a file kept on its machine, a folder, a copy already reclaimed).
--   copy_expired_at when the group's copy was reclaimed and no live copy has replaced it.
--   copy_account_id the account that uploaded that copy (live, or the reclaimed one).
--   host_device_id  the machine holding the current version in a project group (file_device_revisions).
DO $list$ DECLARE definition text; BEGIN
    SELECT pg_get_functiondef('chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean)'::regprocedure) INTO definition;
    IF position('expires_at timestamp with time zone, is_mine boolean)' IN definition)=0
       OR position('copy.expires_at, copy.account_id = chat.file_transfer_account(v_actor)' IN definition)=0
       OR position('r.expired_at IS NULL) copy ON true' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected workspace list predecessor';
    END IF;
    definition:=replace(definition,'expires_at timestamp with time zone, is_mine boolean)',
        'expires_at timestamp with time zone, is_mine boolean, storage_class text, copy_expired_at timestamp with time zone, copy_account_id text, host_device_id text)');
    definition:=replace(definition,'copy.expires_at, copy.account_id = chat.file_transfer_account(v_actor)',
        $sel$copy.expires_at, copy.account_id = chat.file_transfer_account(v_actor),
           CASE WHEN ref.found AND ref.expired_at IS NULL THEN CASE WHEN ref.content_type LIKE 'image/%' THEN 'image'
               WHEN ref.expires_at IS NOT NULL THEN 'temporary' ELSE 'kept' END END,
           ref.expired_at, ref.account_id, dev.host_device_id$sel$);
    definition:=replace(definition,'r.expired_at IS NULL) copy ON true',
        $join$r.expired_at IS NULL) copy ON true
      -- The live copy if there is one, else the latest reclaimed one.
      LEFT JOIN LATERAL (SELECT true AS found, r.expires_at, r.expired_at, r.account_id, b.content_type FROM chat.file_transfer_storage o
          JOIN chat.file_transfer_storage_refs r ON r.storage_id = o.id JOIN chat.file_blobs b ON b.id = o.blob_id
         WHERE o.blob_id = w.blob_id AND r.chat_id = chat.file_transfer_group(w.chat_id)
         ORDER BY r.expired_at IS NOT NULL, r.expired_at DESC LIMIT 1) ref ON true
      LEFT JOIN LATERAL (SELECT d.host_device_id FROM chat.file_device_revisions d
         WHERE d.item_id = w.id AND d.version = w.version LIMIT 1) dev ON true$join$);
    DROP FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean);
    EXECUTE definition;
END $list$;
REVOKE ALL ON FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) TO authenticated;

NOTIFY pgrst,'reload schema';
