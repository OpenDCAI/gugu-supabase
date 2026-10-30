-- A task's identity name may change; its original serial is display-only metadata.
ALTER TABLE identity.users ADD COLUMN name_serial integer CHECK (name_serial > 0);
GRANT SELECT (name_serial) ON identity.users TO authenticated;
COMMENT ON COLUMN identity.users.name_serial IS
  'Stable task-agent serial. NULL for unbound identities and unproven historical serials.';

-- No bulk name parsing: only a host can attest that an old identity has a linked task.
-- Preserve the old API signature as a thin delegate; both APIs use one implementation.

CREATE FUNCTION identity.provision_taskpage_agent(p_agent_id uuid, p_display_name text, p_name_mode text, p_agent_type text, p_device_id text, p_local_path text, p_group_chat_id text, p_new_group_id text, p_group_name text, p_name_serial_base text) RETURNS TABLE(agent_id uuid, display_name text, group_chat_id text, group_created boolean, prior_group_state text)
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
        -- The host knows this is a linked task. Only attest an existing, exact harness placeholder;
        -- a high-water counter cannot recover a renamed agent's individual historical number.
        v_parts := regexp_match(v_name, '^(.*\S)\s+(\d{1,9})$');
        IF p_name_mode = 'serial' AND NULLIF(btrim(p_name_serial_base), '') = v_parts[1] THEN
            UPDATE identity.users SET name_serial = v_parts[2]::integer
            WHERE id = v_minted.id::text AND name_serial IS NULL;
        END IF;
    ELSE
        -- A supplied harness base opts into task-name metadata. Without it, preserve the old
        -- nine-argument explicit-name collision contract, using this same allocator and lock.
        v_parts := regexp_match(v_name, '^(.*\S)\s+(\d{1,9})$');
        v_base := COALESCE(NULLIF(btrim(p_name_serial_base), ''), v_parts[1], v_name);
        PERFORM pg_advisory_xact_lock(hashtextextended(v_owner || '/' || v_base, 6396));
        IF p_name_mode = 'serial' OR NULLIF(btrim(p_name_serial_base), '') IS NOT NULL OR EXISTS (
            SELECT 1 FROM identity.users u
            WHERE u.type = 'agent' AND u.owner_user_id = v_owner AND u.display_name = v_name
        ) THEN
            v_serial := CASE WHEN p_name_mode = 'explicit' AND NULLIF(btrim(p_name_serial_base), '') IS NOT NULL
                THEN 1 ELSE COALESCE(v_parts[2]::INTEGER, CASE WHEN p_name_mode = 'serial' THEN 1 ELSE 2 END) END;
            -- 原子占号:起号 = GREATEST(这个前缀用过的最大号 + 1, 候选号)。
            INSERT INTO identity.agent_name_serials AS s (owner_user_id, base, high_water)
            VALUES (v_owner, v_base, v_serial)
            ON CONFLICT (owner_user_id, base) DO UPDATE
                SET high_water = GREATEST(s.high_water + 1, EXCLUDED.high_water), updated_at = now()
            RETURNING s.high_water INTO v_serial;
            IF p_name_mode = 'serial' OR NULLIF(btrim(p_name_serial_base), '') IS NULL THEN
                -- Only the new explicit task API permits duplicate chosen names.
                WHILE EXISTS (
                    SELECT 1 FROM identity.users u
                    WHERE u.type = 'agent' AND u.owner_user_id = v_owner AND u.display_name = v_base || ' ' || v_serial
                ) LOOP
                    v_serial := v_serial + 1;
                END LOOP;
                v_name := v_base || ' ' || v_serial;
            END IF;
        END IF;

        -- 开户:走同一个 create_owned_agent(设备归属校验、agent_create_device_id、users 回填都在它里面)。
        -- 写出来的名字由 users 上的触发器记进 agent_name_serials。
        SELECT * INTO v_minted FROM identity.create_owned_agent(
            v_name, NULL, p_agent_type, p_device_id, p_local_path, NULL, true, NULL, p_agent_id
        );
        UPDATE identity.users SET name_serial = v_serial WHERE id = v_minted.id::text
            AND (p_name_mode = 'serial' OR NULLIF(btrim(p_name_serial_base), '') IS NOT NULL);
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
                PERFORM chat.queue_agent_join_request(v_target, v_minted.id::text, v_owner, NULL);
                v_prior := 'pending_approval';
            ELSIF v_denial IS NOT NULL THEN
                RAISE EXCEPTION 'provision_taskpage_agent: cannot add agent to project group %: %', v_target, v_denial;
            ELSE
                PERFORM chat.insert_group_member(v_target, v_minted.id::text, 'active', false);
            END IF;
        ELSE
            BEGIN
                PERFORM chat.create_gugu_group(v_target, p_group_name, v_owner, '[]'::jsonb, NULL, NULL);
                PERFORM chat.insert_group_member(v_target, v_minted.id::text, 'active', false);
                v_created := true;
            EXCEPTION WHEN unique_violation THEN
                -- 背靠背的另一条会话刚用同一个预生成 id 把群建出来了 ⇒ 改加座位。
                -- 串行化同一群的并发加人(与 add_group_agent 同一把群行锁),再判上限。
            PERFORM 1 FROM chat.chats WHERE id = v_target FOR UPDATE;
            v_denial := chat.group_add_denial(v_target, v_minted.id::text, v_owner);
                IF v_denial IS NOT NULL THEN
                    RAISE EXCEPTION 'provision_taskpage_agent: cannot add agent to project group %: %', v_target, v_denial;
                END IF;
                PERFORM chat.insert_group_member(v_target, v_minted.id::text, 'active', false);
                v_prior := 'active';
            END;
        END IF;
        v_group := CASE WHEN v_prior = 'pending_approval' THEN '' ELSE v_target END;
    END IF;

    RETURN QUERY SELECT v_minted.id, v_name, v_group, v_created, v_prior;
END;
$_$;

REVOKE ALL ON FUNCTION identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text,text)
  TO authenticated;


-- Without the new metadata argument, old callers retain their original optional arguments.
-- The ten-argument overload has no defaults, so PostgREST can resolve both calls unambiguously.
CREATE OR REPLACE FUNCTION identity.provision_taskpage_agent(
  p_agent_id uuid, p_display_name text, p_name_mode text, p_agent_type text, p_device_id text,
  p_local_path text DEFAULT NULL, p_group_chat_id text DEFAULT NULL,
  p_new_group_id text DEFAULT NULL, p_group_name text DEFAULT NULL
) RETURNS TABLE(agent_id uuid, display_name text, group_chat_id text, group_created boolean, prior_group_state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = identity, chat, public, pg_catalog AS $$
BEGIN
  RETURN QUERY SELECT * FROM identity.provision_taskpage_agent(
    p_agent_id, p_display_name, p_name_mode, p_agent_type, p_device_id,
    p_local_path, p_group_chat_id, p_new_group_id, p_group_name, NULL::text
  );
END;
$$;
REVOKE ALL ON FUNCTION identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text)
  TO authenticated;

-- Existing identity publication and RLS remain authoritative. Serial assignment does not rename
-- anyone or alter memberships, task archival state or the allocator's owner scope.
CREATE TRIGGER users_publish_name_serial AFTER UPDATE OF name_serial ON identity.users
  FOR EACH ROW WHEN (OLD.name_serial IS DISTINCT FROM NEW.name_serial)
  EXECUTE FUNCTION identity.publish_identity_display_revision();
