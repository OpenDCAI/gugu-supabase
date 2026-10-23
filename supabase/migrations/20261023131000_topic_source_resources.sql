-- A topic is a message stream inside its source chat, not a resource container.
-- Public RPC shapes and topic participation/read positions do not change.
-- Install through the release runner: definitions and metadata move commit together.
SET LOCAL lock_timeout = '15s';
-- Establish the upgrade boundary before changing definitions or taking a data
-- snapshot. Policy DDL also locks Supabase-managed tables. Take their strongest
-- locks first, then drain core writers and row lockers, with no waiting while
-- holding a partial set. A busy deployment aborts instead of waiting in a cycle.
-- Supabase migration ledgers and vector-only tables without deployment-role
-- DML grants are not part of these policies or runtime calls. Do not widen their
-- grants merely to lock them.
-- Keep the policy and metadata change atomic: no intermediate Storage scope.
DO $locks$
DECLARE v RECORD;
BEGIN
    FOR v IN
        SELECT n.nspname, c.relname,
               CASE WHEN n.nspname IN ('auth','storage','realtime')
                          OR (n.nspname = 'chat' AND c.relname IN ('chats','workspace_items'))
                    THEN 'ACCESS EXCLUSIVE' ELSE 'EXCLUSIVE' END AS lock_mode
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('auth','storage','realtime','identity','chat')
           AND c.relkind IN ('r','p')
           AND (n.nspname IN ('chat','identity')
                OR pg_catalog.has_table_privilege(c.oid, 'UPDATE,DELETE,TRUNCATE'))
         ORDER BY CASE n.nspname WHEN 'auth' THEN 0 WHEN 'storage' THEN 1
                    WHEN 'realtime' THEN 2 WHEN 'identity' THEN 3 ELSE 4 END, c.oid
    LOOP
        EXECUTE format('LOCK TABLE ONLY %I.%I IN %s MODE NOWAIT', v.nspname, v.relname, v.lock_mode);
    END LOOP;
EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING ERRCODE = '55P03', HINT = 'topic_resources_lock_busy_retry',
        MESSAGE = 'topic resource upgrade locks are busy; retry the complete release after active transactions finish';
END;
$locks$;

-- This helper is internal. Callers obtain their actor with workspace_actor_for
-- (or have already verified the message sender). Do not expose a membership probe.
DROP FUNCTION chat.workspace_require_room_member(text, text);
CREATE FUNCTION chat.workspace_require_room_member(p_chat_id text, p_actor text) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_resource TEXT;
BEGIN
    SELECT r.id INTO v_resource
      FROM chat.chats c
      JOIN chat.chats r ON r.id = COALESCE(c.source_chat_id, c.id)
     WHERE c.id = p_chat_id AND c.kind IN ('group', 'topic', 'dm', 'ai')
       AND r.kind IN ('group', 'dm', 'ai');
    IF v_resource IS NULL OR NOT chat.is_chat_member(v_resource, p_actor) THEN
        RAISE EXCEPTION 'workspace: % is not a chat you are a member of', p_chat_id USING HINT = 'workspace_not_member';
    END IF;
    RETURN v_resource;
END;
$$;
REVOKE ALL ON FUNCTION chat.workspace_require_room_member(text, text) FROM PUBLIC, anon, authenticated;


