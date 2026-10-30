-- Private display overrides share one owner-scoped table for contacts and groups.
-- The default and original unique key keep deployed contact upserts working.
ALTER TABLE identity.contact_overrides
    DROP CONSTRAINT contact_overrides_pkey,
    ALTER COLUMN contact_user_id DROP NOT NULL,
    ADD COLUMN target_kind text NOT NULL DEFAULT 'contact',
    ADD COLUMN group_chat_id text REFERENCES chat.chats(id) ON DELETE CASCADE,
    ADD COLUMN target_id text GENERATED ALWAYS AS (COALESCE(contact_user_id, group_chat_id)) STORED,
    ADD CONSTRAINT contact_overrides_target_check CHECK (
        (target_kind = 'contact' AND contact_user_id IS NOT NULL AND group_chat_id IS NULL)
        OR (target_kind = 'group' AND group_chat_id IS NOT NULL AND contact_user_id IS NULL)),
    ADD PRIMARY KEY (owner_user_id, target_kind, target_id),
    ADD UNIQUE (owner_user_id, contact_user_id);

CREATE INDEX contact_overrides_group_idx ON identity.contact_overrides(group_chat_id)
    WHERE group_chat_id IS NOT NULL;
COMMENT ON TABLE identity.contact_overrides IS
    'Private display overrides keyed by owner and target kind/id; contact and group aliases use the same storage and sync.';

ALTER POLICY contact_overrides_owner_all ON identity.contact_overrides
    WITH CHECK (owner_user_id = (SELECT auth.uid()::text)
        AND (target_kind = 'contact' OR EXISTS (
            SELECT 1 FROM chat.chats c WHERE c.id = group_chat_id AND c.kind = 'group'
                AND chat.is_member(c.id))));

CREATE FUNCTION identity.publish_display_override_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    row_value identity.contact_overrides;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
            OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
            OR NEW.target_id IS DISTINCT FROM OLD.target_id THEN
            RAISE EXCEPTION 'Display override owner and target cannot be changed';
        END IF;
        IF NEW.alias IS NOT DISTINCT FROM OLD.alias THEN RETURN NEW; END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN row_value := OLD; ELSE row_value := NEW; END IF;
    PERFORM chat.publish_user_revision(row_value.owner_user_id,
        CASE row_value.target_kind WHEN 'group' THEN 'chat_meta_changed' ELSE 'friendship_changed' END,
        CASE row_value.target_kind
            WHEN 'group' THEN jsonb_build_object('chat_id', row_value.target_id)
            ELSE jsonb_build_object('contact_user_id', row_value.target_id) END,
        TG_OP = 'DELETE');
    RETURN COALESCE(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION identity.publish_display_override_revision() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER display_override_revision
    AFTER INSERT OR UPDATE OR DELETE ON identity.contact_overrides
    FOR EACH ROW EXECUTE FUNCTION identity.publish_display_override_revision();

CREATE OR REPLACE FUNCTION chat.sync_snapshot() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY INVOKER
    SET search_path = pg_catalog
AS $$
DECLARE
    viewer text := auth.uid()::text;
    result jsonb;
    response_bytes integer;
    -- A response is complete or an explicit error; never silently truncate rows.
    max_response_bytes CONSTANT integer := 16777216;
BEGIN
    IF viewer IS NULL THEN
        RAISE EXCEPTION 'authenticated account is required' USING ERRCODE = '42501';
    END IF;

    WITH conversations AS MATERIALIZED (
        SELECT c.id, c.public_id, c.kind, c.status, c.name, c.avatar_url,
               c.created_at, c.next_message_seq, c.pinned_message_id,
               c.source_chat_id, c.source_message_id
          FROM chat.chats c
          JOIN chat.chat_members own ON own.chat_id = c.id AND own.user_id = viewer
         WHERE own.inbox_published_at IS NOT NULL
           AND c.status IN ('active', 'stopped', 'paused')
    ), members AS MATERIALIZED (
        SELECT m.chat_id, m.user_id, m.last_read_seq, m.is_marked_unread, m.version,
               m.notification_level, m.is_pinned, m.updated_at, m.joined_at,
               m.inbox_published_at, m.role
          FROM chat.chat_members m JOIN conversations c ON c.id = m.chat_id
    ), identity_ids AS (
        SELECT viewer AS id UNION SELECT user_id FROM members
        UNION SELECT CASE WHEN f.user_a_id = viewer THEN f.user_b_id ELSE f.user_a_id END
                FROM identity.friendships f
               WHERE viewer IN (f.user_a_id, f.user_b_id)
        UNION SELECT u.id FROM identity.users u WHERE u.owner_user_id = viewer
    ), identities AS MATERIALIZED (
        SELECT u.id, u.gugu_number, u.display_name, u.avatar, u.bio, u.type,
               u.owner_user_id, u.agent_public, u.desired_status, u.device_id,
               u.category, u.is_official, u.local_path, u.created_at, u.updated_at
          FROM identity.users u JOIN identity_ids ids ON ids.id = u.id
    ), previews AS (
        SELECT c.id AS chat_id, p.id, p.created_at, p.preview, p.seq,
               p.content_type, p.sender_user_id, p.client_message_id
          FROM conversations c
          LEFT JOIN LATERAL (
              SELECT v.id, v.created_at, chat.preview(v) AS preview, v.seq, v.content_type,
                     v.sender_user_id, v.client_message_id
                FROM chat.messages_view v
               WHERE v.chat_id = c.id AND v.is_whisper = false
               ORDER BY v.seq DESC LIMIT 1
          ) p ON true
    )
    SELECT jsonb_build_object(
        'account_id', viewer,
        'revision', COALESCE((SELECT h.revision FROM chat.account_revision_heads h
                              WHERE h.user_id = viewer), 0)::text,
        'chats', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM conversations c), '[]'::jsonb),
        'memberships', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.chat_id, m.user_id) FROM members m), '[]'::jsonb),
        'identities', COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM identities u), '[]'::jsonb),
        'previews', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.chat_id) FROM previews p), '[]'::jsonb),
        'unread', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.chat_id, r.stream_id)
                            FROM chat.list_unread_locators(NULL) r), '[]'::jsonb),
        'overrides', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'target_kind', o.target_kind, 'target_id', o.target_id,
            'contact_user_id', o.contact_user_id, 'alias', o.alias) ORDER BY o.target_kind, o.target_id)
            FROM identity.contact_overrides o WHERE o.owner_user_id = viewer), '[]'::jsonb),
        'presence', COALESCE((SELECT jsonb_object_agg(u.id, identity.get_agent_presence(u.id))
            FROM identities u WHERE u.type = 'agent' AND identity.can_view_agent_runtime_state(u.id)), '{}'::jsonb)
    ) INTO result;

    response_bytes := octet_length(result::text);
    IF response_bytes > max_response_bytes THEN
        RAISE EXCEPTION 'account snapshot requires % bytes; response budget is % bytes',
            response_bytes, max_response_bytes USING ERRCODE = '54000';
    END IF;
    RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION chat.sync_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.sync_snapshot() TO authenticated;
