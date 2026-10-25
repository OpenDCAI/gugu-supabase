-- File transfer policy is installation data. No paid plan or deployment quota is embedded here.
CREATE TABLE chat.file_transfer_limits (
    scope text NOT NULL CHECK (scope IN ('global','account','group')),
    scope_id text NOT NULL,
    settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, scope_id),
    CHECK ((scope = 'global') = (scope_id = '*'))
);
CREATE TABLE chat.file_transfer_storage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    blob_id uuid REFERENCES chat.file_blobs(id) ON DELETE SET NULL,
    owner_account text,
    bucket_id text NOT NULL,
    object_name text NOT NULL,
    size_bytes bigint CHECK (size_bytes >= 0),
    state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','deleting','gone')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (bucket_id, object_name)
);
CREATE TABLE chat.file_transfer_storage_refs (
    storage_id uuid NOT NULL REFERENCES chat.file_transfer_storage(id) ON DELETE CASCADE,
    chat_id text NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
    account_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (storage_id, chat_id)
);
CREATE TABLE chat.file_transfer_reservations (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('upload','download')),
    account_id text NOT NULL,
    chat_id text,
    subject text NOT NULL,
    bytes bigint NOT NULL CHECK (bytes > 0),
    actual_bytes bigint NOT NULL DEFAULT 0 CHECK (actual_bytes >= 0),
    state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','issued','settled','cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    period date NOT NULL DEFAULT date_trunc('month', now() AT TIME ZONE 'UTC')::date,
    expires_at timestamptz NOT NULL
);
CREATE INDEX file_transfer_reservations_scope ON chat.file_transfer_reservations(kind,period,account_id,chat_id);
CREATE INDEX file_transfer_storage_refs_scope ON chat.file_transfer_storage_refs(account_id,chat_id);
CREATE TABLE chat.file_transfer_observations (
    event_id text PRIMARY KEY,
    reservation_id uuid NOT NULL REFERENCES chat.file_transfer_reservations(id),
    bytes bigint NOT NULL CHECK (bytes >= 0),
    observed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE chat.file_transfer_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.file_transfer_storage ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.file_transfer_storage_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.file_transfer_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.file_transfer_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.file_transfer_limits,chat.file_transfer_storage,chat.file_transfer_storage_refs,
    chat.file_transfer_reservations,chat.file_transfer_observations FROM PUBLIC,anon,authenticated;
GRANT ALL ON chat.file_transfer_limits,chat.file_transfer_storage,chat.file_transfer_storage_refs,
    chat.file_transfer_reservations,chat.file_transfer_observations TO service_role;


CREATE FUNCTION chat.file_transfer_account(p_actor text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT CASE WHEN u.type = 'human' THEN u.id ELSE u.owner_user_id END
      FROM identity.users u WHERE u.id = p_actor
$$;

CREATE FUNCTION chat.file_transfer_group(p_chat text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT COALESCE(c.source_chat_id,c.id) FROM chat.chats c WHERE c.id = p_chat
$$;

CREATE FUNCTION chat.file_transfer_settings(p_scope text DEFAULT 'global',p_id text DEFAULT '*') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb; v_override jsonb;
BEGIN
    SELECT settings INTO v FROM chat.file_transfer_limits WHERE scope = 'global' AND scope_id = '*';
    IF v IS NULL THEN RAISE EXCEPTION 'File transfer is not configured' USING HINT = 'file_transfer_not_configured'; END IF;
    IF p_scope <> 'global' THEN
        SELECT settings INTO v_override FROM chat.file_transfer_limits WHERE scope = p_scope AND scope_id = p_id;
        v := v || COALESCE(v_override,'{}'::jsonb);
    END IF;
    RETURN v;
END $$;

CREATE FUNCTION chat.file_transfer_parameter(p_settings jsonb,p_key text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := p_settings ->> p_key;
BEGIN
    IF v IS NULL OR v !~ '^[0-9]{1,16}$' THEN
        RAISE EXCEPTION 'Missing or invalid file transfer parameter: %',p_key USING HINT = 'file_transfer_not_configured';
    END IF;
    IF v::numeric>9007199254740991 THEN
        RAISE EXCEPTION 'File transfer parameter exceeds the safe integer range: %',p_key USING HINT='file_transfer_not_configured';
    END IF;
    RETURN v::bigint;
END $$;

CREATE FUNCTION chat.file_transfer_usage(p_kind text,p_scope text,p_id text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE held_bytes bigint; used_bytes bigint; month_start date:=date_trunc('month',now() AT TIME ZONE 'UTC')::date;
BEGIN
        SELECT COALESCE(sum(CASE WHEN r.state = 'settled' THEN
                 (SELECT COALESCE(sum(e.bytes),0) FROM chat.file_transfer_observations e
                   WHERE e.reservation_id=r.id AND e.observed_at >= month_start::timestamp AT TIME ZONE 'UTC')
                 ELSE CASE WHEN p_kind='upload' THEN greatest(0,r.bytes-r.actual_bytes)
                    ELSE greatest(r.bytes,r.actual_bytes) END END),0)
          INTO held_bytes FROM chat.file_transfer_reservations r
         WHERE r.kind = p_kind AND r.state <> 'cancelled'
           AND (p_kind = 'upload' AND r.state IN ('reserved','issued')
                OR p_kind = 'download')
           AND (p_scope = 'global' OR p_scope = 'account' AND r.account_id = p_id
                OR p_scope = 'group' AND r.chat_id = p_id);
        used_bytes := 0;
        IF p_kind = 'upload' THEN
            IF p_scope = 'global' THEN
                SELECT COALESCE(sum(o.size_bytes),0) INTO used_bytes FROM chat.file_transfer_storage o WHERE o.state <> 'gone';
            ELSE
                SELECT COALESCE(sum(o.size_bytes),0) INTO used_bytes
                  FROM chat.file_transfer_storage o
                 WHERE o.state <> 'gone' AND (p_scope='account' AND o.owner_account=p_id OR EXISTS (SELECT 1 FROM chat.file_transfer_storage_refs ref
                     WHERE ref.storage_id = o.id AND
                        (p_scope = 'account' AND ref.account_id = p_id
                         OR p_scope = 'group' AND ref.chat_id = p_id)));
            END IF;
        END IF;
    RETURN used_bytes+held_bytes;
END $$;

CREATE FUNCTION chat.file_transfer_reserve(p_id uuid,p_kind text,p_account text,p_chat text,p_bytes bigint,p_subject text)
RETURNS chat.file_transfer_reservations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v chat.file_transfer_reservations%ROWTYPE; s jsonb; scope_name text; scope_id text;
    cap bigint; used_bytes bigint; k text; recent_count bigint;
    group_id text := chat.file_transfer_group(p_chat);
BEGIN
    IF p_kind NOT IN ('upload','download') OR p_bytes IS NULL OR p_bytes <= 0
       OR p_account IS NULL OR p_chat IS NOT NULL AND group_id IS NULL OR length(COALESCE(p_subject,'')) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'Invalid file transfer reservation' USING HINT = 'file_transfer_invalid';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    IF COALESCE((chat.file_transfer_settings()->>'paused')::boolean,false) THEN
        RAISE EXCEPTION 'File transfer signing is paused' USING HINT='file_transfer_paused';
    END IF;
    IF NOT COALESCE((chat.file_transfer_settings()->>'inventory_ready')::boolean,false) THEN
        RAISE EXCEPTION 'Trusted physical-object inventory is required before quota activation' USING HINT='file_transfer_inventory_required';
    END IF;
    SELECT * INTO v FROM chat.file_transfer_reservations WHERE id = p_id;
    IF FOUND THEN
        IF v.kind <> p_kind OR v.account_id <> p_account OR v.chat_id IS DISTINCT FROM group_id
           OR v.bytes <> p_bytes OR v.subject <> p_subject OR v.state = 'cancelled' THEN
            RAISE EXCEPTION 'Reservation identity is immutable' USING HINT = 'file_transfer_conflict';
        END IF;
        RETURN v;
    END IF;
    IF p_kind='download' THEN
        s:=chat.file_transfer_settings();
        SELECT count(*) INTO recent_count FROM chat.file_transfer_reservations
         WHERE kind='download' AND account_id=p_account
           AND created_at>now()-make_interval(secs=>chat.file_transfer_parameter(s,'sign_window_seconds')::integer);
        IF recent_count>=chat.file_transfer_parameter(s,'sign_account_count') THEN
            RAISE EXCEPTION 'Download signing rate exceeded for this account' USING HINT='file_transfer_rate_limited';
        END IF;
        IF group_id IS NOT NULL THEN
            SELECT count(*) INTO recent_count FROM chat.file_transfer_reservations WHERE kind='download' AND chat_id=group_id
              AND created_at>now()-make_interval(secs=>chat.file_transfer_parameter(s,'sign_window_seconds')::integer);
            IF recent_count>=chat.file_transfer_parameter(s,'sign_group_count') THEN
                RAISE EXCEPTION 'Download signing rate exceeded for this group' USING HINT='file_transfer_rate_limited';
            END IF;
        END IF;
    END IF;
    FOREACH scope_name IN ARRAY ARRAY['global','account','group'] LOOP
        IF scope_name='group' AND group_id IS NULL THEN CONTINUE; END IF;
        scope_id := CASE scope_name WHEN 'global' THEN '*' WHEN 'account' THEN p_account ELSE group_id END;
        s := chat.file_transfer_settings(scope_name,scope_id);
        k := CASE p_kind WHEN 'upload' THEN 'storage_' ELSE 'download_' END || scope_name || '_bytes';
        cap := chat.file_transfer_parameter(s,k);
        used_bytes:=chat.file_transfer_usage(p_kind,scope_name,scope_id);
        IF used_bytes + p_bytes > cap THEN
            RAISE EXCEPTION 'File transfer % % quota is exhausted',scope_name,p_kind
                USING HINT = 'file_transfer_' || scope_name || '_' || CASE p_kind WHEN 'upload' THEN 'storage' ELSE 'download' END || '_full';
        END IF;
    END LOOP;
    s := chat.file_transfer_settings();
    INSERT INTO chat.file_transfer_reservations(id,kind,account_id,chat_id,subject,bytes,expires_at)
    VALUES(p_id,p_kind,p_account,group_id,p_subject,p_bytes,
        now()+make_interval(secs=>CASE p_kind WHEN 'download' THEN 60
            ELSE chat.file_transfer_parameter(s,'upload_permit_seconds')::integer END)) RETURNING * INTO v;
    RETURN v;
END $$;

CREATE FUNCTION chat.file_transfer_observe(p_event text,p_reservation uuid,p_bytes bigint,p_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v chat.file_transfer_reservations%ROWTYPE;
BEGIN
    IF p_bytes IS NULL OR p_bytes < 0 OR p_at IS NULL OR p_at > now() OR length(COALESCE(p_event,'')) NOT BETWEEN 1 AND 300 THEN
        RAISE EXCEPTION 'Invalid file transfer observation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    SELECT * INTO v FROM chat.file_transfer_reservations WHERE id = p_reservation AND kind = 'download' FOR UPDATE;
    -- Provider access logs commonly have only whole-second precision.
    IF NOT FOUND OR v.state = 'cancelled' OR p_at < v.created_at-interval '1 second' THEN RAISE EXCEPTION 'Unknown file transfer observation'; END IF;
    INSERT INTO chat.file_transfer_observations(event_id,reservation_id,bytes,observed_at)
    VALUES(p_event,p_reservation,p_bytes,p_at) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN
        IF NOT EXISTS (SELECT 1 FROM chat.file_transfer_observations WHERE event_id=p_event
            AND reservation_id=p_reservation AND bytes=p_bytes AND observed_at=p_at) THEN
            RAISE EXCEPTION 'Observation identity is immutable';
        END IF;
        RETURN false;
    END IF;
    UPDATE chat.file_transfer_reservations SET actual_bytes = actual_bytes + p_bytes WHERE id = p_reservation;
    RETURN true;
END $$;

CREATE FUNCTION chat.file_transfer_settle(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    UPDATE chat.file_transfer_reservations SET state='settled'
     WHERE id=p_id AND kind='download' AND expires_at < now()
       AND state IN ('reserved','issued') AND EXISTS(SELECT 1 FROM chat.file_transfer_observations WHERE reservation_id=p_id);
    IF NOT FOUND THEN RAISE EXCEPTION 'Download cannot be settled without final provider observations'; END IF;
END $$;

CREATE FUNCTION chat.file_transfer_track(p_blob uuid,p_chat text,p_actor text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o uuid; b chat.file_blobs%ROWTYPE; g text := chat.file_transfer_group(p_chat);
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    SELECT * INTO b FROM chat.file_blobs WHERE id=p_blob;
    IF NOT FOUND THEN RAISE EXCEPTION 'File blob is missing'; END IF;
    INSERT INTO chat.file_transfer_storage AS s(blob_id,bucket_id,object_name,size_bytes,owner_account,created_at)
    VALUES(b.id,b.bucket_id,b.object_name,b.size_bytes,chat.file_transfer_account(b.created_by),b.created_at)
    ON CONFLICT(bucket_id,object_name) DO UPDATE SET blob_id=EXCLUDED.blob_id,owner_account=COALESCE(s.owner_account,EXCLUDED.owner_account)
    RETURNING id INTO o;
    IF g IS NOT NULL THEN
    INSERT INTO chat.file_transfer_storage_refs(storage_id,chat_id,account_id,created_at)
    VALUES(o,g,COALESCE(chat.file_transfer_account(p_actor),p_actor,b.created_by,'legacy:unknown'),b.created_at)
    ON CONFLICT DO NOTHING;
    END IF;
    RETURN o;
END $$;

DO $backfill$ DECLARE r record; BEGIN
    FOR r IN SELECT DISTINCT w.blob_id,w.chat_id,w.created_by AS actor FROM chat.workspace_items w WHERE w.blob_id IS NOT NULL
      UNION SELECT DISTINCT v.blob_id,w.chat_id,COALESCE(v.made_by,w.created_by) FROM chat.workspace_item_versions v JOIN chat.workspace_items w ON w.id=v.item_id WHERE v.blob_id IS NOT NULL
      UNION SELECT DISTINCT m.file_blob_id,m.chat_id,m.sender_user_id FROM chat.messages m WHERE m.file_blob_id IS NOT NULL
      UNION SELECT DISTINCT a.blob_id,NULL::text,a.owner_user_id FROM chat.session_attachments a WHERE a.blob_id IS NOT NULL AND a.revoked_at IS NULL
    LOOP PERFORM chat.file_transfer_track(r.blob_id,r.chat_id,r.actor); END LOOP;
END $backfill$;

CREATE TABLE chat.file_transfer_uploads (
    staging_key text PRIMARY KEY,
    reservation_id uuid UNIQUE NOT NULL REFERENCES chat.file_transfer_reservations(id),
    account_id text NOT NULL,
    chat_id text,
    actor_id text NOT NULL,
    max_bytes bigint NOT NULL CHECK(max_bytes>0),
    blob_id uuid REFERENCES chat.file_blobs(id) ON DELETE SET NULL,
    staging_deleted boolean NOT NULL DEFAULT false,
    close_evidence text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE chat.file_transfer_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.file_transfer_uploads FROM PUBLIC,anon,authenticated;
GRANT ALL ON chat.file_transfer_uploads TO service_role;
-- Authorization precedes provider metadata inspection; reservation follows the provider's enforceable bounds.
CREATE FUNCTION chat.file_managed_upload_prepare(p_chat text,p_as text,p_bytes bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); g text; cfg jsonb:=chat.file_transfer_settings();
BEGIN
    IF p_chat IS NOT NULL THEN
        g:=chat.workspace_require_room_member(p_chat,actor);
    END IF;
    IF p_bytes IS NULL OR p_bytes<=0 OR p_bytes>chat.file_transfer_parameter(cfg,'file_max_bytes') THEN
        RAISE EXCEPTION 'File exceeds configured upload size' USING HINT='file_transfer_too_large';
    END IF;
    RETURN jsonb_build_object('actor_id',actor,'chat_id',g,'max_bytes',chat.file_transfer_parameter(cfg,'file_max_bytes'),
        'permit_seconds',chat.file_transfer_parameter(cfg,'upload_permit_seconds'));
END $$;
CREATE FUNCTION chat.file_managed_upload_as(p_id uuid,p_chat text,p_as text,p_bytes bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); u text:=auth.uid()::text; g text; cfg jsonb:=chat.file_transfer_settings();
    prepared jsonb; v chat.file_transfer_reservations%ROWTYPE; key text:='staging/'||u||'/'||p_id::text; prior chat.file_transfer_uploads%ROWTYPE;
BEGIN
    prepared:=chat.file_managed_upload_prepare(p_chat,p_as,p_bytes);
    g:=prepared->>'chat_id';
    -- The current immutable-source promotion briefly holds staging and final bytes.
    v:=chat.file_transfer_reserve(p_id,'upload',u,g,p_bytes*2,key);
    SELECT * INTO prior FROM chat.file_transfer_uploads WHERE staging_key=key;
    IF FOUND AND (prior.actor_id<>actor OR prior.chat_id IS DISTINCT FROM g OR prior.max_bytes<>p_bytes) THEN
        RAISE EXCEPTION 'Upload scope is immutable' USING HINT='file_transfer_conflict';
    END IF;
    IF v.expires_at<=now() OR v.state='settled' THEN RAISE EXCEPTION 'Upload permit expired' USING HINT='file_transfer_expired'; END IF;
    INSERT INTO chat.file_transfer_uploads(staging_key,reservation_id,account_id,chat_id,actor_id,max_bytes)
    VALUES(key,p_id,u,g,actor,p_bytes) ON CONFLICT DO NOTHING;
    UPDATE chat.file_transfer_reservations SET state='issued' WHERE id=p_id;
    RETURN jsonb_build_object('staging_key',key,'max_bytes',p_bytes,'expires_at',v.expires_at,'signed_at',v.created_at);
END $$;
CREATE FUNCTION chat.file_managed_upload_for(p_key text,p_user text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u chat.file_transfer_uploads%ROWTYPE; r chat.file_transfer_reservations%ROWTYPE;
BEGIN
    SELECT * INTO u FROM chat.file_transfer_uploads WHERE staging_key=p_key AND account_id=p_user;
    IF NOT FOUND THEN RAISE EXCEPTION 'Upload has no quota reservation' USING HINT='file_transfer_denied'; END IF;
    SELECT * INTO r FROM chat.file_transfer_reservations WHERE id=u.reservation_id;
    IF u.blob_id IS NULL AND r.expires_at<=now() THEN RAISE EXCEPTION 'Upload permit expired' USING HINT='file_transfer_expired'; END IF;
    RETURN to_jsonb(u)||jsonb_build_object('expires_at',r.expires_at,'state',r.state);
END $$;
CREATE FUNCTION chat.file_managed_upload_scope(p_key text,p_as text,p_chat text DEFAULT NULL,p_item text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); u chat.file_transfer_uploads%ROWTYPE; g text; w chat.workspace_items%ROWTYPE;
BEGIN
    SELECT * INTO u FROM chat.file_transfer_uploads WHERE staging_key=p_key AND account_id=auth.uid()::text;
    IF NOT FOUND OR u.actor_id<>actor THEN RAISE EXCEPTION 'Upload actor is not authorized' USING HINT='file_transfer_denied'; END IF;
    IF p_item IS NOT NULL THEN w:=chat.workspace_item_for(p_item,actor,false); p_chat:=w.chat_id; END IF;
    IF p_chat IS NOT NULL THEN g:=chat.workspace_require_room_member(p_chat,actor); END IF;
    IF u.chat_id IS DISTINCT FROM g THEN RAISE EXCEPTION 'Upload cannot be moved to a different quota scope' USING HINT='file_transfer_denied'; END IF;
END $$;
CREATE FUNCTION chat.file_managed_upload_registered(p_key text,p_user text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u chat.file_transfer_uploads%ROWTYPE; b chat.file_blobs%ROWTYPE; receipt chat.file_blob_uploads%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    SELECT * INTO u FROM chat.file_transfer_uploads WHERE staging_key=p_key AND account_id=p_user FOR UPDATE;
    SELECT * INTO receipt FROM chat.file_blob_uploads WHERE staging_key=p_key AND uploader=p_user;
    SELECT * INTO b FROM chat.file_blobs WHERE id=receipt.blob_id;
    IF u.staging_key IS NULL OR b.id IS NULL OR b.size_bytes>u.max_bytes OR u.blob_id IS NOT NULL AND u.blob_id<>b.id THEN
        RAISE EXCEPTION 'Upload registration is not within its reservation' USING HINT='file_transfer_conflict';
    END IF;
    PERFORM chat.file_transfer_track(b.id,u.chat_id,p_user);
    UPDATE chat.file_transfer_storage SET state='ready'
      WHERE bucket_id=b.bucket_id AND object_name=b.object_name;
    UPDATE chat.file_transfer_uploads SET blob_id=b.id WHERE staging_key=p_key;
    UPDATE chat.file_transfer_reservations SET actual_bytes=b.size_bytes WHERE id=u.reservation_id;
END $$;
CREATE FUNCTION chat.file_managed_upload_closed(p_key text,p_evidence text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    -- Trusted cleanup calls this only with terminal upload evidence and confirmed physical removal.
    -- Expiry plus HEAD 404 alone does not prove that an accepted upload cannot finish late.
    IF length(COALESCE(p_evidence,'')) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Terminal provider evidence is required'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    UPDATE chat.file_transfer_reservations r SET state='settled'
     FROM chat.file_transfer_uploads u WHERE u.staging_key=p_key AND r.id=u.reservation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Upload reservation was not found'; END IF;
    UPDATE chat.file_transfer_uploads SET staging_deleted=true,close_evidence=p_evidence WHERE staging_key=p_key;
END $$;

-- The public upload permit owns the size limit. Internal registration still validates the content and replay identity.
ALTER TABLE chat.file_blobs DROP CONSTRAINT file_blobs_oss_shape;
ALTER TABLE chat.file_blobs ADD CONSTRAINT file_blobs_oss_shape CHECK(bucket_id<>'oss' OR
    (sha256 IS NOT NULL AND size_bytes IS NOT NULL AND object_name=substr(sha256,1,2)||'/'||sha256));
DO $register$
DECLARE definition text;
BEGIN
    SELECT pg_get_functiondef('chat.file_blob_register(text,text,text,bigint,text,integer,integer)'::regprocedure) INTO definition;
    IF position('p_size_bytes < 1 OR p_size_bytes > 26214400' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected file_blob_register definition; refusing a partial upgrade';
    END IF;
    definition:=replace(definition,'p_size_bytes < 1 OR p_size_bytes > 26214400','p_size_bytes < 1');
    definition:=replace(definition,'size must be 1 byte to 25 MiB','size must be at least 1 byte');
    EXECUTE definition;
END $register$;
REVOKE ALL ON FUNCTION chat.file_managed_upload_prepare(text,text,bigint),chat.file_managed_upload_as(uuid,text,text,bigint),chat.file_managed_upload_for(text,text),
    chat.file_managed_upload_registered(text,text),chat.file_managed_upload_closed(text,text),
    chat.file_managed_upload_scope(text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_prepare(text,text,bigint),chat.file_managed_upload_as(uuid,text,text,bigint),chat.file_managed_upload_scope(text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_for(text,text),chat.file_managed_upload_registered(text,text),
    chat.file_managed_upload_closed(text,text) TO service_role;

CREATE FUNCTION chat.file_transfer_track_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF TG_TABLE_NAME='messages' THEN
        IF NEW.file_blob_id IS NOT NULL THEN PERFORM chat.file_transfer_track(NEW.file_blob_id,NEW.chat_id,NEW.sender_user_id); END IF;
    ELSIF TG_TABLE_NAME='workspace_items' THEN
        IF NEW.blob_id IS NOT NULL THEN PERFORM chat.file_transfer_track(NEW.blob_id,NEW.chat_id,NEW.created_by); END IF;
    ELSE
        IF NEW.blob_id IS NOT NULL THEN
            PERFORM chat.file_transfer_track(NEW.blob_id,(SELECT chat_id FROM chat.workspace_items WHERE id=NEW.item_id),NEW.made_by);
        END IF;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER file_transfer_track_item AFTER INSERT OR UPDATE OF blob_id ON chat.workspace_items FOR EACH ROW EXECUTE FUNCTION chat.file_transfer_track_reference();
CREATE TRIGGER file_transfer_track_version AFTER INSERT ON chat.workspace_item_versions FOR EACH ROW EXECUTE FUNCTION chat.file_transfer_track_reference();
CREATE TRIGGER file_transfer_track_message AFTER INSERT OR UPDATE OF file_blob_id ON chat.messages FOR EACH ROW EXECUTE FUNCTION chat.file_transfer_track_reference();

CREATE FUNCTION chat.file_transfer_reference_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o chat.file_transfer_storage%ROWTYPE; covered boolean;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*')
       OR EXISTS(SELECT 1 FROM chat.file_transfer_storage_refs WHERE storage_id=NEW.storage_id AND chat_id=NEW.chat_id) THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    SELECT * INTO o FROM chat.file_transfer_storage WHERE id=NEW.storage_id;
    IF o.size_bytes IS NULL THEN
        RAISE EXCEPTION 'Verified file size is required before reference admission' USING HINT='file_transfer_unavailable';
    END IF;
    SELECT EXISTS(SELECT 1 FROM chat.file_transfer_uploads up
        JOIN chat.file_blob_uploads receipt ON receipt.staging_key=up.staging_key
        JOIN chat.file_transfer_reservations reservation ON reservation.id=up.reservation_id
        WHERE receipt.blob_id=o.blob_id AND up.blob_id IS NULL AND up.chat_id=NEW.chat_id
          AND up.account_id=NEW.account_id AND reservation.state='issued')
 INTO covered;
    IF NOT covered THEN
        IF chat.file_transfer_usage('upload','group',NEW.chat_id)+o.size_bytes>
            chat.file_transfer_parameter(chat.file_transfer_settings('group',NEW.chat_id),'storage_group_bytes') THEN
            RAISE EXCEPTION 'Group storage quota is exhausted' USING HINT='file_transfer_group_storage_full';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM chat.file_transfer_storage stored WHERE stored.id=o.id AND
             (stored.owner_account=NEW.account_id OR EXISTS(SELECT 1 FROM chat.file_transfer_storage_refs ref
                WHERE ref.storage_id=o.id AND ref.account_id=NEW.account_id)))
           AND chat.file_transfer_usage('upload','account',NEW.account_id)+o.size_bytes>
             chat.file_transfer_parameter(chat.file_transfer_settings('account',NEW.account_id),'storage_account_bytes') THEN
            RAISE EXCEPTION 'Account storage quota is exhausted' USING HINT='file_transfer_account_storage_full';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER file_transfer_reference_guard BEFORE INSERT ON chat.file_transfer_storage_refs
FOR EACH ROW EXECUTE FUNCTION chat.file_transfer_reference_guard();
-- Private historical workspace bytes are available only through the managed resolver and signing service.
-- Other buckets (including avatars and social media) retain their existing unrelated policies.
CREATE POLICY workspace_managed_files ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
USING (bucket_id<>'workspace') WITH CHECK (bucket_id<>'workspace');

CREATE FUNCTION chat.file_transfer_object_gone(p_bucket text,p_name text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    UPDATE chat.file_transfer_storage SET state='gone' WHERE bucket_id=p_bucket AND object_name=p_name
$$;
REVOKE ALL ON FUNCTION chat.file_transfer_account(text),chat.file_transfer_group(text),chat.file_transfer_settings(text,text),chat.file_transfer_parameter(jsonb,text),chat.file_transfer_usage(text,text,text),chat.file_transfer_reserve(uuid,text,text,text,bigint,text),chat.file_transfer_observe(text,uuid,bigint,timestamptz),chat.file_transfer_settle(uuid),chat.file_transfer_track(uuid,text,text),chat.file_transfer_track_reference(),chat.file_transfer_reference_guard(),chat.file_transfer_object_gone(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_transfer_settings(text,text),chat.file_transfer_usage(text,text,text),chat.file_transfer_reserve(uuid,text,text,text,bigint,text),chat.file_transfer_observe(text,uuid,bigint,timestamptz),chat.file_transfer_settle(uuid),chat.file_transfer_track(uuid,text,text),chat.file_transfer_object_gone(text,text) TO service_role;

-- Reuse existing exact-reference ACLs. The only new step before signing is a budget reservation.
CREATE FUNCTION chat.file_transfer_download_as(p_ref jsonb,p_as text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); c record; r jsonb; b uuid; o chat.file_transfer_storage%ROWTYPE;
    v chat.file_transfer_reservations%ROWTYPE; g text; item uuid; pinned integer; message text:=p_ref->>'message_id';
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    IF message IS NOT NULL THEN
        IF NOT chat.can_read_message(message,actor) THEN RETURN jsonb_build_object('status','gone'); END IF;
        SELECT file_item_id,file_version INTO item,pinned FROM chat.messages WHERE id=message AND retracted_at IS NULL;
        IF item IS NOT NULL THEN
            IF pinned IS NULL THEN RAISE EXCEPTION 'Pinned file version is unavailable' USING HINT='file_transfer_unavailable'; END IF;
            p_ref:=jsonb_build_object('item_id',item,'version',pinned);
        END IF;
    END IF;
    IF p_ref ? 'attachment_id' THEN
        SELECT * INTO c FROM chat.session_attachment_urls_as(ARRAY[(p_ref->>'attachment_id')::uuid],actor) LIMIT 1;
    ELSE
        SELECT * INTO c FROM chat.file_urls_as(jsonb_build_array(p_ref),actor) LIMIT 1;
    END IF;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','gone'); END IF;
    r:=to_jsonb(c); g:=chat.file_transfer_group(r->>'chat_id');
    SELECT * INTO o FROM chat.file_transfer_storage WHERE bucket_id=c.bucket_id AND object_name=c.object_name;
    IF NOT FOUND THEN
        SELECT id INTO b FROM chat.file_blobs WHERE bucket_id=c.bucket_id AND object_name=c.object_name;
        IF b IS NOT NULL THEN PERFORM chat.file_transfer_track(b,g,actor);
        ELSE
            IF r->>'size_bytes' IS NULL THEN RAISE EXCEPTION 'Historical file length must be verified before signing' USING HINT='file_transfer_unavailable'; END IF;
            INSERT INTO chat.file_transfer_storage(bucket_id,object_name,size_bytes,owner_account)
            VALUES(c.bucket_id,c.object_name,(r->>'size_bytes')::bigint,chat.file_transfer_account(actor));
        END IF;
        SELECT * INTO o FROM chat.file_transfer_storage WHERE bucket_id=c.bucket_id AND object_name=c.object_name;
    END IF;
    IF o.state<>'ready' OR o.size_bytes IS NULL THEN RAISE EXCEPTION 'Verified file size is unavailable' USING HINT='file_transfer_unavailable'; END IF;
    IF g IS NOT NULL THEN
        INSERT INTO chat.file_transfer_storage_refs(storage_id,chat_id,account_id)
        VALUES(o.id,g,chat.file_transfer_account(actor)) ON CONFLICT DO NOTHING;
    END IF;
    v:=chat.file_transfer_reserve(p_id,'download',auth.uid()::text,g,greatest(1,o.size_bytes),'object:'||o.id::text);
    IF v.expires_at<=now() OR v.state='settled' THEN
        RAISE EXCEPTION 'Download authorization expired; use a new request identifier' USING HINT='file_transfer_expired';
    END IF;
    UPDATE chat.file_transfer_reservations SET state='issued' WHERE id=v.id;
    RETURN r||jsonb_build_object('status','ready','message_id',COALESCE(r->>'message_id',message),'size_bytes',o.size_bytes,'storage_id',o.id,'download_id',v.id,'signed_at',v.created_at,'expires_at',v.expires_at);
END $$;
REVOKE ALL ON FUNCTION chat.file_transfer_download_as(jsonb,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_transfer_download_as(jsonb,text,uuid) TO authenticated;

-- Service ingestion is atomic and does not settle a bearer capability or trust client ACKs.
CREATE FUNCTION chat.file_transfer_import(p_events jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e jsonb; changed integer:=0; duplicate integer:=0; expected text;
BEGIN
    IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 512 THEN
        RAISE EXCEPTION 'Invalid provider event batch';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    FOR e IN SELECT value FROM jsonb_array_elements(p_events) LOOP
        SELECT o.object_name INTO expected FROM chat.file_transfer_reservations r
          JOIN chat.file_transfer_storage o ON r.subject='object:'||o.id::text
         WHERE r.id=(e->>'download_id')::uuid AND r.kind='download';
        IF expected IS NULL OR expected IS DISTINCT FROM e->>'object_name' THEN
            RAISE EXCEPTION 'Provider event has no matching download object' USING HINT='file_transfer_unknown_observation';
        END IF;
        IF chat.file_transfer_observe(e->>'event_id',(e->>'download_id')::uuid,(e->>'bytes')::bigint,(e->>'observed_at')::timestamptz)
            THEN changed:=changed+1; ELSE duplicate:=duplicate+1; END IF;
    END LOOP;
    RETURN jsonb_build_object('imported',changed,'duplicates',duplicate);
END $$;
REVOKE ALL ON FUNCTION chat.file_transfer_import(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_transfer_import(jsonb) TO service_role;

-- Trusted provider inventory, including orphan physical objects; never take sizes from a reader.
-- Activation is a separate deployment configuration change after the full inventory is reconciled.
CREATE FUNCTION chat.file_transfer_inventory(p_objects jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e jsonb; b chat.file_blobs%ROWTYPE; n integer:=0;
BEGIN
    IF jsonb_typeof(p_objects) IS DISTINCT FROM 'array' OR jsonb_array_length(p_objects) NOT BETWEEN 1 AND 512 THEN
        RAISE EXCEPTION 'Invalid inventory batch';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    FOR e IN SELECT value FROM jsonb_array_elements(p_objects) LOOP
        IF length(COALESCE(e->>'bucket_id','')) NOT BETWEEN 1 AND 100 OR length(COALESCE(e->>'object_name','')) NOT BETWEEN 1 AND 1024
           OR (e->>'size_bytes') IS NULL OR (e->>'size_bytes')::bigint<0 THEN RAISE EXCEPTION 'Invalid physical object'; END IF;
        SELECT * INTO b FROM chat.file_blobs WHERE bucket_id=e->>'bucket_id' AND object_name=e->>'object_name';
        INSERT INTO chat.file_transfer_storage AS o(blob_id,bucket_id,object_name,size_bytes,owner_account)
        VALUES(b.id,e->>'bucket_id',e->>'object_name',(e->>'size_bytes')::bigint,chat.file_transfer_account(b.created_by))
        ON CONFLICT(bucket_id,object_name) DO UPDATE SET size_bytes=EXCLUDED.size_bytes WHERE o.state='ready';
        n:=n+1;
    END LOOP;
    RETURN n;
END $$;
REVOKE ALL ON FUNCTION chat.file_transfer_inventory(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_transfer_inventory(jsonb) TO service_role;
