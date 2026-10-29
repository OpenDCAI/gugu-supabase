-- #791 follow-up. A handed-over copy's upload reservation stayed 'issued' after its commit, so the part of the reservation
-- above the actual ciphertext (the provider ceiling, on the Supabase Storage backend) kept counting against the group's
-- temporary quota until the permit expired: a few handoffs in two hours filled it. Settle the reservation at commit, as a
-- registered managed upload does (file_managed_upload_registered); the stored bytes are counted from then on.
DO $settle$ DECLARE definition text; BEGIN
    SELECT pg_get_functiondef('chat.file_version_handoff_commit(uuid,text,text,bigint,text)'::regprocedure) INTO definition;
    IF position('UPDATE chat.file_transfer_reservations SET actual_bytes=p_size WHERE id=h.id;' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected file_version_handoff_commit predecessor';
    END IF;
    definition:=replace(definition,'UPDATE chat.file_transfer_reservations SET actual_bytes=p_size WHERE id=h.id;',
        'UPDATE chat.file_transfer_reservations SET actual_bytes=p_size,state=''settled'' WHERE id=h.id;');
    EXECUTE definition;
END $settle$;
REVOKE ALL ON FUNCTION chat.file_version_handoff_commit(uuid,text,text,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_version_handoff_commit(uuid,text,text,bigint,text) TO service_role;