ALTER TABLE chat.chats ADD CONSTRAINT chats_id_uuid
    CHECK (id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

CREATE OR REPLACE FUNCTION chat.create_gugu_group(p_chat_id text, p_name text, p_owner_user_id text, p_initial_members jsonb, p_default_agent_type text DEFAULT NULL::text, p_group_prompt text DEFAULT NULL::text)
 RETURNS chat.chats
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'identity', 'public', 'pg_catalog'
AS $function$
DECLARE
    caller_user_id TEXT;
    inserted       chat.chats;
    m              JSONB;
    member_user_id TEXT;
    member_role    TEXT;
    inserted_member_count INT := 0;
    inserted_member_rows  INT := 0;
    member_denial  TEXT;
BEGIN
    caller_user_id := (SELECT auth.uid()::text);
    IF caller_user_id IS NULL OR caller_user_id <> p_owner_user_id THEN
        RAISE EXCEPTION 'caller % cannot create group on behalf of %',
                        caller_user_id, p_owner_user_id;
    END IF;

    IF p_chat_id IS NULL OR p_chat_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', HINT = 'chat_id_not_uuid',
            MESSAGE = 'chat id must be a UUID in 8-4-4-4-12 hexadecimal form';
    END IF;

    IF p_initial_members IS NULL OR jsonb_typeof(p_initial_members) <> 'array' THEN
        RAISE EXCEPTION 'p_initial_members must be a jsonb array';
    END IF;

    SET CONSTRAINTS ALL DEFERRED;

    INSERT INTO chat.chats (
        id, kind, name, status, creator_user_id,
        group_prompt, default_agent_type
    ) VALUES (
        p_chat_id, 'group', p_name, 'active', p_owner_user_id,
        p_group_prompt, p_default_agent_type
    ) RETURNING * INTO inserted;

    INSERT INTO chat.chat_members (chat_id, user_id, role)
    VALUES (p_chat_id, p_owner_user_id, 'owner');

    FOR m IN SELECT * FROM jsonb_array_elements(p_initial_members) LOOP
        member_user_id := m ->> 'user_id';
        member_role    := COALESCE(m ->> 'role', 'member');
        IF member_user_id IS NULL OR member_user_id = p_owner_user_id THEN
            CONTINUE;
        END IF;
        -- #1761 云 agent 禁入群（fail-loud，不静默跳过）
        IF chat.is_cloud_agent_user(member_user_id) THEN
            RAISE EXCEPTION 'cloud agent % cannot join groups (#1761)', member_user_id;
        END IF;
        -- 群只有一个 owner(= 创建者);初始成员只能是 member/admin。
        IF member_role NOT IN ('member', 'admin') THEN
            RAISE EXCEPTION 'initial member % cannot have role %', member_user_id, member_role;
        END IF;
        -- 与其余入口同一道「能否加此人」(调用者就是 owner:拦的是上限、身份存在、别人名下的 agent ——
        -- 别人的 agent 要走 agent 群邀请,由它的主人接受)。
        IF NOT chat.group_related(p_owner_user_id, member_user_id) THEN
            RAISE EXCEPTION 'initial_member_requires_invitation';
        END IF;
        member_denial := chat.group_add_denial(p_chat_id, member_user_id, p_owner_user_id);
        IF member_denial IS NOT NULL THEN
            RAISE EXCEPTION 'cannot add % to group %: %', member_user_id, p_chat_id, member_denial;
        END IF;
        INSERT INTO chat.chat_members (chat_id, user_id, role)
        VALUES (p_chat_id, member_user_id, member_role)
        ON CONFLICT (chat_id, user_id) DO NOTHING;
        GET DIAGNOSTICS inserted_member_rows = ROW_COUNT;
        inserted_member_count := inserted_member_count + inserted_member_rows;
    END LOOP;


    RETURN inserted;
END;
$function$;

CREATE OR REPLACE FUNCTION chat.chat_facts(p_chat_id text, p_as_user_id text DEFAULT NULL::text) RETURNS TABLE(id text, kind text, source_chat_id text, group_prompt text, public_id integer)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_caller TEXT := (SELECT auth.uid()::text);
    v_actor TEXT;
    v_chat_id TEXT := p_chat_id;
    v_public_id BIGINT := CASE WHEN p_chat_id ~ '^[0-9]{1,10}$' THEN p_chat_id::BIGINT END;
    v_is_agent BOOLEAN;
    v_owner TEXT;
BEGIN
    v_actor := COALESCE(NULLIF(trim(p_as_user_id), ''), v_caller);
    SELECT u.type = 'agent', u.owner_user_id INTO v_is_agent, v_owner
      FROM identity.users u WHERE u.id = v_actor;
    IF v_actor IS DISTINCT FROM v_caller AND NOT (COALESCE(v_is_agent, false) AND v_owner = v_caller) THEN
        RAISE EXCEPTION 'Not allowed to act as %', v_actor;
    END IF;

    -- Chat IDs are UUIDs; numeric addresses identify public_id only.
    IF p_chat_id ~ '^[0-9]+$' THEN
        SELECT c.id INTO v_chat_id FROM chat.chats c WHERE c.public_id = v_public_id;
    END IF;

    RETURN QUERY
    SELECT c.id, c.kind, c.source_chat_id, c.group_prompt, c.public_id
      FROM chat.chats c
     WHERE c.id = v_chat_id
       AND (
           chat.is_chat_member(c.id, v_actor)
           -- 主人看得见的,替他办事的 agent 也读得到(这就是它替换掉的那条裸读的可见域)。
           OR chat.is_chat_member(c.id, v_caller)
           -- 可见继承来源:看得见来源线就看得见这条话题存在(spec)。
           OR (c.kind = 'topic' AND c.source_chat_id IS NOT NULL
               AND (chat.is_chat_member(c.source_chat_id, v_actor)
                    OR chat.is_chat_member(c.source_chat_id, v_caller)))
       );
END;
$$;

CREATE OR REPLACE FUNCTION chat.group_add_denial(
    p_chat_id TEXT, p_user_id TEXT, p_actor_user_id TEXT,
    p_take_seat BOOLEAN DEFAULT true, p_owner_consented BOOLEAN DEFAULT false
)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_chat chat.chats%ROWTYPE; v_target identity.users%ROWTYPE; v_actor identity.users%ROWTYPE;
    v_role TEXT; v_count INTEGER; v_related BOOLEAN;
BEGIN
    IF p_actor_user_id IS NULL THEN RETURN 'not_authenticated'; END IF;
    SELECT * INTO v_chat FROM chat.chats WHERE id = p_chat_id;
    IF NOT FOUND OR v_chat.kind NOT IN ('group','topic') THEN RETURN 'not_a_group'; END IF;
    IF v_chat.status = 'archived' THEN RETURN 'group_archived'; END IF;
    SELECT * INTO v_target FROM identity.users WHERE id = p_user_id;
    IF NOT FOUND THEN RETURN 'user_not_found'; END IF;
    IF chat.is_cloud_agent_user(p_user_id) THEN RETURN 'cloud_agent'; END IF;
    IF chat.is_chat_member(p_chat_id, p_user_id) THEN RETURN NULL; END IF;
    -- 项目群只有项目的主人和主人的 agent(gugu-dev#181):设备上报的项目记着它绑的群(identity.device_projects.chat_id)。
    -- 这是那条记录本身的事实,❌ 从群名、群人数之类去猜哪个群是项目群。已经在群里的人不动(上一行)。
    IF v_chat.kind = 'group' AND EXISTS (SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id = p_chat_id)
       AND NOT EXISTS (SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id = p_chat_id
                       AND dp.user_id::text IN (p_user_id, v_target.owner_user_id)) THEN
        RETURN 'project_group_owner_only';
    END IF;
    SELECT * INTO v_actor FROM identity.users WHERE id = p_actor_user_id;
    IF NOT FOUND THEN RETURN 'actor_not_member'; END IF;
    IF v_chat.kind = 'topic' THEN
        IF NOT chat.is_chat_member(v_chat.source_chat_id, p_actor_user_id) THEN RETURN 'actor_not_member'; END IF;
        IF NOT chat.is_chat_member(v_chat.source_chat_id, p_user_id) THEN RETURN 'not_in_source_line'; END IF;
        RETURN NULL;
    END IF;
    SELECT role INTO v_role FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = p_actor_user_id;
    v_related := chat.group_related(p_actor_user_id, p_user_id);
    IF v_role IS NULL THEN
        IF p_user_id = p_actor_user_id AND v_chat.creator_user_id = p_actor_user_id
           AND NOT EXISTS (SELECT 1 FROM chat.chat_members WHERE chat_id = p_chat_id) THEN
            v_role := 'owner'; -- the creator's initial seat
        ELSIF v_actor.type = 'agent' AND v_target.type = 'agent' AND v_related
           AND chat.is_chat_member(p_chat_id, v_actor.owner_user_id) THEN
            v_role := 'member'; -- enrollment consent is not the owner's admin role
        ELSE RETURN 'actor_not_member'; END IF;
    END IF;
    IF v_target.type = 'agent' AND NOT v_related AND NOT COALESCE(p_owner_consented,false) THEN
        RETURN 'agent_not_owned'; END IF;
    IF v_role NOT IN ('owner','admin') THEN
        IF v_target.type = 'agent' AND v_chat.agent_join_approval THEN RETURN 'agent_join_requires_manager';
        ELSIF v_target.type <> 'agent' AND NOT v_related AND NOT v_chat.allow_member_invite THEN
            RETURN 'member_invite_disabled'; END IF;
    END IF;
    IF p_take_seat THEN
        SELECT count(*) INTO v_count FROM chat.chat_members WHERE chat_id = p_chat_id;
        IF v_count >= v_chat.max_members THEN RETURN 'member_limit_reached'; END IF;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION chat.add_group_agent(
    p_chat_id TEXT,
    p_agent_user_id TEXT,
    p_message TEXT,
    p_as_user_id TEXT,
    p_as_task BOOLEAN DEFAULT false
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_actor TEXT := chat.require_group_actor(p_as_user_id);
    v_denial TEXT;
    v_request TEXT;
    v_source TEXT;
    v_result JSONB;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.users WHERE id = p_agent_user_id AND type = 'agent'
                   AND owner_user_id = auth.uid()::text) THEN RAISE EXCEPTION 'agent_not_owned'; END IF;
    SELECT c.source_chat_id INTO v_source FROM chat.chats c WHERE c.id = p_chat_id AND c.kind = 'topic';
    IF v_source IS NOT NULL AND NOT chat.is_chat_member(v_source, p_agent_user_id) THEN
        -- The same normal admission, approval and capacity rules apply first.
        v_result := chat.add_group_agent(v_source, p_agent_user_id, p_message, v_actor, p_as_task);
        IF v_result->>'status' NOT IN ('joined','already_member') THEN RETURN v_result; END IF;
    END IF;
    PERFORM 1 FROM chat.chats WHERE id = p_chat_id FOR UPDATE;
    v_denial := chat.group_add_denial(p_chat_id, p_agent_user_id, v_actor);
    IF v_denial = 'agent_join_requires_manager' THEN
        v_request := chat.queue_agent_join_request(p_chat_id, p_agent_user_id, v_actor, p_message);
        RETURN jsonb_build_object('status', 'pending_approval', 'request_id', v_request, 'chat_id', p_chat_id);
    END IF;
    IF v_denial IS NOT NULL THEN RAISE EXCEPTION '%', v_denial; END IF;
    IF chat.is_chat_member(p_chat_id, p_agent_user_id) THEN
        RETURN jsonb_build_object('status', 'already_member', 'chat_id', p_chat_id);
    END IF;
    PERFORM chat.insert_group_member(p_chat_id, p_agent_user_id, 'active', NOT p_as_task);
    RETURN jsonb_build_object('status', 'joined', 'chat_id', p_chat_id);
END;
$$;

CREATE OR REPLACE FUNCTION chat.create_topic(p_source_chat_id text, p_source_message_id text, p_name text DEFAULT NULL::text, p_member_user_ids text[] DEFAULT NULL::text[], p_as_user_id text DEFAULT NULL::text) RETURNS TABLE(chat_id text, public_id integer, name text, source_chat_id text, source_message_id text, creator_user_id text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'identity', 'public', 'pg_catalog'
    AS $$
#variable_conflict use_column
DECLARE
    v_me TEXT := auth.uid()::text;
    v_actor TEXT;
    v_actor_is_agent BOOLEAN;
    v_actor_owner TEXT;
    v_owner_in_source BOOLEAN;
    v_actor_name TEXT;
    v_source_kind TEXT;
    v_source_hide_history BOOLEAN;
    v_source_content TEXT;
    v_source_is_whisper BOOLEAN;
    v_source_retracted TIMESTAMPTZ;
    v_source_content_type TEXT;
    v_name TEXT;
    v_chat_id TEXT := gen_random_uuid()::text;
    v_members TEXT[];
    v_denial TEXT;
    v_candidate TEXT;
    v_join JSONB;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    v_actor := COALESCE(NULLIF(trim(COALESCE(p_as_user_id, '')), ''), v_me);
    SELECT u.type = 'agent', u.owner_user_id, u.display_name
      INTO v_actor_is_agent, v_actor_owner, v_actor_name
      FROM identity.users u WHERE u.id = v_actor;
    IF v_actor <> v_me AND NOT (COALESCE(v_actor_is_agent, false) AND v_actor_owner = v_me) THEN
        RAISE EXCEPTION 'Cannot open a topic as %', v_actor;
    END IF;

    SELECT c.kind, c.hide_history INTO v_source_kind, v_source_hide_history
      FROM chat.chats c WHERE c.id = p_source_chat_id;
    IF v_source_kind IS NULL THEN
        RAISE EXCEPTION 'Source chat % not found', p_source_chat_id;
    END IF;
    IF v_source_kind = 'topic' THEN
        RAISE EXCEPTION 'A topic cannot grow out of another topic';
    END IF;

    v_owner_in_source := COALESCE(v_actor_is_agent, false)
        AND v_actor_owner IS NOT NULL
        AND chat.is_chat_member(p_source_chat_id, v_actor_owner);

    IF NOT chat.is_chat_member(p_source_chat_id, v_actor) AND NOT v_owner_in_source THEN
        RAISE EXCEPTION 'Not a member of the source chat';
    END IF;

    -- Creating a topic with an agent enrolls it through ordinary source
    -- admission; a pending approval cannot produce a topic-only participant.
    IF v_owner_in_source AND NOT chat.is_chat_member(p_source_chat_id, v_actor) THEN
        v_join := chat.add_group_agent(p_source_chat_id, v_actor, NULL, v_actor);
        IF v_join->>'status' NOT IN ('joined','already_member') THEN
            RAISE EXCEPTION 'agent_join_requires_manager: join the source before opening this topic';
        END IF;
    END IF;
    FOREACH v_candidate IN ARRAY COALESCE(p_member_user_ids, ARRAY[]::TEXT[]) LOOP
        IF NOT chat.is_chat_member(p_source_chat_id, v_candidate)
           AND EXISTS (SELECT 1 FROM identity.users u WHERE u.id = v_candidate AND u.type = 'agent') THEN
            v_join := chat.add_group_agent(p_source_chat_id, v_candidate, NULL, v_actor);
            IF v_join->>'status' NOT IN ('joined','already_member') THEN
                RAISE EXCEPTION 'agent_join_requires_manager: join the source before opening this topic';
            END IF;
        END IF;
    END LOOP;

    SELECT m.content, m.is_whisper, m.retracted_at, m.content_type
      INTO v_source_content, v_source_is_whisper, v_source_retracted, v_source_content_type
    FROM chat.messages m
    WHERE m.id = p_source_message_id
      AND m.chat_id = p_source_chat_id
      AND m.deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Source message % is not a live message of chat %',
            p_source_message_id, p_source_chat_id;
    END IF;

    -- 悄悄话开不出话题:话题对来源线全员可见,而它的名字截自来源消息 ⇒ 开一条就是公开那句话。
    IF COALESCE(v_source_is_whisper, false) THEN
        RAISE EXCEPTION 'A whisper cannot be the source of a topic';
    END IF;

    -- 撤回的消息同理:那句话已经被收回,❌ 不许借话题名把它重新贴到所有人眼前。
    IF v_source_retracted IS NOT NULL THEN
        RAISE EXCEPTION 'A retracted message cannot be the source of a topic';
    END IF;

    IF NOT chat.can_read_message(p_source_message_id, v_actor)
       AND NOT (v_owner_in_source AND chat.can_read_message(p_source_message_id, v_actor_owner)) THEN
        RAISE EXCEPTION 'Source message % is not readable by %', p_source_message_id, v_actor;
    END IF;

    v_name := NULLIF(trim(COALESCE(p_name, '')), '');
    -- 只有正文类消息值得截名:系统消息会开出一条叫「某某 开了话题:…」的话题,附件会开出
    -- 「[附件] 季度报表.xlsx (2.1 MB)」—— 都不像人起的名字。其余类型退回「话题」,用户自己改。
    IF v_name IS NULL AND COALESCE(v_source_content_type, 'text') = 'text' THEN
        v_name := chat.topic_name_from_message(v_source_content);
    END IF;
    v_name := COALESCE(v_name, '话题');

    -- @@@5856 hide_history 跟着来源线走。不带它 ⇒ 话题默认 false ⇒ 入列触发器给成员置的时间界是 NULL,
    -- 于是「被时间界挡住的人在话题里说一句话(说话即参与)就解锁全部历史」。
    -- 可见继承来源,那道界也得继承。来源线里本来没有界的人不受影响 —— 他们走 can_see_topic_message。
    INSERT INTO chat.chats (id, kind, name, creator_user_id, source_chat_id, source_message_id, hide_history)
    VALUES (v_chat_id, 'topic', v_name, v_actor, p_source_chat_id, p_source_message_id,
            COALESCE(v_source_hide_history, false));

    -- ⚠️ 这道 is_chat_member 与下面 row3 的 `NOT v_owner_in_source OR …` 互补:主人不在来源线时
    -- row3 不过滤,但这里已经先把他踢掉了。动任一处都要看另一处。
    SELECT COALESCE(array_agg(DISTINCT candidate.user_id), ARRAY[]::TEXT[])
    INTO v_members
    FROM unnest(COALESCE(p_member_user_ids, ARRAY[]::TEXT[])) AS candidate(user_id)
    WHERE NULLIF(candidate.user_id, '') IS NOT NULL
      AND candidate.user_id <> v_actor
      AND chat.is_chat_member(p_source_chat_id, candidate.user_id);

    INSERT INTO chat.chat_members (chat_id, user_id, role)
    SELECT v_chat_id, v_actor, CASE WHEN v_owner_in_source THEN 'member' ELSE 'owner' END
    UNION ALL
    SELECT v_chat_id, v_actor_owner, 'owner'
     WHERE v_owner_in_source AND v_actor_owner <> v_actor
    UNION ALL
    SELECT v_chat_id, member_id, 'member' FROM unnest(v_members) AS member_id
     WHERE NOT v_owner_in_source OR member_id <> v_actor_owner
    ON CONFLICT (chat_id, user_id) DO NOTHING;

    INSERT INTO chat.group_agent_states (
        chat_id, agent_user_id, functional_role, capability_roles, last_action, updated_at
    )
    SELECT v_chat_id, u.id, 'member', ARRAY['member']::TEXT[], '已加入话题', now()
    FROM identity.users u
    WHERE u.type = 'agent'
      AND (u.id = v_actor OR u.id = ANY(v_members));

    IF COALESCE(v_actor_is_agent, false) THEN
        INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, client_message_id)
        VALUES (
            gen_random_uuid()::text,
            p_source_chat_id,
            v_actor,
            COALESCE(v_actor_name, 'Agent') || ' 开了话题:' || v_name,
            'system',
            'topic-opened:' || v_chat_id
        )
        ON CONFLICT (chat_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING;
    END IF;

    RETURN QUERY
    SELECT c.id, c.public_id, c.name, c.source_chat_id, c.source_message_id, c.creator_user_id
    FROM chat.chats c WHERE c.id = v_chat_id;
END;
$$;

CREATE OR REPLACE FUNCTION chat.join_topic_participants() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'identity', 'public', 'pg_catalog'
    AS $$
DECLARE
    v_source_chat_id TEXT;
    v_join JSONB;
BEGIN
    SELECT c.source_chat_id INTO v_source_chat_id
    FROM chat.chats c
    WHERE c.id = NEW.chat_id AND c.kind = 'topic';

    IF v_source_chat_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- 说话就是参与
    IF NEW.sender_user_id IS NOT NULL THEN
        IF NOT chat.is_chat_member(v_source_chat_id, NEW.sender_user_id)
           AND EXISTS (SELECT 1 FROM identity.users u WHERE u.id = NEW.sender_user_id AND u.type = 'agent') THEN
            v_join := chat.add_group_agent(v_source_chat_id, NEW.sender_user_id, NULL, NEW.sender_user_id);
            IF v_join->>'status' NOT IN ('joined','already_member') THEN
                RAISE EXCEPTION 'agent_join_requires_manager: join the source before speaking in this topic';
            END IF;
        END IF;
        INSERT INTO chat.chat_members (chat_id, user_id, role, joined_ingest_seq)
        VALUES (NEW.chat_id, NEW.sender_user_id, 'member', NEW.ingest_seq - 1)
        ON CONFLICT (chat_id, user_id) DO NOTHING;
    END IF;

    -- 被 @ 就是被拉进来(只限来源线里已有的人/agent:agent 能拉不能加,见 agent-social)。
    -- 在这条消息入群(界 = NEW.ingest_seq - 1,门 `>`):拉你进来的这一条,你收得到(#6405)。
    IF NEW.to_user_ids IS NOT NULL THEN
        INSERT INTO chat.chat_members (chat_id, user_id, role, joined_ingest_seq)
        SELECT NEW.chat_id, target.user_id, 'member', NEW.ingest_seq - 1
        FROM unnest(NEW.to_user_ids) AS target(user_id)
        WHERE target.user_id <> '*'
          AND chat.is_chat_member(v_source_chat_id, target.user_id)
        ON CONFLICT (chat_id, user_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION chat.chats_membership_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = chat, identity, public, pg_catalog
AS $$
DECLARE
    affected_chat_id TEXT := COALESCE(NEW.chat_id, OLD.chat_id);
    chat_kind TEXT;
    chat_status TEXT;
    creator_user_id TEXT;
    owner_user_id TEXT;
    owner_count INTEGER;
    owner_is_human BOOLEAN;
    member_count_val INTEGER;
BEGIN
    SELECT kind, status, chats.creator_user_id
    INTO chat_kind, chat_status, creator_user_id
    FROM chat.chats WHERE id = affected_chat_id;
    -- Reuse the deferred membership invariant for pooled calls already running
    -- an old function body: they still cannot commit a topic-only agent.
    IF chat_kind = 'topic' AND EXISTS (
        SELECT 1 FROM chat.chat_members m
        JOIN identity.users u ON u.id = m.user_id AND u.type = 'agent'
        JOIN chat.chats t ON t.id = m.chat_id
        WHERE m.chat_id = affected_chat_id AND NOT chat.is_chat_member(t.source_chat_id, m.user_id)
    ) THEN
        RAISE EXCEPTION USING HINT = 'topic_agent_not_in_source',
            MESSAGE = 'an agent participating in a topic must be a source member';
    END IF;
    IF chat_kind IS NULL OR chat_kind <> 'group' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    SELECT count(*), min(cm.user_id), bool_and(u.type = 'human')
    INTO owner_count, owner_user_id, owner_is_human
    FROM chat.chat_members cm
    LEFT JOIN identity.users u ON u.id = cm.user_id
    WHERE cm.chat_id = affected_chat_id AND cm.role = 'owner';
    SELECT count(*) INTO member_count_val
    FROM chat.chat_members WHERE chat_id = affected_chat_id;

    IF chat_status <> 'archived' THEN
        IF owner_count <> 1 OR NOT COALESCE(owner_is_human, false) THEN
            RAISE EXCEPTION 'non-archived group chat % must have exactly 1 human owner', affected_chat_id;
        END IF;
        IF creator_user_id IS DISTINCT FROM owner_user_id THEN
            RAISE EXCEPTION 'active group chat % creator and owner must match', affected_chat_id;
        END IF;
        IF chat_status = 'active' AND member_count_val < 1 THEN
            RAISE EXCEPTION 'active group chat % must have >= 1 member (have %)', affected_chat_id, member_count_val;
        END IF;
    ELSE
        IF owner_count > 1 OR (owner_count = 1 AND NOT COALESCE(owner_is_human, false)) THEN
            RAISE EXCEPTION 'archived group chat % cannot have invalid owners', affected_chat_id;
        END IF;
        IF (owner_count = 0 AND creator_user_id IS NOT NULL)
           OR (owner_count = 1 AND creator_user_id IS DISTINCT FROM owner_user_id) THEN
            RAISE EXCEPTION 'archived group chat % creator and owner must both be absent or match', affected_chat_id;
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION chat.chats_membership_invariants() FROM PUBLIC, anon, authenticated;

-- Existing topic agents obtain real source seats through the same checked
-- admission predicate and insertion door. No direct member-table backfill.
CREATE TEMP TABLE topic_source_agent_enrollment ON COMMIT DROP AS
SELECT DISTINCT t.source_chat_id, m.user_id AS agent_id, u.owner_user_id
  FROM chat.chats t JOIN chat.chat_members m ON m.chat_id = t.id
  JOIN identity.users u ON u.id = m.user_id AND u.type = 'agent'
 WHERE t.kind = 'topic' AND NOT chat.is_chat_member(t.source_chat_id, m.user_id);
DO $enroll$
DECLARE v RECORD; v_denial TEXT;
BEGIN
    FOR v IN SELECT * FROM topic_source_agent_enrollment ORDER BY source_chat_id, agent_id LOOP
        PERFORM 1 FROM chat.chats WHERE id = v.source_chat_id FOR UPDATE;
        v_denial := chat.group_add_denial(v.source_chat_id, v.agent_id, v.owner_user_id);
        IF v_denial IS NOT NULL THEN
            RAISE EXCEPTION 'topic source enrollment refused by normal admission: %', v_denial;
        END IF;
        PERFORM chat.insert_group_member(v.source_chat_id, v.agent_id);
    END LOOP;
    IF EXISTS (SELECT 1 FROM topic_source_agent_enrollment e WHERE NOT chat.is_chat_member(e.source_chat_id, e.agent_id)) THEN
        RAISE EXCEPTION 'topic source agent enrollment did not retain every source seat';
    END IF;
END;
$enroll$;


CREATE OR REPLACE FUNCTION chat.file_place_as(p_staging_key text, p_chat_id text, p_as_user_id text, p_file_name text, p_folder text DEFAULT NULL::text, p_source_message_ids text[] DEFAULT NULL::text[]) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, parent_id uuid, system_role text, path text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_filename TEXT := btrim(COALESCE(p_file_name, ''));
    v_upload chat.file_blob_uploads%ROWTYPE;
    v_blob chat.file_blobs%ROWTYPE;
    v_parent UUID;
    v_id UUID;
BEGIN
    p_chat_id := chat.workspace_require_room_member(p_chat_id, v_actor);
    IF v_filename = '' THEN RAISE EXCEPTION USING HINT = 'file_place_invalid', MESSAGE = 'file_place_as: file name is required'; END IF;
    v_upload := chat.file_upload_take(p_staging_key);
    IF v_upload.item_id IS NOT NULL THEN
        -- 重试:上次已经放成了这个条目(同一个会话里才算;放到别处的上传不能拿来再放)。
        IF NOT EXISTS (SELECT 1 FROM chat.workspace_items w WHERE w.id = v_upload.item_id AND w.chat_id = p_chat_id) THEN
            RAISE EXCEPTION USING HINT = 'attachment_upload_used',
                MESSAGE = format('upload %s was already placed elsewhere', p_staging_key);
        END IF;
        v_id := v_upload.item_id;
    ELSE
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = v_upload.blob_id;
        v_parent := chat.workspace_folder_for(p_chat_id, p_folder, v_actor, true);
        INSERT INTO chat.workspace_items AS w (chat_id, parent_id, kind, filename, content_type, size_bytes, blob_id, source_message_ids, created_by, version)
        VALUES (p_chat_id, v_parent, 'file', v_filename, v_blob.content_type, v_blob.size_bytes, v_blob.id, COALESCE(p_source_message_ids, '{}'), v_actor, 1)
        RETURNING w.id INTO v_id;
        UPDATE chat.file_blob_uploads u SET item_id = v_id, item_version = 1 WHERE u.staging_key = p_staging_key;
    END IF;
    RETURN QUERY
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at,
           w.parent_id, w.system_role, chat.workspace_path_of(w.id)
      FROM chat.workspace_items w
     WHERE w.id = v_id;
END;
$$;

CREATE OR REPLACE FUNCTION chat.workspace_create_document_as(p_chat_id text, p_as_user_id text, p_title text, p_content text DEFAULT ''::text, p_content_type text DEFAULT NULL::text, p_source_message_ids text[] DEFAULT NULL::text[], p_folder text DEFAULT NULL::text) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, parent_id uuid, system_role text, path text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_title TEXT := btrim(COALESCE(p_title, ''));
    v_content TEXT := COALESCE(p_content, '');
    v_parent UUID;
    v_id UUID;
BEGIN
    p_chat_id := chat.workspace_require_room_member(p_chat_id, v_actor);
    IF v_title = '' THEN RAISE EXCEPTION 'workspace_create_document: title is required'; END IF;
    v_parent := chat.workspace_folder_for(p_chat_id, p_folder, v_actor, true);
    INSERT INTO chat.workspace_items AS w (chat_id, parent_id, kind, filename, content_type, inline_text, size_bytes, source_message_ids, created_by, version)
    VALUES (p_chat_id, v_parent, 'document', v_title, COALESCE(NULLIF(btrim(COALESCE(p_content_type, '')), ''), 'text/markdown'),
            v_content, octet_length(v_content), COALESCE(p_source_message_ids, '{}'), v_actor, 1)
    RETURNING w.id INTO v_id;
    RETURN QUERY
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at,
           w.parent_id, w.system_role, chat.workspace_path_of(w.id)
      FROM chat.workspace_items w
     WHERE w.id = v_id;
END;
$$;

CREATE OR REPLACE FUNCTION chat.workspace_create_file_as(p_chat_id text, p_as_user_id text, p_filename text, p_content_type text, p_size_bytes bigint, p_pointer text, p_source_message_ids text[] DEFAULT NULL::text[], p_folder text DEFAULT NULL::text) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, parent_id uuid, system_role text, path text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_filename TEXT := btrim(COALESCE(p_filename, ''));
    v_parent UUID;
    v_id UUID;
BEGIN
    p_chat_id := chat.workspace_require_room_member(p_chat_id, v_actor);
    IF v_filename = '' THEN RAISE EXCEPTION 'workspace_upload_file: file name is required'; END IF;
    -- Existing object keys stay physical addresses; their chat prefix must resolve to this same resource container.
    IF p_pointer IS NULL OR chat.workspace_require_room_member(split_part(p_pointer, '/', 1), v_actor) IS DISTINCT FROM p_chat_id THEN
        RAISE EXCEPTION 'workspace_upload_file: pointer must live under %/', p_chat_id;
    END IF;
    v_parent := chat.workspace_folder_for(p_chat_id, p_folder, v_actor, true);
    INSERT INTO chat.workspace_items AS w (chat_id, parent_id, kind, filename, content_type, size_bytes, blob_id, source_message_ids, created_by, version)
    VALUES (p_chat_id, v_parent, 'file', v_filename, COALESCE(NULLIF(btrim(COALESCE(p_content_type, '')), ''), 'application/octet-stream'),
            p_size_bytes, chat.file_blob_for_pointer(p_pointer, p_size_bytes, p_content_type, v_actor), COALESCE(p_source_message_ids, '{}'), v_actor, 1)
    RETURNING w.id INTO v_id;
    RETURN QUERY
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at,
           w.parent_id, w.system_role, chat.workspace_path_of(w.id)
      FROM chat.workspace_items w
     WHERE w.id = v_id;
END;
$$;

CREATE OR REPLACE FUNCTION chat.workspace_list_as(p_chat_id text, p_as_user_id text, p_offset integer DEFAULT 0, p_limit integer DEFAULT NULL::integer, p_name text DEFAULT NULL::text, p_kind text DEFAULT NULL::text, p_folder text DEFAULT NULL::text, p_exact boolean DEFAULT false) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, total bigint, parent_id uuid, system_role text, path text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_name TEXT := NULLIF(btrim(COALESCE(p_name, '')), '');
    v_exact BOOLEAN := COALESCE(p_exact, false);
    v_key TEXT := lower(chat.workspace_stored_name(p_name));
    v_offset INTEGER := COALESCE(p_offset, 0);
    v_all BOOLEAN := p_folder IS NULL;
    v_parent UUID;
BEGIN
    IF v_offset < 0 OR p_limit < 0 THEN
        RAISE EXCEPTION 'workspace_list: offset and limit must not be negative';
    END IF;
    IF p_kind IS NOT NULL AND p_kind NOT IN ('document', 'file', 'folder') THEN
        RAISE EXCEPTION 'workspace_list: kind must be document, file or folder, got %', p_kind;
    END IF;
    p_chat_id := chat.workspace_require_room_member(p_chat_id, v_actor);
    IF NOT v_all THEN
        v_parent := chat.workspace_folder_for(p_chat_id, p_folder, v_actor, false);
    END IF;
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT r.id AS item_id, r.filename::TEXT AS item_path, 1 AS depth
          FROM chat.workspace_items r
         WHERE r.chat_id = p_chat_id AND r.parent_id IS NULL
        UNION ALL
        SELECT c.id, t.item_path || '/' || c.filename, t.depth + 1
          FROM chat.workspace_items c
          JOIN tree t ON c.parent_id = t.item_id
         WHERE t.depth < 64
    )
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at,
           count(*) OVER (), w.parent_id, w.system_role, t.item_path
      FROM chat.workspace_items w
      JOIN tree t ON t.item_id = w.id
     WHERE w.chat_id = p_chat_id
       AND (v_all OR w.parent_id = v_parent OR (v_parent IS NULL AND w.parent_id IS NULL))
       AND (p_kind IS NULL OR w.kind = p_kind)
       AND (v_name IS NULL
            OR (v_exact AND w.name_key = v_key)
            OR (NOT v_exact AND w.filename ILIKE '%' || replace(replace(replace(v_name, '\', '\\'), '%', '\%'), '_', '\_') || '%'))
     ORDER BY w.created_at DESC, w.id DESC
    OFFSET v_offset
     LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION chat.workspace_mkdir_as(p_chat_id text, p_as_user_id text, p_path text) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, parent_id uuid, system_role text, path text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_id UUID;
BEGIN
    p_chat_id := chat.workspace_require_room_member(p_chat_id, v_actor);
    v_id := chat.workspace_folder_for(p_chat_id, p_path, v_actor, true);
    IF v_id IS NULL THEN
        RAISE EXCEPTION USING HINT = 'workspace_mkdir', MESSAGE = '要建的文件夹没有名字';
    END IF;
    RETURN QUERY
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at,
           w.parent_id, w.system_role, chat.workspace_path_of(w.id)
      FROM chat.workspace_items w
     WHERE w.id = v_id;
END;
$$;

CREATE OR REPLACE FUNCTION chat.workspace_status_as(p_chat_id text, p_as_user_id text) RETURNS TABLE(total integer, documents integer, files integer)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
BEGIN
    p_chat_id := chat.workspace_require_room_member(p_chat_id, v_actor);
    RETURN QUERY
    SELECT count(*)::INTEGER,
           (count(*) FILTER (WHERE w.kind = 'document'))::INTEGER,
           (count(*) FILTER (WHERE w.kind = 'file'))::INTEGER
      FROM chat.workspace_items w
     WHERE w.chat_id = p_chat_id;
END;
$$;

CREATE OR REPLACE FUNCTION chat.workspace_folder_for(p_chat_id text, p_folder text, p_actor text, p_create boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
    v_text TEXT := btrim(COALESCE(p_folder, ''));
    v_parent UUID := NULL;
    v_seg TEXT;
    v_row chat.workspace_items%ROWTYPE;
    v_kept UUID;
BEGIN
    p_chat_id := chat.workspace_require_room_member(p_chat_id, p_actor);
    IF v_text IN ('', '/') THEN
        RETURN NULL;
    END IF;
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT * INTO v_row FROM chat.workspace_items w WHERE w.id = v_text::uuid;
        IF NOT FOUND OR v_row.chat_id <> p_chat_id OR v_row.kind <> 'folder' THEN
            RAISE EXCEPTION USING HINT = 'workspace_folder_not_found', MESSAGE = format('找不到文件夹「%s」', p_folder);
        END IF;
        RETURN v_row.id;
    END IF;
    IF p_create THEN
        PERFORM chat.workspace_lock_chat(p_chat_id);
    END IF;
    FOREACH v_seg IN ARRAY string_to_array(v_text, '/') LOOP
        CONTINUE WHEN btrim(v_seg) = '';
        v_seg := chat.workspace_stored_name(v_seg);
        IF v_parent IS NULL AND lower(v_seg) = '附件' THEN
            SELECT * INTO v_row FROM chat.workspace_items w WHERE w.chat_id = p_chat_id AND w.system_role = 'attachments';
            IF NOT FOUND AND p_create THEN
                v_kept := chat.workspace_system_folder(p_chat_id, 'attachments');
                SELECT * INTO v_row FROM chat.workspace_items w WHERE w.id = v_kept;
            ELSIF NOT FOUND THEN
                RAISE EXCEPTION USING HINT = 'workspace_folder_not_found', MESSAGE = format('找不到文件夹「%s」', p_folder);
            END IF;
            v_parent := v_row.id;
            CONTINUE;
        END IF;
        SELECT * INTO v_row FROM chat.workspace_items w
         WHERE w.chat_id = p_chat_id
           AND (w.parent_id = v_parent OR (v_parent IS NULL AND w.parent_id IS NULL))
           AND w.name_key = lower(v_seg);
        IF NOT FOUND AND p_create THEN
            INSERT INTO chat.workspace_items AS w (chat_id, parent_id, kind, filename, content_type, source_message_ids, created_by, version)
            VALUES (p_chat_id, v_parent, 'folder', v_seg, 'inode/directory', '{}', p_actor, 1)
            RETURNING * INTO v_row;
        ELSIF NOT FOUND THEN
            RAISE EXCEPTION USING HINT = 'workspace_folder_not_found', MESSAGE = format('找不到文件夹「%s」', p_folder);
        END IF;
        IF v_row.kind <> 'folder' THEN
            RAISE EXCEPTION USING HINT = 'workspace_not_a_folder', MESSAGE = format('「%s」是文件,不是文件夹', v_seg);
        END IF;
        v_parent := v_row.id;
    END LOOP;
    RETURN v_parent;
END;
$_$;

CREATE OR REPLACE FUNCTION chat.workspace_replace_file_as(p_item_id text, p_as_user_id text, p_pointer text, p_size_bytes bigint, p_content_type text DEFAULT NULL::text, p_expected_version integer DEFAULT NULL::integer) RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, pruned_pointers text[], parent_id uuid, system_role text, path text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_keep CONSTANT INTEGER := 50;
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_item chat.workspace_items%ROWTYPE;
    v_type TEXT;
    v_next INTEGER;
    v_pruned TEXT[];
    v_blob UUID;
BEGIN
    v_item := chat.workspace_item_for(p_item_id, v_actor, true);
    IF v_item.kind <> 'file' THEN
        RAISE EXCEPTION 'workspace_replace_file: % is a live text file; change it through the file service', p_item_id;
    END IF;
    IF p_pointer IS NULL OR chat.workspace_require_room_member(split_part(p_pointer, '/', 1), v_actor) IS DISTINCT FROM v_item.chat_id THEN
        RAISE EXCEPTION 'workspace_replace_file: pointer must live under %/', v_item.chat_id;
    END IF;
    IF p_pointer = chat.file_blob_pointer(v_item.blob_id) THEN
        RAISE EXCEPTION 'workspace_replace_file: that is the content the file already has';
    END IF;
    IF p_size_bytes IS NULL OR p_size_bytes < 0 THEN
        RAISE EXCEPTION 'workspace_replace_file: size_bytes is required';
    END IF;
    IF p_expected_version IS NOT NULL AND p_expected_version <> v_item.version THEN
        RAISE EXCEPTION 'workspace item % version conflict: expected %, got %', p_item_id, p_expected_version, v_item.version
            USING HINT = 'workspace_version_conflict', DETAIL = v_item.version::TEXT;
    END IF;
    v_type := COALESCE(NULLIF(btrim(COALESCE(p_content_type, '')), ''), v_item.content_type);
    v_next := v_item.version + 1;

    INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
    VALUES (v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at)
    ON CONFLICT ON CONSTRAINT workspace_item_versions_pkey DO NOTHING;
    v_blob := chat.file_blob_for_pointer(p_pointer, p_size_bytes, v_type, v_actor);
    INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by)
    VALUES (v_item.id, v_next, v_blob, v_type, p_size_bytes, v_actor);

    UPDATE chat.workspace_items w
       SET blob_id = v_blob, size_bytes = p_size_bytes, content_type = v_type, version = v_next
     WHERE w.id = v_item.id;

    WITH gone AS (
        DELETE FROM chat.workspace_item_versions v
         WHERE v.item_id = v_item.id
           AND v.n NOT IN (SELECT k.n FROM chat.workspace_item_versions k WHERE k.item_id = v_item.id ORDER BY k.n DESC LIMIT v_keep)
           AND NOT EXISTS (SELECT 1 FROM chat.messages m WHERE m.file_item_id = v.item_id AND m.file_version = v.n)
        RETURNING v.blob_id
    )
    SELECT COALESCE(array_agg(chat.file_blob_pointer(g.blob_id)) FILTER (WHERE chat.file_blob_pointer(g.blob_id) IS NOT NULL), '{}') INTO v_pruned FROM gone g;

    RETURN QUERY
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at, v_pruned,
           w.parent_id, w.system_role, chat.workspace_path_of(w.id)
      FROM chat.workspace_items w
     WHERE w.id = v_item.id;
END;
$$;

CREATE OR REPLACE FUNCTION chat.attachment_sender_check(p_chat_id text, p_sender_user_id text) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
    IF (SELECT auth.uid()) IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT chat.is_acting_as(p_sender_user_id) THEN
        RAISE EXCEPTION 'Not allowed to act as %', COALESCE(p_sender_user_id, '<null>');
    END IF;
    PERFORM chat.workspace_require_room_member(p_chat_id, p_sender_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION chat.attachment_item_for(p_chat_id text, p_blob_id uuid, p_file_name text, p_sender_user_id text, p_message_id text) RETURNS chat.workspace_items
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_blob chat.file_blobs%ROWTYPE;
    v_folder UUID;
    v_stored TEXT := chat.workspace_stored_name(p_file_name);
    v_item chat.workspace_items%ROWTYPE;
BEGIN
    p_chat_id := chat.workspace_require_room_member(p_chat_id, p_sender_user_id);
    PERFORM chat.file_blob_take(p_blob_id);
    SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = p_blob_id;
    v_folder := chat.workspace_system_folder(p_chat_id, 'attachments');
    SELECT * INTO v_item FROM chat.workspace_items w
     WHERE w.chat_id = p_chat_id AND w.parent_id = v_folder AND w.kind = 'file' AND w.blob_id = p_blob_id
       AND chat.workspace_same_series(w.name_key, v_stored)
     ORDER BY w.created_at, w.id
     LIMIT 1
       FOR UPDATE;
    IF FOUND THEN
        UPDATE chat.workspace_items w
           SET source_message_ids = CASE WHEN p_message_id = ANY (w.source_message_ids) THEN w.source_message_ids
                                         ELSE array_append(w.source_message_ids, p_message_id) END
         WHERE w.id = v_item.id
        RETURNING * INTO v_item;
        RETURN v_item;
    END IF;
    INSERT INTO chat.workspace_items AS w (chat_id, parent_id, kind, filename, content_type, size_bytes, blob_id, source_message_ids, created_by, version)
    VALUES (p_chat_id, v_folder, 'file', v_stored, v_blob.content_type, v_blob.size_bytes, v_blob.id, ARRAY[p_message_id], p_sender_user_id, 1)
    RETURNING * INTO v_item;
    RETURN v_item;
END;
$$;

CREATE OR REPLACE FUNCTION chat.messages_file_ref() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_item chat.workspace_items%ROWTYPE;
    v_blob chat.file_blobs%ROWTYPE;
    v_source chat.messages%ROWTYPE;
    v_envelope TEXT;
    v_resource TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- 发出去以后不能改指向;删文件时外键把 file_item_id 清空(墓碑)是唯一的变化。
        IF NEW.file_version IS DISTINCT FROM OLD.file_version
           OR (NEW.file_item_id IS DISTINCT FROM OLD.file_item_id AND NEW.file_item_id IS NOT NULL)
           -- ◇ 悄悄话附件指着的那份字节也不能改。
           OR NEW.file_blob_id IS DISTINCT FROM OLD.file_blob_id THEN
            RAISE EXCEPTION USING HINT = 'message_file_fixed', MESSAGE = 'an attachment keeps the file version it was sent with';
        END IF;
        -- 正文和类型也不能改(墓碑也一样):authenticated 本来就能改自己消息的正文(编辑),而老客户端照正文画名字、大小和 [URL],
        -- 新客户端照条目读字节 —— 改了正文,同一条消息两边看到两样东西。撤回只写 retracted_at,不经过这里。
        IF (OLD.file_item_id IS NOT NULL OR OLD.file_version IS NOT NULL OR OLD.file_blob_id IS NOT NULL)
           AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.content_type IS DISTINCT FROM OLD.content_type) THEN
            RAISE EXCEPTION USING HINT = 'message_file_fixed', MESSAGE = 'an attachment''s text is fixed once it is sent';
        END IF;
        RETURN NEW;
    END IF;
    -- ◇ 悄悄话附件:消息直接指字节。形状(悄悄话、没有条目)由 CHECK messages_file_blob_shape 管。
    IF NEW.file_blob_id IS NOT NULL THEN
        -- 先锁住、核它没在回收(同条目那一路的 file_blob_take)。
        PERFORM chat.file_blob_take(NEW.file_blob_id);
        -- 字节从哪来:这条消息自己消费的那次上传,或者发送者读得到、指着同一份字节的源消息。
        IF NOT EXISTS (SELECT 1 FROM chat.file_blob_uploads u WHERE u.message_id = NEW.id AND u.blob_id = NEW.file_blob_id) THEN
            IF NEW.forwarded_from_message_id IS NOT NULL
               AND chat.can_read_message(NEW.forwarded_from_message_id, NEW.sender_user_id) THEN
                SELECT * INTO v_source FROM chat.messages s WHERE s.id = NEW.forwarded_from_message_id AND s.retracted_at IS NULL;
            END IF;
            IF v_source.id IS NULL
               OR COALESCE(v_source.file_blob_id, chat.workspace_version_blob(v_source.file_item_id, v_source.file_version))
                  IS DISTINCT FROM NEW.file_blob_id THEN
                RAISE EXCEPTION USING HINT = 'message_file_not_here',
                    MESSAGE = 'a whisper attachment carries bytes uploaded for it, or forwards the bytes of an unretracted message its sender can read';
            END IF;
        END IF;
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = NEW.file_blob_id;
        IF NEW.content_type IS DISTINCT FROM 'attachment'
           OR chat.attachment_envelope_name(chat.attachment_text_envelope(NEW.content), v_blob.size_bytes, v_blob.content_type) IS NULL THEN
            RAISE EXCEPTION USING HINT = 'message_file_envelope',
                MESSAGE = format('an attachment''s text is its file''s envelope: %s',
                                 chat.attachment_envelope('<name>', v_blob.size_bytes, v_blob.content_type));
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.file_item_id IS NULL THEN
        IF NEW.file_version IS NOT NULL THEN
            RAISE EXCEPTION USING HINT = 'message_file_not_here', MESSAGE = 'an attachment''s version needs its file';
        END IF;
        RETURN NEW;
    END IF;
    -- FOR SHARE:换版本那边(workspace_replace_file_as)先对条目拿 FOR UPDATE、修剪历史;这里排在它后面,拿到锁时它已提交,
    -- 下一句用新快照,看得到修剪以后的历史 —— 钉的那一版已经裁掉就拒。只靠外键的 KEY SHARE 不排队:两边都成功,
    -- 消息钉着一版历史里已经没有的字节,回收随后把它删掉(复核 L11 两个连接实测)。反过来这边先到,修剪等这边提交、看得见钉住。
    v_resource := chat.workspace_require_room_member(NEW.chat_id, NEW.sender_user_id);
    SELECT * INTO v_item FROM chat.workspace_items w WHERE w.id = NEW.file_item_id FOR SHARE;
    IF NOT FOUND OR v_item.chat_id IS DISTINCT FROM v_resource OR v_item.kind <> 'file' THEN
        RAISE EXCEPTION USING HINT = 'message_file_not_here',
            MESSAGE = 'an attachment points at a file in its source chat''s folder';
    END IF;
    NEW.file_version := COALESCE(NEW.file_version, v_item.version);
    v_envelope := chat.workspace_version_envelope(v_item.id, NEW.file_version);
    IF v_envelope IS NULL THEN
        RAISE EXCEPTION USING HINT = 'message_file_not_here',
            MESSAGE = format('version %s of that file has no bytes to send', NEW.file_version);
    END IF;
    IF NEW.content_type IS DISTINCT FROM 'attachment' OR chat.attachment_text_envelope(NEW.content) IS DISTINCT FROM v_envelope THEN
        RAISE EXCEPTION USING HINT = 'message_file_envelope',
            MESSAGE = format('an attachment''s text is its file''s envelope: %s', v_envelope);
    END IF;
    -- ◇ 钉住条目现在那一版:写进历史(还没有的话)。改名、移动只升版本、不写历史,不记的话那一版的字节就只挂在条目上,
    -- 下一次改名以后 chat.workspace_version_blob 找不到它。写法同 workspace_replace_file_as 补旧版本那一句。
    IF NEW.file_version = v_item.version THEN
        INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
        VALUES (v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at)
        ON CONFLICT ON CONSTRAINT workspace_item_versions_pkey DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION chat.workspace_items_place() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_parent chat.workspace_items%ROWTYPE;
    v_name TEXT;
    v_above INTEGER := 0;
    v_cycle BOOLEAN := false;
    v_below INTEGER := 0;
    v_system BOOLEAN;
BEGIN
    IF EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = NEW.chat_id AND c.kind = 'topic') THEN
        RAISE EXCEPTION USING HINT = 'workspace_topic_container',
            MESSAGE = 'topic files belong to their source chat';
    END IF;
    v_system := NEW.system_role IS NOT NULL;
    IF TG_OP = 'UPDATE'
       AND NEW.filename IS NOT DISTINCT FROM OLD.filename
       AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id
       AND NEW.chat_id IS NOT DISTINCT FROM OLD.chat_id
       AND NEW.kind IS NOT DISTINCT FROM OLD.kind
       AND NEW.system_role IS NOT DISTINCT FROM OLD.system_role THEN
        RETURN NEW;
    END IF;

    -- 读树之前:这个对话的锁。
    PERFORM chat.workspace_lock_chat(NEW.chat_id);

    IF TG_OP = 'UPDATE' THEN
        IF OLD.system_role IS NOT NULL AND (
               NEW.filename IS DISTINCT FROM OLD.filename
            OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
            OR NEW.system_role IS DISTINCT FROM OLD.system_role
            OR NEW.kind IS DISTINCT FROM OLD.kind
            OR NEW.chat_id IS DISTINCT FROM OLD.chat_id) THEN
            RAISE EXCEPTION USING HINT = 'workspace_system_folder',
                MESSAGE = '「附件」是系统文件夹,不能改名、移动或删除;里面的文件照常管';
        END IF;
        IF (OLD.kind = 'folder') <> (NEW.kind = 'folder') THEN
            RAISE EXCEPTION USING HINT = 'workspace_bad_kind', MESSAGE = '文件夹不能变成文件,文件也不能变成文件夹';
        END IF;
        IF NEW.chat_id IS DISTINCT FROM OLD.chat_id
           AND (NEW.parent_id IS NOT NULL OR EXISTS (SELECT 1 FROM chat.workspace_items c WHERE c.parent_id = OLD.id)) THEN
            RAISE EXCEPTION USING HINT = 'workspace_bad_parent', MESSAGE = '文件夹里的东西、或装着东西的文件夹,不能挪到别的对话';
        END IF;
        IF NEW.filename IS NOT DISTINCT FROM OLD.filename
           AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id
           AND NEW.chat_id IS NOT DISTINCT FROM OLD.chat_id THEN
            RETURN NEW;
        END IF;
    END IF;

    v_name := chat.workspace_stored_name(NEW.filename);

    IF NEW.parent_id IS NOT NULL THEN
        SELECT * INTO v_parent FROM chat.workspace_items w WHERE w.id = NEW.parent_id;
        IF NOT FOUND OR v_parent.chat_id <> NEW.chat_id OR v_parent.kind <> 'folder' THEN
            RAISE EXCEPTION USING HINT = 'workspace_bad_parent', MESSAGE = '要放进去的地方不是这个对话里的文件夹';
        END IF;
        -- 新位置上面有几层文件夹;往上走的路上碰到自己 = 把文件夹放进它自己里面。
        WITH RECURSIVE up AS (
            SELECT w.id, w.parent_id, 1 AS depth FROM chat.workspace_items w WHERE w.id = NEW.parent_id
            UNION ALL
            SELECT p.id, p.parent_id, up.depth + 1 FROM chat.workspace_items p JOIN up ON p.id = up.parent_id WHERE up.depth < 64
        )
        SELECT max(up.depth), COALESCE(bool_or(up.id = NEW.id), false) INTO v_above, v_cycle FROM up;
        IF v_cycle THEN
            RAISE EXCEPTION USING HINT = 'workspace_bad_parent', MESSAGE = '不能把文件夹放进它自己里面';
        END IF;
    END IF;
    -- 跟着一起动的:一个文件夹自己下面有几层。
    IF TG_OP = 'UPDATE' AND NEW.kind = 'folder' THEN
        WITH RECURSIVE down AS (
            SELECT c.id, 1 AS depth FROM chat.workspace_items c WHERE c.parent_id = NEW.id
            UNION ALL
            SELECT c.id, down.depth + 1 FROM chat.workspace_items c JOIN down ON c.parent_id = down.id WHERE down.depth < 64
        )
        SELECT COALESCE(max(down.depth), 0) INTO v_below FROM down;
    END IF;
    IF v_above + 1 + v_below > 16 THEN
        RAISE EXCEPTION USING HINT = 'workspace_too_deep', MESSAGE = '文件夹最多套 16 层';
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.filename := chat.workspace_place_item(NEW.chat_id, NEW.parent_id, v_name, NULL, v_system);
    ELSE
        IF chat.workspace_name_taken(NEW.chat_id, NEW.parent_id, v_name, NEW.id, v_system) THEN
            RAISE EXCEPTION USING ERRCODE = 'unique_violation', HINT = 'workspace_name_taken',
                MESSAGE = format('这个文件夹里已经有「%s」了', v_name);
        END IF;
        NEW.filename := v_name;
    END IF;
    RETURN NEW;
END;
$$;

-- Restore existing public grants after the fail-closed DDL event trigger.
GRANT ALL ON FUNCTION chat.file_place_as(p_staging_key text, p_chat_id text, p_as_user_id text, p_file_name text, p_folder text, p_source_message_ids text[]) TO authenticated;
GRANT ALL ON FUNCTION chat.workspace_create_document_as(p_chat_id text, p_as_user_id text, p_title text, p_content text, p_content_type text, p_source_message_ids text[], p_folder text) TO authenticated;
GRANT ALL ON FUNCTION chat.workspace_create_file_as(p_chat_id text, p_as_user_id text, p_filename text, p_content_type text, p_size_bytes bigint, p_pointer text, p_source_message_ids text[], p_folder text) TO authenticated;
GRANT ALL ON FUNCTION chat.workspace_list_as(p_chat_id text, p_as_user_id text, p_offset integer, p_limit integer, p_name text, p_kind text, p_folder text, p_exact boolean) TO authenticated;
GRANT ALL ON FUNCTION chat.workspace_mkdir_as(p_chat_id text, p_as_user_id text, p_path text) TO authenticated;
GRANT ALL ON FUNCTION chat.workspace_status_as(p_chat_id text, p_as_user_id text) TO authenticated;
GRANT ALL ON FUNCTION chat.workspace_replace_file_as(p_item_id text, p_as_user_id text, p_pointer text, p_size_bytes bigint, p_content_type text, p_expected_version integer) TO authenticated;
GRANT ALL ON FUNCTION chat.create_topic(p_source_chat_id text, p_source_message_id text, p_name text, p_member_user_ids text[], p_as_user_id text) TO service_role;
GRANT ALL ON FUNCTION chat.create_topic(p_source_chat_id text, p_source_message_id text, p_name text, p_member_user_ids text[], p_as_user_id text) TO authenticated;
GRANT ALL ON FUNCTION chat.chat_facts(p_chat_id text, p_as_user_id text) TO service_role;
GRANT ALL ON FUNCTION chat.chat_facts(p_chat_id text, p_as_user_id text) TO authenticated;
GRANT ALL ON FUNCTION chat.create_gugu_group(p_chat_id text, p_name text, p_owner_user_id text, p_initial_members jsonb, p_default_agent_type text, p_group_prompt text) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.add_group_agent(TEXT,TEXT,TEXT,TEXT,BOOLEAN) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.group_add_denial(TEXT,TEXT,TEXT,BOOLEAN,BOOLEAN) TO service_role;

-- Participation changes do not revoke source-chat file access.
CREATE OR REPLACE FUNCTION chat.notify_files_member_removed() RETURNS trigger
    LANGUAGE plpgsql SET search_path TO ''
    AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = OLD.chat_id AND c.kind <> 'topic') THEN
        PERFORM pg_notify('files_member_removed', OLD.chat_id || ':' || OLD.user_id);
    END IF;
    RETURN OLD;
END;
$$;


-- Storage keeps historical keys. Resolve their prefix using the existing,
-- caller-visible raw chat row, then apply the ordinary source membership test.
-- The internal resource helper stays closed to authenticated/anon callers.


ALTER POLICY workspace_select_member ON storage.objects USING (bucket_id = 'workspace' AND chat.is_member((SELECT COALESCE(c.source_chat_id, c.id) FROM chat.chats c WHERE c.id = (storage.foldername(name))[1])));

ALTER POLICY workspace_delete_owner ON storage.objects USING (bucket_id = 'workspace' AND chat.is_member((SELECT COALESCE(c.source_chat_id, c.id) FROM chat.chats c WHERE c.id = (storage.foldername(name))[1])) AND NOT chat.workspace_pointer_in_use(name));

ALTER POLICY workspace_insert_member ON storage.objects WITH CHECK (bucket_id = 'workspace' AND chat.is_member((SELECT COALESCE(c.source_chat_id, c.id) FROM chat.chats c WHERE c.id = (storage.foldername(name))[1])) AND (storage.foldername(name))[2] = (SELECT auth.uid()::text));

ALTER POLICY workspace_update_owner ON storage.objects USING (bucket_id = 'workspace' AND chat.is_member((SELECT COALESCE(c.source_chat_id, c.id) FROM chat.chats c WHERE c.id = (storage.foldername(name))[1])) AND (storage.foldername(name))[2] = (SELECT auth.uid()::text)) WITH CHECK (bucket_id = 'workspace' AND chat.is_member((SELECT COALESCE(c.source_chat_id, c.id) FROM chat.chats c WHERE c.id = (storage.foldername(name))[1])) AND (storage.foldername(name))[2] = (SELECT auth.uid()::text));

-- Upgrade only metadata. Hold the item table lock while temporarily removing
-- the two placement/system-folder guards; retain all foreign keys and byte pins.
-- Tables are transaction-local and disappear on commit or rollback.
CREATE TEMP TABLE topic_resource_move ON COMMIT DROP AS
WITH RECURSIVE tree AS (
    SELECT w.id, 1 AS depth
      FROM chat.workspace_items w JOIN chat.chats c ON c.id = w.chat_id AND c.kind = 'topic'
     WHERE w.parent_id IS NULL
    UNION ALL
    SELECT w.id, p.depth + 1 FROM chat.workspace_items w
      JOIN tree p ON p.id = w.parent_id WHERE p.depth < 64
)
SELECT w.id, w.chat_id, c.source_chat_id AS resource_id, w.parent_id,
       w.filename, w.kind, w.system_role, w.created_at, t.depth,
       to_jsonb(w) - ARRAY['chat_id','parent_id','filename','name_key'] AS preserved
  FROM chat.workspace_items w JOIN chat.chats c ON c.id = w.chat_id AND c.kind = 'topic'
  LEFT JOIN tree t ON t.id = w.id;
ALTER TABLE topic_resource_move ADD PRIMARY KEY (id);
CREATE TEMP TABLE topic_resource_system (old_id uuid PRIMARY KEY, target_id uuid NOT NULL) ON COMMIT DROP;

DO $validate$
BEGIN
    IF EXISTS (SELECT 1 FROM topic_resource_move m LEFT JOIN chat.chats c ON c.id = m.resource_id
               WHERE m.depth IS NULL OR c.kind IS NULL OR c.kind NOT IN ('group','dm','ai')) THEN
        RAISE EXCEPTION 'topic resources have an invalid source or unreachable tree; no resources were moved';
    END IF;
END;
$validate$;

ALTER TABLE chat.workspace_items DISABLE TRIGGER workspace_items_place;
ALTER TABLE chat.workspace_items DISABLE TRIGGER workspace_items_guard_delete;

DO $move$
DECLARE
    v RECORD;
    v_target UUID;
    v_parent UUID;
    v_name TEXT;
BEGIN
    -- Keep the source's folder; otherwise adopt the oldest topic folder's ID.
    FOR v IN SELECT * FROM topic_resource_move WHERE system_role = 'attachments'
              ORDER BY resource_id, created_at, id LOOP
        SELECT w.id INTO v_target FROM chat.workspace_items w
         WHERE w.chat_id = v.resource_id AND w.system_role = 'attachments';
        IF v_target IS NULL THEN
            UPDATE chat.workspace_items SET chat_id = v.resource_id WHERE id = v.id;
            v_target := v.id;
        END IF;
        INSERT INTO topic_resource_system VALUES (v.id, v_target);
    END LOOP;

    -- Never silently discard content, versions or external database references
    -- on a redundant system directory, even if an unexpected installation has them.
    IF EXISTS (
        SELECT 1 FROM topic_resource_system s JOIN chat.workspace_items w ON w.id = s.old_id
         WHERE s.old_id <> s.target_id AND (
             w.ystate IS NOT NULL OR w.blob_id IS NOT NULL OR w.inline_text IS NOT NULL
             OR cardinality(w.source_message_ids) > 0 OR w.app_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM chat.workspace_item_versions h WHERE h.item_id = w.id)
             OR EXISTS (SELECT 1 FROM chat.workspace_item_opens o WHERE o.item_id = w.id)
             OR EXISTS (SELECT 1 FROM chat.file_blob_uploads u WHERE u.item_id = w.id)
             OR EXISTS (SELECT 1 FROM chat.messages m WHERE m.file_item_id = w.id)
         )
    ) THEN
        RAISE EXCEPTION 'a redundant topic system folder has content or references; no resources were moved';
    END IF;

    -- Parent IDs of user directories survive; move parents before their children.
    -- Reuse the existing allocator, preserving the source's names and every file.
    FOR v IN SELECT * FROM topic_resource_move WHERE system_role IS NULL
              ORDER BY depth, resource_id, created_at, id LOOP
        SELECT COALESCE(s.target_id, v.parent_id) INTO v_parent
          FROM (SELECT 1) unused LEFT JOIN topic_resource_system s ON s.old_id = v.parent_id;
        v_name := chat.workspace_place_item(v.resource_id, v_parent, v.filename, v.id, false);
        UPDATE chat.workspace_items
           SET chat_id = v.resource_id, parent_id = v_parent, filename = v_name
         WHERE id = v.id;
    END LOOP;
    DELETE FROM chat.workspace_items w USING topic_resource_system s
     WHERE w.id = s.old_id AND s.old_id <> s.target_id;
END;
$move$;

ALTER TABLE chat.workspace_items ENABLE TRIGGER workspace_items_place;
ALTER TABLE chat.workspace_items ENABLE TRIGGER workspace_items_guard_delete;

DO $verify$
BEGIN
    IF EXISTS (
        SELECT 1 FROM chat.chats t JOIN chat.chat_members m ON m.chat_id = t.id
        JOIN identity.users u ON u.id = m.user_id AND u.type = 'agent'
        WHERE t.kind = 'topic' AND NOT chat.is_chat_member(t.source_chat_id, m.user_id)
    ) THEN
        RAISE EXCEPTION 'topic source enrollment left an agent without a source seat';
    END IF;
    IF EXISTS (SELECT 1 FROM chat.workspace_items w JOIN chat.chats c ON c.id = w.chat_id AND c.kind = 'topic')
       OR EXISTS (SELECT 1 FROM chat.workspace_items w JOIN chat.workspace_items p ON p.id = w.parent_id WHERE w.chat_id <> p.chat_id)
       OR EXISTS (
           SELECT 1 FROM topic_resource_move m LEFT JOIN chat.workspace_items w ON w.id = m.id
            WHERE (m.system_role IS NULL OR EXISTS (SELECT 1 FROM topic_resource_system s WHERE s.old_id = m.id AND s.target_id = m.id))
              AND (w.id IS NULL OR w.chat_id IS DISTINCT FROM m.resource_id
                   OR (to_jsonb(w) - ARRAY['chat_id','parent_id','filename','name_key']) IS DISTINCT FROM m.preserved)
       ) THEN
        RAISE EXCEPTION 'topic resource migration did not preserve resource identity and content';
    END IF;
END;
$verify$;

-- Reuse the existing revocation channel to refresh already-open connections
-- after their container changes. The paired file service rechecks current items.
SELECT pg_notify('files_member_removed', '');

COMMENT ON COLUMN chat.chats.source_chat_id IS 'For a topic: its source message stream and sole shared resource container. Topic chat_members are participation/subscription, not file membership.';
