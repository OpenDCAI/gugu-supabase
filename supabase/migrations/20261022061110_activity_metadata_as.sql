-- Chat activity metadata for an actor (a person or one of their agents), by time.
--
-- An assistant needs to know when something happened in which of its chats without reading message
-- bodies; when it needs the context it reads it separately through message_history_as. Account
-- revisions are written for human accounts only (20261021130331_human_user_events), so this reads
-- chat.messages rather than the actor's revision journal: an agent's answer is never an empty journal.
--
-- Each event is one message the actor can still see now: the actor is a member of the chat (without
-- p_chat_id: its own membership rows, topics included; with p_chat_id: the same history floor as
-- message_history_as, so a source-chat member can ask about a topic), the message is not deleted, it is
-- not before the actor's history floor, and a whisper names the actor as sender or recipient. Only
-- identifiers and times are returned: never content, previews, recipients or attachment references.
-- Membership, read, reaction and delivery changes are not covered. Asking about a chat the actor cannot
-- see is an error, not an empty page.
--
-- Paging follows the message ingest sequence under a fixed watermark: the first page fixes
-- through_revision, next_revision continues after the last returned event, and messages that arrive
-- later appear in a new query.
CREATE INDEX idx_messages_chat_created_alive ON chat.messages USING btree (chat_id, created_at) WHERE (deleted_at IS NULL);

CREATE FUNCTION chat.activity_metadata_as(
    p_as_user_id text,
    p_since timestamptz,
    p_until timestamptz,
    p_chat_id text DEFAULT NULL,
    p_after_revision bigint DEFAULT 0,
    p_through_revision bigint DEFAULT NULL,
    p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_head bigint;
    v_through bigint;
    v_events jsonb;
    v_next bigint;
BEGIN
    IF p_as_user_id IS NULL OR NOT chat.is_acting_as(p_as_user_id) THEN
        RAISE EXCEPTION 'Not allowed to read activity as %', p_as_user_id USING ERRCODE = '42501';
    END IF;
    IF p_since IS NULL OR p_until IS NULL OR NOT isfinite(p_since) OR NOT isfinite(p_until) OR p_since >= p_until THEN
        RAISE EXCEPTION 'Activity requires a finite, increasing time range' USING ERRCODE = '22023';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 OR p_after_revision IS NULL OR p_after_revision < 0 THEN
        RAISE EXCEPTION 'Invalid activity page size or cursor' USING ERRCODE = '22023';
    END IF;
    IF p_chat_id IS NOT NULL AND chat.history_floor(p_chat_id, p_as_user_id) IS NULL THEN
        RAISE EXCEPTION 'Not allowed to read activity of chat % as %', p_chat_id, p_as_user_id USING ERRCODE = '42501';
    END IF;
    v_head := COALESCE(pg_sequence_last_value(pg_get_serial_sequence('chat.messages', 'ingest_seq')::regclass), 0);
    v_through := COALESCE(p_through_revision, v_head);
    IF v_through < p_after_revision OR v_through > v_head THEN
        RAISE EXCEPTION 'Activity cursor is outside the message sequence' USING ERRCODE = '22023';
    END IF;

    WITH visible_chats AS (
        SELECT c.chat_id, chat.history_floor(c.chat_id, p_as_user_id) AS floor
          FROM (SELECT p_chat_id AS chat_id WHERE p_chat_id IS NOT NULL
                UNION
                SELECT cm.chat_id FROM chat.chat_members cm
                 WHERE p_chat_id IS NULL AND cm.user_id = p_as_user_id) c
    ), eligible AS (
        SELECT m.ingest_seq, m.chat_id, m.id, m.sender_user_id, m.thread_root_id, m.created_at
          FROM visible_chats v
          JOIN chat.messages m ON m.chat_id = v.chat_id
         WHERE v.floor IS NOT NULL
           AND m.deleted_at IS NULL
           AND m.created_at >= p_since AND m.created_at < p_until
           AND m.created_at >= v.floor
           AND m.ingest_seq > p_after_revision AND m.ingest_seq <= v_through
           AND chat.whisper_visible_to(m.is_whisper, m.sender_user_id, m.to_user_ids, p_as_user_id)
         ORDER BY m.ingest_seq
         LIMIT p_limit + 1
    ), numbered AS (
        SELECT e.*, row_number() OVER (ORDER BY e.ingest_seq) AS page_rank FROM eligible e
    )
    SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'revision', n.ingest_seq, 'kind', 'message_created', 'occurred_at', n.created_at,
               'chat_id', n.chat_id, 'message_id', n.id, 'sender_user_id', n.sender_user_id,
               'thread_root_id', n.thread_root_id)) ORDER BY n.ingest_seq) FILTER (WHERE n.page_rank <= p_limit), '[]'::jsonb),
           CASE WHEN count(*) > p_limit THEN max(n.ingest_seq) FILTER (WHERE n.page_rank <= p_limit) END
      INTO v_events, v_next
      FROM numbered n;

    RETURN jsonb_build_object('events', v_events, 'next_revision', v_next, 'through_revision', v_through,
        'coverage', jsonb_strip_nulls(jsonb_build_object(
            'scope', 'actor_visible_chat_messages', 'actor_user_id', p_as_user_id, 'chat_id', p_chat_id,
            'queried_at', now(),
            'note', 'Message creation only, at its database time. Current membership, history floor and whisper visibility are rechecked; deleted or no longer visible messages are omitted. Membership, read, reaction and delivery changes are not included. Messages that arrive after the first page appear in a new query.')));
END;
$function$;
REVOKE ALL ON FUNCTION chat.activity_metadata_as(text, timestamptz, timestamptz, text, bigint, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.activity_metadata_as(text, timestamptz, timestamptz, text, bigint, bigint, integer) TO authenticated, service_role;
