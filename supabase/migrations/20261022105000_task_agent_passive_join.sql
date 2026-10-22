-- 任务 agent 进群:被动、不发「加入了群聊」(gugu-dev#181「项目群并入项目页」)。
--
-- 一个任务一个 agent。任务 agent 进群默认「主动」时,一个项目开到第 6 个任务就触发「群里 agent 超过 5 个、
-- 全体转被动」;而任务 agent 要接的只有 @ 它的话和它自己那张任务卡,本来就是被动档的行为。
-- 群里那张任务卡已经写了「交给谁」,再出一行「X 加入了群聊」是重复。
--
-- 「加入了群聊」从 chat_members 的语句级触发器搬进入群的唯一入口 chat.insert_group_member:#8 起客户端不能
-- 直插成员表,往已有的群里加人全走它(拉 agent、邀请、接受邀请、审批入群);建群时写进去的群主与初始成员
-- 不走它,和以前一样不发。提不提示由调用方用 p_announce 说清楚 —— 任务路径传 false,其余入口不传,照旧提示。
-- 每次入群一行(以前一条语句插多人会合成一行,但没有哪个入口一条语句插多人)。
--
-- 进别人开了「Agent 加入需审批」的群,任务 agent 先排队。群主同意时宿主不一定在线,所以「这次入群要哪一档」
-- 是这条入群请求本身的数据:记在 group_join_requests.requested_listen_mode 上,审批通过时照它入座。

ALTER TABLE chat.group_join_requests
    ADD COLUMN requested_listen_mode TEXT NOT NULL DEFAULT 'active'
    CONSTRAINT group_join_requests_requested_listen_mode_chk CHECK (requested_listen_mode IN ('active', 'passive'));
COMMENT ON COLUMN chat.group_join_requests.requested_listen_mode IS
    '审批通过后以哪一档入座。任务 agent 排队时为 passive,其余入口为 active。';

DROP FUNCTION chat.queue_agent_join_request(TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION chat.queue_agent_join_request(
    p_chat_id TEXT, p_agent_user_id TEXT, p_requested_by TEXT, p_message TEXT, p_listen_mode TEXT DEFAULT 'active'
) RETURNS TEXT
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_id TEXT;
BEGIN
    -- 再排一次是一条新的请求:附言、发起人、要的档位都以这一次为准。
    INSERT INTO chat.group_join_requests (chat_id, requester_user_id, requested_by_user_id, message, status, requested_listen_mode)
    VALUES (p_chat_id, p_agent_user_id, p_requested_by, NULLIF(btrim(COALESCE(p_message, '')), ''), 'pending', p_listen_mode)
    ON CONFLICT ON CONSTRAINT group_join_requests_unique DO UPDATE
        SET status = 'pending',
            requested_by_user_id = EXCLUDED.requested_by_user_id,
            message = EXCLUDED.message,
            requested_listen_mode = EXCLUDED.requested_listen_mode,
            updated_at = now()
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION chat.queue_agent_join_request(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION chat.queue_agent_join_request(TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

DROP TRIGGER chat_members_announce_group_joins ON chat.chat_members;
DROP FUNCTION chat.announce_group_member_joins();

DROP FUNCTION chat.insert_group_member(TEXT, TEXT);
CREATE FUNCTION chat.insert_group_member(
    p_chat_id TEXT, p_user_id TEXT, p_listen_mode TEXT DEFAULT 'active', p_announce BOOLEAN DEFAULT true
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_joined BOOLEAN; v_message_id TEXT;
BEGIN
    -- 已经在群里的不动:他现在的档位是群主或 agent 主人定的;也不再发一行提示。
    INSERT INTO chat.chat_members(chat_id, user_id, role, listen_mode)
    VALUES (p_chat_id, p_user_id, 'member', p_listen_mode)
    ON CONFLICT (chat_id, user_id) DO NOTHING;
    v_joined := FOUND;
    IF chat.is_agent_user(p_user_id) THEN
        INSERT INTO chat.group_agent_states(chat_id,agent_user_id,functional_role,capability_roles,last_action,updated_at)
        VALUES (p_chat_id,p_user_id,'member',ARRAY['member']::TEXT[],'已加入群聊',now())
        ON CONFLICT (chat_id,agent_user_id) DO NOTHING;
    END IF;
    -- #6386 入群灰字:没有发信人、不点名,所以不唤醒任何 agent(#6860);入群者 id 编在 client_message_id
    -- (member-joined:<消息 id>:<uid>),客户端据此画可点的 @。私聊、话题没有这一行。
    IF v_joined AND p_announce AND EXISTS (SELECT 1 FROM chat.chats WHERE id = p_chat_id AND kind = 'group') THEN
        v_message_id := gen_random_uuid()::text;
        INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, client_message_id)
        VALUES (
            v_message_id, p_chat_id, NULL,
            COALESCE((SELECT NULLIF(trim(u.display_name), '') FROM identity.users u WHERE u.id = p_user_id), '新成员') || ' 加入了群聊',
            'system',
            'member-joined:' || v_message_id || ':' || p_user_id
        );
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION chat.insert_group_member(TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- 审批通过入群:与其它入口同走 chat.insert_group_member(原来这里是同样的两句直插),按请求要的档位入座。
CREATE OR REPLACE FUNCTION chat.decide_group_join(p_request_id TEXT, p_accept BOOLEAN, p_as_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = chat, identity, public, pg_catalog
AS $$
DECLARE
    v_me TEXT := chat.require_group_actor(p_as_user_id);
    v_req chat.group_join_requests%ROWTYPE;
    v_type TEXT;
    v_agent_owner TEXT;
    v_denial TEXT;
BEGIN
    IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT * INTO v_req FROM chat.group_join_requests WHERE id = p_request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Join request not found'; END IF;
    PERFORM 1 FROM chat.chats WHERE id = v_req.chat_id FOR UPDATE;
    PERFORM chat.require_group_manager(v_req.chat_id, v_me);
    SELECT * INTO v_req FROM chat.group_join_requests WHERE id = p_request_id FOR UPDATE;
    IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'Join request already decided'; END IF;

    IF NOT p_accept THEN
        UPDATE chat.group_join_requests SET status = 'rejected', updated_at = now() WHERE id = p_request_id;
        RETURN jsonb_build_object('request_id', p_request_id, 'chat_id', v_req.chat_id, 'status', 'rejected');
    END IF;

    SELECT u.type, u.owner_user_id INTO v_type, v_agent_owner FROM identity.users u WHERE u.id = v_req.requester_user_id;
    IF v_type = 'agent' THEN
        -- 等待期间事实可能变了:发起人退群 / agent 的主人不在群里了 ⇒ 这条请求不再成立。
        IF v_req.requested_by_user_id IS NOT NULL
           AND NOT chat.is_chat_member(v_req.chat_id, v_req.requested_by_user_id)
           AND NOT EXISTS (SELECT 1 FROM identity.users a WHERE a.id = v_req.requested_by_user_id
               AND a.type = 'agent' AND a.owner_user_id = v_agent_owner) THEN
            RAISE EXCEPTION 'join_request_requester_left';
        END IF;
        IF v_agent_owner IS NULL OR NOT chat.is_chat_member(v_req.chat_id, v_agent_owner) THEN
            RAISE EXCEPTION 'join_request_agent_owner_left';
        END IF;
    END IF;

    -- 按审批人身份判:审批人是管理员 ⇒ 邀请开关与 agent 审批放行,剩下上限 / 云 agent / 群状态。
    -- agent 归属:审批人不是 agent 的主人,但这条请求只可能由 queue_agent_join_request 落下
    -- (requested_by_user_id 非空),三个入队口子都已核过主人本人发起或主人已接受邀请 ⇒ 带上主人同意。
    -- requested_by 为空的 agent 请求没有这份同意 ⇒ 照常按归属拒。
    v_denial := chat.group_add_denial(v_req.chat_id, v_req.requester_user_id, v_me, true,
                                      v_type = 'agent' AND v_req.requested_by_user_id IS NOT NULL);
    IF v_denial IS NOT NULL THEN RAISE EXCEPTION '%', v_denial; END IF;

    PERFORM chat.insert_group_member(v_req.chat_id, v_req.requester_user_id, v_req.requested_listen_mode);
    UPDATE chat.group_join_requests SET status = 'accepted', updated_at = now() WHERE id = p_request_id;
    RETURN jsonb_build_object('request_id', p_request_id, 'chat_id', v_req.chat_id, 'status', 'accepted');
END;
$$;
REVOKE ALL ON FUNCTION chat.decide_group_join(TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.decide_group_join(TEXT, BOOLEAN, TEXT) TO authenticated;

-- 任务路径:新座位走 chat.insert_group_member(被动、不提示);项目群还不存在时先建只有群主的群再入座(#8 已允许)。
-- ❌ 不再对已经在群里的成员强制设回「主动」。
-- 这里要 CREATE OR REPLACE 整个函数体:PostgreSQL 只能整段替换函数定义,真正改的只有入座那三处、排队时要的档位
-- 和删掉的强制 UPDATE。
CREATE OR REPLACE FUNCTION identity.provision_taskpage_agent(p_agent_id uuid, p_display_name text, p_name_mode text, p_agent_type text, p_device_id text, p_local_path text DEFAULT NULL::text, p_group_chat_id text DEFAULT NULL::text, p_new_group_id text DEFAULT NULL::text, p_group_name text DEFAULT NULL::text) RETURNS TABLE(agent_id uuid, display_name text, group_chat_id text, group_created boolean, prior_group_state text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'identity', 'chat', 'public', 'pg_catalog'
    AS $_$
DECLARE
    v_owner      TEXT := (SELECT auth.uid()::text);
    v_name       TEXT := btrim(coalesce(p_display_name, ''));
    v_parts      TEXT[];
    v_base       TEXT;
    v_serial     INTEGER;
    v_minted     RECORD;
    v_prior      TEXT := 'none';
    v_group      TEXT := '';
    v_created    BOOLEAN := false;
    v_status     TEXT;
    v_target     TEXT;
    v_kind       TEXT;
    v_denial     TEXT;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'provision_taskpage_agent requires authenticated session';
    END IF;
    IF v_name = '' THEN
        RAISE EXCEPTION 'p_display_name is required';
    END IF;
    IF p_name_mode NOT IN ('serial', 'explicit') THEN
        RAISE EXCEPTION 'p_name_mode must be serial or explicit, got %', p_name_mode;
    END IF;

    -- 幂等:这个 id 已经铸过就直接沿用。客户端拿着本机预生成的 id 先把会话起起来,这一发在后台跑 ——
    -- 网络抖一下重发、或两条腿各发了一次,都会带着同一个 id 到这里。❌ 第二发失败:那等于让一次重试
    -- 把已经在用的身份判死。名字与群按已存在的事实回答,不重算,❌ 也不再占一个新号。
    IF EXISTS (
        SELECT 1 FROM identity.users u
        WHERE u.id = p_agent_id::text AND u.type = 'agent' AND u.owner_user_id = v_owner
    ) THEN
        SELECT u.id::uuid AS id, u.display_name INTO v_minted
        FROM identity.users u WHERE u.id = p_agent_id::text;
        v_name := v_minted.display_name;
    ELSE
        -- 名字唯一性(spec agent-provisioning:两个显示名逐字相同的 agent 一旦并存,「查通讯录把名字解析成 ID」
        -- 失去确定答案)。比对面 = 这个账号名下全部云端 agent。
        v_parts := regexp_match(v_name, '^(.*\S)\s+(\d{1,9})$');
        v_base  := COALESCE(v_parts[1], v_name);
        PERFORM pg_advisory_xact_lock(hashtextextended(v_owner || '/' || v_base, 6396));
        IF p_name_mode = 'serial' OR EXISTS (
            SELECT 1 FROM identity.users u
            WHERE u.type = 'agent' AND u.owner_user_id = v_owner AND u.display_name = v_name
        ) THEN
            v_serial := COALESCE(v_parts[2]::INTEGER, CASE WHEN p_name_mode = 'serial' THEN 1 ELSE 2 END);
            -- 原子占号:起号 = GREATEST(这个前缀用过的最大号 + 1, 候选号)。
            INSERT INTO identity.agent_name_serials AS s (owner_user_id, base, high_water)
            VALUES (v_owner, v_base, v_serial)
            ON CONFLICT (owner_user_id, base) DO UPDATE
                SET high_water = GREATEST(s.high_water + 1, EXCLUDED.high_water), updated_at = now()
            RETURNING s.high_water INTO v_serial;
            -- 账本之外还被占着的(老数据、触发器之外写进来的行)照样跳过。
            WHILE EXISTS (
                SELECT 1 FROM identity.users u
                WHERE u.type = 'agent' AND u.owner_user_id = v_owner AND u.display_name = v_base || ' ' || v_serial
            ) LOOP
                v_serial := v_serial + 1;
            END LOOP;
            v_name := v_base || ' ' || v_serial;
        END IF;

        -- 开户:走同一个 create_owned_agent(设备归属校验、agent_create_device_id、users 回填都在它里面)。
        -- 写出来的名字由 users 上的触发器记进 agent_name_serials。
        SELECT * INTO v_minted FROM identity.create_owned_agent(
            v_name, NULL, p_agent_type, p_device_id, p_local_path, NULL, true, NULL, p_agent_id
        );
    END IF;

    -- 项目 = 群。
    IF p_group_name IS NOT NULL THEN
        IF p_group_chat_id IS NULL OR p_group_chat_id = '' THEN
            RAISE EXCEPTION 'p_group_chat_id is required when p_group_name is given';
        END IF;
        SELECT c.status, c.kind INTO v_status, v_kind FROM chat.chats c WHERE c.id = p_group_chat_id;
        IF NOT FOUND THEN
            v_prior := 'missing';
            v_target := p_group_chat_id;
        ELSIF v_kind <> 'group' OR NOT chat.is_chat_member(p_group_chat_id, v_owner) THEN
            -- 安全:映射里递上来的 id 不是调用者自己所在的群(别人的群 / 私聊 / 话题)⇒ ❌ 不往里塞 agent。
            -- 与「映射指着一个归档群」同处置:另建一个项目群,客户端按返回的 group_chat_id 改指映射。
            v_prior := 'foreign';
            IF p_new_group_id IS NULL OR p_new_group_id = '' THEN
                RAISE EXCEPTION 'p_new_group_id is required when the mapped project group is not the caller''s group';
            END IF;
            v_target := p_new_group_id;
        ELSIF v_status = 'archived' THEN
            v_prior := 'archived';
            IF p_new_group_id IS NULL OR p_new_group_id = '' THEN
                RAISE EXCEPTION 'p_new_group_id is required when the mapped project group is archived';
            END IF;
            v_target := p_new_group_id;
        ELSE
            v_prior := 'active';
            v_target := p_group_chat_id;
        END IF;

        IF v_prior = 'active' THEN
            -- 与客户端直插(RLS)同一道「能否加此人」:上限、agent 审批、成员邀请开关。
            -- 串行化同一群的并发加人(与 add_group_agent 同一把群行锁),再判上限。
            PERFORM 1 FROM chat.chats WHERE id = v_target FOR UPDATE;
            v_denial := chat.group_add_denial(v_target, v_minted.id::text, v_owner);
            IF v_denial = 'agent_join_requires_manager' THEN
                -- 群开了「Agent 加入需审批」而调用者不是管理员:进审批队列,这次不入群(会话照常起)。
                PERFORM chat.queue_agent_join_request(v_target, v_minted.id::text, v_owner, NULL, 'passive');
                v_prior := 'pending_approval';
            ELSIF v_denial IS NOT NULL THEN
                RAISE EXCEPTION 'provision_taskpage_agent: cannot add agent to project group %: %', v_target, v_denial;
            ELSE
                PERFORM chat.insert_group_member(v_target, v_minted.id::text, 'passive', false);
            END IF;
        ELSE
            BEGIN
                PERFORM chat.create_gugu_group(v_target, p_group_name, v_owner, '[]'::jsonb, NULL, NULL);
                PERFORM chat.insert_group_member(v_target, v_minted.id::text, 'passive', false);
                v_created := true;
            EXCEPTION WHEN unique_violation THEN
                -- 背靠背的另一条会话刚用同一个预生成 id 把群建出来了 ⇒ 改加座位。
                -- 串行化同一群的并发加人(与 add_group_agent 同一把群行锁),再判上限。
            PERFORM 1 FROM chat.chats WHERE id = v_target FOR UPDATE;
            v_denial := chat.group_add_denial(v_target, v_minted.id::text, v_owner);
                IF v_denial IS NOT NULL THEN
                    RAISE EXCEPTION 'provision_taskpage_agent: cannot add agent to project group %: %', v_target, v_denial;
                END IF;
                PERFORM chat.insert_group_member(v_target, v_minted.id::text, 'passive', false);
                v_prior := 'active';
            END;
        END IF;
        v_group := CASE WHEN v_prior = 'pending_approval' THEN '' ELSE v_target END;
    END IF;

    RETURN QUERY SELECT v_minted.id, v_name, v_group, v_created, v_prior;
END;
$_$;

REVOKE ALL ON FUNCTION identity.provision_taskpage_agent(p_agent_id uuid, p_display_name text, p_name_mode text, p_agent_type text, p_device_id text, p_local_path text, p_group_chat_id text, p_new_group_id text, p_group_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION identity.provision_taskpage_agent(p_agent_id uuid, p_display_name text, p_name_mode text, p_agent_type text, p_device_id text, p_local_path text, p_group_chat_id text, p_new_group_id text, p_group_name text) TO authenticated;
