-- Project chats keep files on the bound machine, but an image attachment is sent the way an ordinary chat sends it:
-- uploaded when sent, from any member's device. The declared type only admits the upload early; registration
-- checks the stored blob, whose image type comes from the byte sniff (a declared image/* is never trusted there).

DO $image$ DECLARE definition text; BEGIN
    SELECT pg_get_functiondef('chat.file_managed_upload_prepare(text,text,bigint)'::regprocedure) INTO definition;
    IF position('p_bytes bigint)' IN definition)=0
       OR position('AND NOT COALESCE((SELECT proactive_upload FROM chat.file_project_policies WHERE chat_id=g),false) THEN' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected managed upload policy predecessor';
    END IF;
    definition:=replace(definition,'p_bytes bigint)','p_bytes bigint, p_content_type text DEFAULT NULL)');
    definition:=replace(definition,
        'AND NOT COALESCE((SELECT proactive_upload FROM chat.file_project_policies WHERE chat_id=g),false) THEN',
        'AND NOT COALESCE((SELECT proactive_upload FROM chat.file_project_policies WHERE chat_id=g),false)
       AND NOT COALESCE(lower(p_content_type) LIKE ''image/%'',false) THEN');
    DROP FUNCTION chat.file_managed_upload_prepare(text,text,bigint);
    EXECUTE definition;
END $image$;
REVOKE ALL ON FUNCTION chat.file_managed_upload_prepare(text,text,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_prepare(text,text,bigint,text) TO authenticated;

-- The reservation re-runs the same admission, so it carries the same declared type.
DO $reserve$ DECLARE definition text; BEGIN
    SELECT pg_get_functiondef('chat.file_managed_upload_as(uuid,text,text,bigint)'::regprocedure) INTO definition;
    IF position('p_bytes bigint)' IN definition)=0
       OR position('chat.file_managed_upload_prepare(p_chat,p_as,p_bytes)' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected managed upload reservation predecessor';
    END IF;
    definition:=replace(definition,'p_bytes bigint)','p_bytes bigint, p_content_type text DEFAULT NULL)');
    definition:=replace(definition,'chat.file_managed_upload_prepare(p_chat,p_as,p_bytes)','chat.file_managed_upload_prepare(p_chat,p_as,p_bytes,p_content_type)');
    DROP FUNCTION chat.file_managed_upload_as(uuid,text,text,bigint);
    EXECUTE definition;
END $reserve$;
REVOKE ALL ON FUNCTION chat.file_managed_upload_as(uuid,text,text,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_as(uuid,text,text,bigint,text) TO authenticated;

DO $registered$ DECLARE definition text; BEGIN
    SELECT pg_get_functiondef('chat.file_managed_upload_registered(text,text,jsonb)'::regprocedure) INTO definition;
    IF position('    PERFORM chat.file_transfer_track(b.id,u.chat_id,p_user);' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected upload registration predecessor';
    END IF;
    definition:=replace(definition,'    PERFORM chat.file_transfer_track(b.id,u.chat_id,p_user);',
'    IF EXISTS(SELECT 1 FROM identity.device_projects WHERE chat_id=u.chat_id)
       AND NOT COALESCE((SELECT proactive_upload FROM chat.file_project_policies WHERE chat_id=u.chat_id),false)
       AND b.content_type NOT LIKE ''image/%'' THEN
        RAISE EXCEPTION ''Project files are not uploaded proactively'' USING HINT=''file_transfer_denied'';
    END IF;
    PERFORM chat.file_transfer_track(b.id,u.chat_id,p_user);');
    EXECUTE definition;
END $registered$;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_registered(text,text,jsonb) TO service_role;

NOTIFY pgrst,'reload schema';
