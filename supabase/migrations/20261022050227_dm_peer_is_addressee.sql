-- In a direct chat (dm, ai), a person's message that names nobody is addressed to the other member.
--
-- chat.message_wakes_agent is the one wake predicate: the agent.deliver trigger and the wake list that
-- pull_agent_inbox_v2 reads both call it. It used to know addressing only from to_user_ids and the reply
-- target, and an undirected message woke agents only in groups and topics. So a direct chat relied on every
-- client write path to fill to_user_ids with the peer; a path that did not (forwarding a message or an
-- attachment into the chat) wrote a message the agent never received.
--
-- Now a message in a dm or ai chat from a person (a sender that is not an agent and not a server-written
-- notice) with no recipients names the other member, with or without a reply target (quoting your own line
-- still talks to the peer). Explicit recipients, whispers included, are honored as before. An agent's
-- undirected message in a direct chat still wakes nobody, so agents can close out without waking each other.
-- Group and topic rules are unchanged. Wakes are recorded at send, so messages sent before this release stay
-- as they were.
CREATE OR REPLACE FUNCTION chat.message_wakes_agent(p_agent_user_id text, p_listen_mode text, p_notification_level text, p_chat_kind text, p_sender_user_id text, p_sender_is_agent boolean, p_sender_is_creator boolean, p_to_user_ids text[], p_is_whisper boolean, p_reply_target text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT COALESCE(
        p_agent_user_id IS DISTINCT FROM p_sender_user_id
        AND CASE
            WHEN f.directed THEN
                (f.named OR f.everyone)
                AND chat.member_accepts_delivery(p_notification_level, p_sender_is_creator, f.named)
            ELSE
                -- whisper 必定向(表上有 CHECK);这里不靠它 —— 没有收件人的 whisper 谁也不唤醒。
                NOT COALESCE(p_is_whisper, false)
                AND p_chat_kind IN ('group', 'topic')
                -- #6860 没有发信人 = 服务端写的旁白(入群、agent 较多);没点名就不是请求,谁也不唤醒。
                AND p_sender_user_id IS NOT NULL
                AND NOT COALESCE(p_sender_is_agent, false)
                AND p_listen_mode = 'active'
                AND chat.member_accepts_delivery(p_notification_level, p_sender_is_creator, false)
        END,
        false)
    FROM (
        SELECT
            COALESCE(cardinality(p_to_user_ids), 0) > 0 OR p_reply_target IS NOT NULL OR d.peer  AS directed,
            COALESCE(p_agent_user_id = ANY (p_to_user_ids), false)
                OR (NOT COALESCE(p_is_whisper, false)
                    AND COALESCE(p_agent_user_id = p_reply_target, false))
                OR d.peer                                                                    AS named,
            NOT COALESCE(p_is_whisper, false)
                AND COALESCE('*' = ANY (p_to_user_ids), false)                           AS everyone
        FROM (
            -- 私聊里人发的、没点名的话,收件人就是对端(调用方只把本 chat 的成员、且不是发信人的那位传进来)。
            SELECT p_chat_kind IN ('dm', 'ai')
                   AND p_sender_user_id IS NOT NULL
                   AND NOT COALESCE(p_sender_is_agent, false)
                   AND COALESCE(cardinality(p_to_user_ids), 0) = 0 AS peer
        ) d
    ) f;
$$;
REVOKE ALL ON FUNCTION chat.message_wakes_agent(p_agent_user_id text, p_listen_mode text, p_notification_level text, p_chat_kind text, p_sender_user_id text, p_sender_is_agent boolean, p_sender_is_creator boolean, p_to_user_ids text[], p_is_whisper boolean, p_reply_target text) FROM PUBLIC;
