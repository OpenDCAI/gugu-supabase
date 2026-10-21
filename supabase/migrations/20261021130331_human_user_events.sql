-- Account revisions and the private user-events bus belong to signed-in human
-- clients. Agents read through owner-authenticated *_as RPCs and are woken by
-- device commands, not by their own user-events topic.
CREATE FUNCTION chat.is_user_event_recipient(p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT EXISTS (
        SELECT 1 FROM identity.users u
        WHERE u.id = p_user_id AND u.type = 'human'
    );
$$;
REVOKE ALL ON FUNCTION chat.is_user_event_recipient(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.is_user_event_recipient(TEXT) TO service_role;

-- Same argument shape as realtime.send so existing producers retain their
-- event, payload and private topic exactly. This helper only owns user-events;
-- device commands/RPC and other topic families keep their existing transports.
CREATE FUNCTION chat.send_user_event(p_payload JSONB, p_event TEXT, p_topic TEXT, p_private BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_topic IS NULL OR p_topic !~ '^gugu:user:[^:]+:events$'
       OR p_private IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'user events require a private gugu:user:<id>:events topic';
    END IF;
    IF chat.is_user_event_recipient(split_part(p_topic, ':', 3)) THEN
        PERFORM realtime.send(p_payload, p_event, p_topic, p_private);
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION chat.send_user_event(JSONB, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.send_user_event(JSONB, TEXT, TEXT, BOOLEAN) TO service_role;

-- Preserve the installed function definitions, security attributes and EXECUTE
-- roles. The signatures and unique anchors are explicit: drift aborts instead
-- of silently leaving one producer on an unfiltered transport. No trigger is
-- recreated. publish delegates to append, removing its duplicate write body.
DO $migration$
DECLARE
    target_signature TEXT;
    target_oid OID;
    old_body TEXT;
    new_body TEXT;
    definition TEXT;
    old_grants JSONB;
    new_grants JSONB;
    grant_entry JSONB;
    anchor TEXT;
    producer_signatures CONSTANT TEXT[] := ARRAY[
        'chat.publish_user_revision(text,text,jsonb,boolean)',
        'chat.broadcast_main_stream_read_changed()',
        'chat.broadcast_member_stream_read_changed()',
        'chat.broadcast_to_chat_member_user_events(text,text,jsonb)',
        'chat.chat_members_broadcast()',
        'identity.broadcast_friend_request_changed()',
        'identity.broadcast_user_setting_changed()',
        'identity.fan_agent_presence_to_viewers(text,jsonb)',
        'moments.broadcast_feed_changed()',
        'identity.broadcast_agent_deliver_outcome_7503()',
        'public.forum_points_apply()'
    ];
BEGIN
    FOREACH target_signature IN ARRAY array_prepend(
        'chat.append_user_revision(text,text,jsonb,boolean)', producer_signatures
    ) LOOP
        target_oid := to_regprocedure(target_signature);
        IF target_oid IS NULL THEN
            RAISE EXCEPTION 'human user-events migration requires %', target_signature;
        END IF;
        SELECT p.prosrc, pg_get_functiondef(p.oid), (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'role', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
                'grantable', a.grantable
            ) ORDER BY a.grantee), '[]'::jsonb)
            FROM (
                SELECT x.grantee, bool_or(x.is_grantable) AS grantable
                FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
                WHERE x.privilege_type = 'EXECUTE' GROUP BY x.grantee
            ) a
        ) INTO old_body, definition, old_grants
        FROM pg_proc p WHERE p.oid = target_oid;

        IF target_signature = 'chat.append_user_revision(text,text,jsonb,boolean)' THEN
            anchor := '    INSERT INTO chat.account_revision_heads';
            IF length(old_body) - length(replace(old_body, anchor, '')) <> length(anchor)
               OR old_body NOT LIKE '%INSERT INTO chat.account_revisions%'
               OR old_body LIKE '%chat.is_user_event_recipient(%' THEN
                RAISE EXCEPTION 'unexpected append body in %', target_signature;
            END IF;
            new_body := replace(old_body, anchor, E'    IF NOT chat.is_user_event_recipient(p_user_id) THEN\n        RETURN NULL;\n    END IF;\n\n' || anchor);
        ELSIF target_signature = 'chat.publish_user_revision(text,text,jsonb,boolean)' THEN
            IF old_body NOT LIKE '%INSERT INTO chat.account_revisions%'
               OR old_body NOT LIKE '%im_revision_advanced%' THEN
                RAISE EXCEPTION 'unexpected publish body in %', target_signature;
            END IF;
            new_body := $publish$
DECLARE
    next_revision BIGINT;
BEGIN
    next_revision := chat.append_user_revision(p_user_id, p_event, p_resource_key, p_tombstone);
    IF next_revision IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM chat.send_user_event(
        jsonb_build_object('revision', next_revision),
        'im_revision_advanced',
        'gugu:user:' || p_user_id || ':events',
        true
    );
    RETURN next_revision;
END;
$publish$;
        ELSE
            anchor := 'realtime.send(';
            IF length(old_body) - length(replace(old_body, anchor, '')) <> length(anchor)
               OR old_body NOT LIKE '%gugu:user:%:events%' THEN
                RAISE EXCEPTION 'expected one user-event send in %', target_signature;
            END IF;
            new_body := replace(old_body, anchor, 'chat.send_user_event(');
            IF target_signature = 'identity.fan_agent_presence_to_viewers(text,jsonb)' THEN
                anchor := 'IF chat.claim_presence_wake(viewer_user_id) THEN';
                IF length(new_body) - length(replace(new_body, anchor, '')) <> length(anchor) THEN
                    RAISE EXCEPTION 'unexpected presence wake guard';
                END IF;
                new_body := replace(new_body, anchor,
                    'IF next_revision IS NOT NULL AND chat.claim_presence_wake(viewer_user_id) THEN');
            END IF;
        END IF;

        IF length(definition) - length(replace(definition, old_body, '')) <> length(old_body) THEN
            RAISE EXCEPTION 'expected one function body in %', target_signature;
        END IF;
        EXECUTE replace(definition, old_body, new_body);
        -- CREATE OR REPLACE invokes the default-ACL event trigger. Reassert all
        -- pre-existing EXECUTE roles explicitly, including service-only helpers.
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', target_signature);
        FOR grant_entry IN SELECT value FROM jsonb_array_elements(old_grants) LOOP
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',
                target_signature,
                CASE WHEN grant_entry->>'role' = 'PUBLIC' THEN 'PUBLIC'
                     ELSE quote_ident(grant_entry->>'role') END,
                CASE WHEN (grant_entry->>'grantable')::boolean THEN ' WITH GRANT OPTION' ELSE '' END);
        END LOOP;
        SELECT (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'role', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
                'grantable', a.grantable
            ) ORDER BY a.grantee), '[]'::jsonb)
            FROM (
                SELECT x.grantee, bool_or(x.is_grantable) AS grantable
                FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
                WHERE x.privilege_type = 'EXECUTE' GROUP BY x.grantee
            ) a
        ) INTO new_grants FROM pg_proc p WHERE p.oid = target_oid;
        IF new_grants IS DISTINCT FROM old_grants THEN
            RAISE EXCEPTION 'user-events migration changed EXECUTE roles for %', target_signature;
        END IF;
    END LOOP;

    -- Only assert the producers owned by this release. Independent extensions
    -- may share the topic family without belonging to the community schema.
    FOREACH target_signature IN ARRAY producer_signatures LOOP
        SELECT p.prosrc INTO new_body FROM pg_proc p
        WHERE p.oid = to_regprocedure(target_signature);
        IF new_body IS NULL OR new_body NOT LIKE '%chat.send_user_event(%'
           OR new_body LIKE '%realtime.send(%' THEN
            RAISE EXCEPTION 'unfiltered community user-events sender: %', target_signature;
        END IF;
    END LOOP;
END;
$migration$;
