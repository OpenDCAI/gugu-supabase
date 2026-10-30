-- A gone object may also be the expected result of the existing idle-expiry GC.
-- Preserve that reference's expired status and its normal fresh-upload recovery path.
DO $missing_expiry$
DECLARE definition text; predecessor text:=$old$IF EXISTS(SELECT 1 FROM chat.file_transfer_storage o
        WHERE o.bucket_id=c.bucket_id AND o.object_name=c.object_name AND o.state='gone') THEN$old$;
BEGIN
    SELECT pg_get_functiondef('chat.file_resolve_as(jsonb,text)'::regprocedure) INTO definition;
    IF position(predecessor IN definition)=0 THEN RAISE EXCEPTION 'Missing object status predecessor'; END IF;
    definition:=replace(definition,predecessor,$new$IF EXISTS(SELECT 1 FROM chat.file_transfer_storage o
        WHERE o.bucket_id=c.bucket_id AND o.object_name=c.object_name AND o.state='gone')
        AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_storage o
            JOIN chat.file_transfer_storage_refs r ON r.storage_id=o.id
            WHERE o.bucket_id=c.bucket_id AND o.object_name=c.object_name
              AND r.chat_id=chat.file_transfer_group(to_jsonb(c)->>'chat_id') AND r.expired_at IS NOT NULL) THEN$new$);
    EXECUTE definition;
END $missing_expiry$;
REVOKE ALL ON FUNCTION chat.file_resolve_as(jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_resolve_as(jsonb,text) TO authenticated;
