-- Keep the original ledgers as the only source of quota usage. The global hard
-- download budget needs one shared admission fence, but storage maintenance and
-- reference resolution must not hold that fence or serialize unrelated downloads.
CREATE INDEX file_transfer_observations_reservation ON chat.file_transfer_observations(reservation_id,observed_at);
CREATE INDEX file_transfer_download_account_signs ON chat.file_transfer_reservations(account_id,created_at) WHERE kind='download';
CREATE INDEX file_transfer_download_group_signs ON chat.file_transfer_reservations(chat_id,created_at) WHERE kind='download';

DO $download$
DECLARE definition text; signature text;
    quota_lock text:='PERFORM pg_advisory_xact_lock(hashtextextended(''gugu:file-transfer:quota'',0));';
    admission_lock text:='PERFORM 1 FROM chat.file_transfer_limits WHERE scope=''global'' AND scope_id=''*'' FOR UPDATE;';
BEGIN
    SELECT pg_get_functiondef('chat.file_transfer_reserve(uuid,text,text,text,bigint,text)'::regprocedure) INTO definition;
    IF position(quota_lock IN definition)=0 OR position('IF p_kind=''download'' THEN' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected reserve predecessor';
    END IF;
    definition:=replace(definition,quota_lock,'IF p_kind=''upload'' THEN '||quota_lock||
        ' ELSE PERFORM pg_advisory_xact_lock(hashtextextended(''gugu:file-download:''||p_id::text,0)); END IF;');
    -- Existing identical retries return before this fence. Only rate/byte checks
    -- and the reservation insert run under it; all three quota scopes stay atomic.
    EXECUTE replace(definition,'IF p_kind=''download'' THEN','IF p_kind=''download'' THEN '||admission_lock);

    FOREACH signature IN ARRAY ARRAY['chat.file_transfer_observe(text,uuid,bigint,timestamptz)','chat.file_transfer_settle(uuid)'] LOOP
        SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
        IF position(quota_lock IN definition)=0 THEN RAISE EXCEPTION 'Unexpected reconciliation predecessor: %',signature; END IF;
        EXECUTE replace(definition,quota_lock,admission_lock);
    END LOOP;
    SELECT pg_get_functiondef('chat.file_transfer_import(jsonb)'::regprocedure) INTO definition;
    IF position(quota_lock IN definition)=0 THEN RAISE EXCEPTION 'Unexpected import predecessor'; END IF;
    -- Each observation enters the same admission fence before changing the ledger.
    EXECUTE replace(definition,quota_lock,'');

    SELECT pg_get_functiondef('chat.file_transfer_download_as(jsonb,text,uuid)'::regprocedure) INTO definition;
    IF position(quota_lock IN definition)=0 OR position('ORDER BY created_at DESC LIMIT 1;' IN definition)=0
       OR position('IF EXISTS(SELECT 1 FROM chat.file_transfer_storage_refs WHERE storage_id=o.id AND chat_id=g AND expired_at IS NOT NULL) THEN' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected download predecessor';
    END IF;
    definition:=replace(definition,quota_lock,'PERFORM pg_advisory_xact_lock(hashtextextended(''gugu:file-download:''||p_id::text,0));');
    definition:=replace(definition,'ORDER BY created_at DESC LIMIT 1;','ORDER BY created_at DESC LIMIT 1 FOR UPDATE;');
    definition:=replace(definition,'IF EXISTS(SELECT 1 FROM chat.file_transfer_storage_refs WHERE storage_id=o.id AND chat_id=g AND expired_at IS NOT NULL) THEN',
        $body$-- Reuse the existing per-blob GC fence; retention locks only this reference.
    IF o.blob_id IS NOT NULL THEN PERFORM chat.file_blob_take(o.blob_id); END IF;
    SELECT * INTO o FROM chat.file_transfer_storage WHERE id=o.id FOR SHARE;
    PERFORM 1 FROM chat.file_transfer_storage_refs WHERE storage_id=o.id AND chat_id=g FOR UPDATE;
    IF EXISTS(SELECT 1 FROM chat.file_transfer_storage_refs WHERE storage_id=o.id AND chat_id=g AND expired_at IS NOT NULL) THEN$body$);
    EXECUTE definition;
END $download$;
-- The installation DDL guard closes replaced functions; restore their existing grants.
GRANT EXECUTE ON FUNCTION chat.file_transfer_reserve(uuid,text,text,text,bigint,text),
    chat.file_transfer_observe(text,uuid,bigint,timestamptz),chat.file_transfer_settle(uuid),
    chat.file_transfer_import(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION chat.file_transfer_download_as(jsonb,text,uuid) TO authenticated;
