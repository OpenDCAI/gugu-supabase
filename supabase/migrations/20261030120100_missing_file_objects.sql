-- Physical absence is an operator-verified inventory fact, never an HTTP failure guess.
-- Keep the exact-reference ACL and the existing download transaction/reservation path.
DO $missing$
DECLARE definition text; fence text:='RETURN to_jsonb(c)||jsonb_build_object(''source'',''managed-object''';
BEGIN
    SELECT pg_get_functiondef('chat.file_resolve_as(jsonb,text)'::regprocedure) INTO definition;
    IF position(fence IN definition)=0 THEN RAISE EXCEPTION 'Missing managed file metadata predecessor'; END IF;
    definition:=replace(definition,fence,$body$
    IF EXISTS(SELECT 1 FROM chat.file_transfer_storage o
        WHERE o.bucket_id=c.bucket_id AND o.object_name=c.object_name AND o.state='gone') THEN
        RETURN jsonb_build_object('status','missing','code','object_not_found','sha256',c.sha256);
    END IF;
    $body$||fence);
    EXECUTE definition;
    -- file_transfer_download_as already returns any non-ready file_resolve_as result before
    -- reserving quota. Refuse an incompatible predecessor instead of restoring an old signer.
    SELECT pg_get_functiondef('chat.file_transfer_download_as(jsonb,text,uuid)'::regprocedure) INTO definition;
    IF position('r:=chat.file_resolve_as(p_ref,actor);' IN definition)=0 OR
       position('IF r->>''status''<>''ready'' THEN RETURN r; END IF;' IN definition)=0 THEN
        RAISE EXCEPTION 'Missing download metadata status guard';
    END IF;
END $missing$;
-- The installation event trigger closes replaced functions as well as new functions.
REVOKE ALL ON FUNCTION chat.file_resolve_as(jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_resolve_as(jsonb,text) TO authenticated;
