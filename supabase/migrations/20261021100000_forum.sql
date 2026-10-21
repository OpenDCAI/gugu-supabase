-- 社区论坛与积分悬赏(gugu-base notes/2026-10-20-forum-architecture/社区论坛与悬赏-架构设计稿.html 第二版;owner 10-20
-- 「不做公共群,改成一个专门的论坛」)。论坛是 public 里一组 forum_ 开头的表和 RPC;chat.* 的表、RLS、函数一行不动。
--
-- 帖子 forum_posts、回复 forum_replies、表情 forum_reactions 只经下面的 RPC 读写(表上不给 authenticated 任何权限),
-- 所以「谁看得到哪条回复」只有一处:public.forum_reply_visible。回复、回复上的表情、按身份读、agent 收件箱都调它。
-- 悬赏 forum_bounties 挂在帖子上,积分与结算规则沿用 sb#175(唯一键、AFTER INSERT 记余额、锁余额、锁结算状态、同事务),
-- 只把 chat_id 换成 post_id、message_id 换成 reply_id。
-- 社区积分:❌ 能买、❌ 能换成额度或钱、❌ 能在用户之间转账;billing 一行都不碰。
-- 发帖、参与和注册赠分的门槛只经 public.forum_account_established:社区版看账号满 3 天,部署方可覆盖这一个函数加自己的反滥用条件。
--
-- 加锁顺序(所有改帖子状态或参与集合的函数一律如此):帖子行 → 悬赏行 → 回复 / 积分(余额锁最后)。
--
-- agent 参与:复用聊天的叫醒链。帖内事件 forum_post_events 写入时,给「这一条该投给它」的已指派 agent 写一条
-- agent.deliver(payload.source = 'forum',不新增命令类型);设备执行前的复核 identity.recheck_device_command_execution
-- 按 source 分支(chat 分支逐字不变,未知来源拒绝);收件箱读者按 forum_assignments.acked_seq 拉事件、确认、记失败。
-- 第一版只自动投三种:首次指派、人后来的交代(楼主或这个 agent 的主人发的回复,或者明确回复了它的回答)、结算。
-- agent 的普通回答不叫醒别的 agent。


-- ── ⓪ 账号门槛:社区版只看账号年龄;部署方用 CREATE OR REPLACE 覆盖这一个函数 ─────────────────────
CREATE FUNCTION public.forum_account_established(p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM identity.users u
         WHERE u.id = p_user_id AND u.created_at <= pg_catalog.now() - INTERVAL '3 days'
    );
$function$;
REVOKE ALL ON FUNCTION public.forum_account_established(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── ① 社区积分:余额列 + 只追加的流水 ─────────────────────────────────────────────────────
ALTER TABLE identity.users ADD COLUMN community_points BIGINT NOT NULL DEFAULT 0;
-- agent 赚的记在主人名下,资料卡上 agent 不显示积分。
ALTER TABLE identity.users ADD CONSTRAINT users_agent_has_no_community_points CHECK (type <> 'agent' OR community_points = 0);
GRANT SELECT (community_points) ON identity.users TO authenticated;

CREATE TABLE public.forum_community_points (
    id         BIGSERIAL   PRIMARY KEY,
    user_id    TEXT        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    delta      BIGINT      NOT NULL CHECK (delta <> 0),
    source     TEXT        NOT NULL CHECK (source IN
                 ('signup', 'like', 'bounty_post', 'bounty_award', 'bounty_refund', 'admin_grant', 'admin_reversal')),
    -- 幂等的键:signup = 'signup';like = <post|reply>:<目标 id>:<点的人>;bounty_* = <帖子 id>[:<回复 id>];admin_* = 中台给的来源。
    ref        TEXT        NOT NULL,
    reason     TEXT,
    operator   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT forum_community_points_admin_trail CHECK (
        CASE WHEN source IN ('admin_grant', 'admin_reversal')
             THEN length(btrim(COALESCE(reason, ''))) > 0 AND length(btrim(COALESCE(operator, ''))) > 0
             ELSE operator IS NULL
        END
    )
);
CREATE UNIQUE INDEX forum_community_points_once ON public.forum_community_points (source, ref, user_id) WHERE source <> 'admin_grant';
CREATE INDEX forum_community_points_user_idx ON public.forum_community_points (user_id, created_at);

ALTER TABLE public.forum_community_points ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.forum_community_points FROM PUBLIC, anon, authenticated;
CREATE POLICY forum_community_points_select_own ON public.forum_community_points
    FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()::text));
GRANT SELECT ON public.forum_community_points TO authenticated;
GRANT SELECT ON public.forum_community_points TO service_role;
REVOKE ALL ON SEQUENCE public.forum_community_points_id_seq FROM PUBLIC, anon, authenticated;

-- 两步分开挂:BEFORE 判(只追加、只给人);AFTER INSERT 才把 delta 加到余额上 ——
-- ON CONFLICT DO NOTHING 在 BEFORE 触发器之后才判冲突,加余额放在 BEFORE 里,被跳过的重复行也会加一次。
-- 余额一变,在这个人自己的 gugu:user:<id>:events 上发 forum_points_changed(现成的逐人频道,moments 同样这么用)。
CREATE FUNCTION public.forum_points_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF TG_WHEN = 'BEFORE' THEN
        IF TG_OP = 'UPDATE' THEN
            RAISE EXCEPTION 'community points are append-only: record a reversal instead of editing a row' USING ERRCODE = '42501';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM identity.users u WHERE u.id = NEW.user_id AND u.type = 'human') THEN
            RAISE EXCEPTION 'community points belong to people: % is not a person (agents earn for their owner)', NEW.user_id
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    UPDATE identity.users u SET community_points = u.community_points + NEW.delta WHERE u.id = NEW.user_id;
    PERFORM realtime.send(
        jsonb_build_object('event', 'forum_points_changed', 'entity_id', NEW.user_id),
        'forum_points_changed',
        'gugu:user:' || NEW.user_id || ':events',
        true
    );
    RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_points_apply() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER forum_community_points_check
    BEFORE INSERT OR UPDATE ON public.forum_community_points
    FOR EACH ROW EXECUTE FUNCTION public.forum_points_apply();
CREATE TRIGGER forum_community_points_apply
    AFTER INSERT ON public.forum_community_points
    FOR EACH ROW EXECUTE FUNCTION public.forum_points_apply();

-- 锁住一个人的余额行:同一个人的花分、加分排队(两笔同时花不会透支,每天靠赞的上限数得准)。
CREATE FUNCTION public.forum_points_lock(p_user_id TEXT)
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT u.community_points FROM identity.users u WHERE u.id = p_user_id FOR UPDATE
$function$;
REVOKE ALL ON FUNCTION public.forum_points_lock(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── ② 表 ───────────────────────────────────────────────────────────────────────────────
-- 帖子只软删,从不物理删;作者注销后帖子留着(SET NULL)。event_seq 是帖内事件的计数器(见 forum_post_events)。
CREATE TABLE public.forum_posts (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    author_user_id   TEXT        REFERENCES identity.users(id) ON DELETE SET NULL,
    title            TEXT        NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
    body             TEXT        NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
    event_seq        BIGINT      NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ
);
CREATE INDEX forum_posts_live_idx ON public.forum_posts (last_activity_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX forum_posts_author_idx ON public.forum_posts (author_user_id);

-- owner_user_id = 写入那一刻作者的主人(人就是本人):「同一主人」的判断(可见、计分、采纳、门槛)都用它,
-- agent 被删或作者注销后也还认得出(各自 SET NULL)。to_poster_only 由帖子定:「仅楼主可见」的悬赏进行中,别人的回复都是它。
CREATE TABLE public.forum_replies (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id        UUID        NOT NULL REFERENCES public.forum_posts(id) ON DELETE RESTRICT,
    author_user_id TEXT        REFERENCES identity.users(id) ON DELETE SET NULL,
    owner_user_id  TEXT        REFERENCES identity.users(id) ON DELETE SET NULL,
    body           TEXT        NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
    to_poster_only BOOLEAN     NOT NULL DEFAULT false,
    reply_to       UUID        REFERENCES public.forum_replies(id) ON DELETE RESTRICT,
    -- clock_timestamp():同一事务里先后写的几条也有先后(排序与限速窗口都读它)。
    created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    deleted_at     TIMESTAMPTZ
);
CREATE INDEX forum_replies_post_idx ON public.forum_replies (post_id, created_at);
CREATE INDEX forum_replies_author_recent_idx ON public.forum_replies (post_id, author_user_id, created_at);

CREATE TABLE public.forum_reactions (
    target_kind TEXT        NOT NULL CHECK (target_kind IN ('post', 'reply')),
    target_id   UUID        NOT NULL,
    post_id     UUID        NOT NULL REFERENCES public.forum_posts(id) ON DELETE RESTRICT,
    user_id     TEXT        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    emoji       TEXT        NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (target_kind, target_id, user_id, emoji)
);
CREATE INDEX forum_reactions_post_idx ON public.forum_reactions (post_id);

CREATE FUNCTION public.forum_awards_total(p_awards JSONB)
RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $function$
    SELECT COALESCE(sum((e.value ->> 'amount')::BIGINT), 0)::BIGINT
      FROM pg_catalog.jsonb_array_elements(p_awards) AS e(value)
$function$;
REVOKE ALL ON FUNCTION public.forum_awards_total(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_awards_total(JSONB) TO authenticated, service_role;

-- 托管就是这一行:发帖时记一笔 bounty_post(−amount),之后只有三个去处 —— 给被采纳的人、退楼主、销毁。
-- 结算后 amount = Σawards + refunded + burned(CHECK)。楼主注销后为空:到期时没人可退,直接销毁(与 sb#175 相同)。
-- had_answer:第一条来自别的主人的回复写入时置 true,之后不再改回 —— 结帖只看它,删光回答不能换回退款。
CREATE TABLE public.forum_bounties (
    post_id        UUID        PRIMARY KEY REFERENCES public.forum_posts(id) ON DELETE RESTRICT,
    poster_user_id TEXT        REFERENCES identity.users(id) ON DELETE SET NULL,
    amount         BIGINT      NOT NULL CHECK (amount BETWEEN 1 AND 100),
    visibility     TEXT        NOT NULL CHECK (visibility IN ('public', 'poster_only')),
    deadline_at    TIMESTAMPTZ NOT NULL,
    status         TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awarded', 'refunded', 'burned')),
    -- [{user_id, reply_id, amount}],user_id 是拿分的人(agent 回答时是它的主人)。
    awards         JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(awards) = 'array'),
    refunded       BIGINT      NOT NULL DEFAULT 0 CHECK (refunded >= 0),
    burned         BIGINT      NOT NULL DEFAULT 0 CHECK (burned >= 0),
    had_answer     BOOLEAN     NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at     TIMESTAMPTZ,
    CONSTRAINT forum_bounties_settlement_shape CHECK (
        CASE WHEN status = 'open'
             THEN settled_at IS NULL AND awards = '[]'::jsonb AND refunded = 0 AND burned = 0
             ELSE settled_at IS NOT NULL AND amount = public.forum_awards_total(awards) + refunded + burned
        END
    ),
    CONSTRAINT forum_bounties_refund_only_unanswered CHECK (refunded = 0 OR NOT had_answer)
);
CREATE INDEX forum_bounties_poster_idx ON public.forum_bounties (poster_user_id, status);
CREATE INDEX forum_bounties_open_deadline_idx ON public.forum_bounties (deadline_at) WHERE status = 'open';

-- 帖内事件:只追加,seq 在帖内递增(分配时帖子行已锁)。页面按种类重读实体;agent 的指派按 acked_seq 确认。
-- target_user_id:assigned = 被指派的 agent;reply = 被回复的那条回答的作者(明确回复)。
CREATE TABLE public.forum_post_events (
    post_id        UUID        NOT NULL REFERENCES public.forum_posts(id) ON DELETE RESTRICT,
    seq            BIGINT      NOT NULL,
    kind           TEXT        NOT NULL CHECK (kind IN ('assigned', 'reply', 'deleted', 'reaction', 'settled')),
    entity_id      TEXT,
    actor_user_id  TEXT        REFERENCES identity.users(id) ON DELETE SET NULL,
    by_human       BOOLEAN     NOT NULL,
    target_user_id TEXT        REFERENCES identity.users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, seq)
);

-- 指派:主人把自己的 agent 派到一个帖子上。acked_seq = 已确认投到的事件序号(指派时取指派前的序号,所以指派事件本身会投)。
-- delivery_state 给主人在帖子里看:pending 已派未投 · delivered 已投到 · undelivered 没投进去(会自动重投)·
-- turn_failed 投进去了但那一轮失败(不自动重跑,主人可以再派一次)。❌ 写成一条回复,否则会干扰结算。
CREATE TABLE public.forum_assignments (
    post_id        UUID        NOT NULL REFERENCES public.forum_posts(id) ON DELETE RESTRICT,
    agent_user_id  TEXT        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    assigned_by    TEXT        REFERENCES identity.users(id) ON DELETE SET NULL,
    acked_seq      BIGINT      NOT NULL DEFAULT 0,
    delivery_state TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (delivery_state IN ('pending', 'delivered', 'undelivered', 'turn_failed')),
    last_error     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, agent_user_id)
);
CREATE INDEX forum_assignments_agent_idx ON public.forum_assignments (agent_user_id);

-- 参与过的身份(第一次回复或被指派时写入,不再删除):三身份门槛按它数。
CREATE TABLE public.forum_participants (
    post_id       UUID        NOT NULL REFERENCES public.forum_posts(id) ON DELETE RESTRICT,
    user_id       TEXT        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    owner_user_id TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, user_id)
);
CREATE INDEX forum_participants_owner_idx ON public.forum_participants (post_id, owner_user_id);

-- 楼主拉黑:被拉黑的人和他名下的 agent 都不能回复拉黑者的帖子,也不能被指派进去。私聊不受影响。
CREATE TABLE public.forum_blocks (
    blocker_user_id TEXT        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    blocked_user_id TEXT        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_user_id, blocked_user_id),
    CHECK (blocker_user_id <> blocked_user_id)
);

DO $tables$
DECLARE
    v_table TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY['forum_posts', 'forum_replies', 'forum_reactions', 'forum_bounties', 'forum_post_events',
                                   'forum_assignments', 'forum_participants', 'forum_blocks'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_table);
        EXECUTE format('GRANT SELECT ON public.%I TO service_role', v_table);
    END LOOP;
END
$tables$;

-- ── ③ 共用的判断 ─────────────────────────────────────────────────────────────────────────
-- 唯一的可见性谓词:没被删,而且是公开的,或者看的人是楼主,或者看的人和回复属于同一个主人(作者本人、作者的主人、
-- 同一主人名下的别的 agent)。p_actor_owner = COALESCE(看的人的主人, 看的人)。
CREATE FUNCTION public.forum_reply_visible(
    p_deleted_at TIMESTAMPTZ, p_to_poster_only BOOLEAN, p_reply_owner TEXT, p_poster TEXT, p_actor TEXT, p_actor_owner TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $function$
    SELECT p_deleted_at IS NULL
       AND (NOT p_to_poster_only OR p_actor = p_poster OR p_actor_owner = p_reply_owner)
$function$;
REVOKE ALL ON FUNCTION public.forum_reply_visible(TIMESTAMPTZ, BOOLEAN, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.forum_owner_of(p_user_id TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT COALESCE(u.owner_user_id, u.id) FROM identity.users u WHERE u.id = p_user_id
$function$;
REVOKE ALL ON FUNCTION public.forum_owner_of(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- 以谁的身份:不传 = 调用者本人;传 = 本人或自己名下的 agent(chat.is_acting_as 同一个判据)。写一律要登录身份。
CREATE FUNCTION public.forum_actor(p_as TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor TEXT := COALESCE(NULLIF(btrim(COALESCE(p_as, '')), ''), (SELECT auth.uid()::text));
BEGIN
    IF (SELECT auth.uid()) IS NULL OR v_actor IS NULL OR NOT chat.is_acting_as(v_actor) THEN
        RAISE EXCEPTION 'forum: not allowed to act as %', COALESCE(v_actor, '(nobody)') USING ERRCODE = '42501';
    END IF;
    RETURN v_actor;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_actor(TEXT) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.forum_lock_post(p_post_id UUID)
RETURNS public.forum_posts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_post public.forum_posts;
BEGIN
    SELECT * INTO v_post FROM public.forum_posts p WHERE p.id = p_post_id FOR UPDATE;
    IF NOT FOUND OR v_post.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'forum_post_not_found' USING ERRCODE = 'P0002';
    END IF;
    RETURN v_post;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_lock_post(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- 写一条帖内事件(调用方已锁住帖子行),返回它的 seq。
CREATE FUNCTION public.forum_append_event(p_post_id UUID, p_kind TEXT, p_entity_id TEXT, p_actor TEXT, p_target TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_seq BIGINT;
BEGIN
    UPDATE public.forum_posts p
       SET event_seq = p.event_seq + 1,
           last_activity_at = CASE WHEN p_kind IN ('reply', 'settled') THEN pg_catalog.now() ELSE p.last_activity_at END
     WHERE p.id = p_post_id
    RETURNING p.event_seq INTO v_seq;
    INSERT INTO public.forum_post_events (post_id, seq, kind, entity_id, actor_user_id, by_human, target_user_id)
    VALUES (p_post_id, v_seq, p_kind, p_entity_id, p_actor,
            COALESCE((SELECT u.type = 'human' FROM identity.users u WHERE u.id = p_actor), false), p_target);
    RETURN v_seq;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_append_event(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- 门槛(调用方已锁住帖子行,所以参与集合的变化在帖锁下串行):
--   楼主本人不受限。① 被楼主拉黑(本人或主人)⇒ 拒,哪怕之前参与过。② 已参与过的身份照常继续。
--   ③ 同一主人在这一帖里最多 3 个参与身份,第 4 个新身份拒。④ 新号:主人注册满 3 天,并且在设备上认领过免费额度
--   (上线前的账号 device_hash 为 NULL,照样算认领过)。通过后记为参与者。
CREATE FUNCTION public.forum_admit(p_post public.forum_posts, p_identity TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_owner TEXT := public.forum_owner_of(p_identity);
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'forum: unknown identity %', p_identity USING ERRCODE = 'P0002';
    END IF;
    IF p_identity = p_post.author_user_id THEN
        INSERT INTO public.forum_participants (post_id, user_id, owner_user_id)
        VALUES (p_post.id, p_identity, v_owner) ON CONFLICT DO NOTHING;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.forum_blocks k
                WHERE k.blocker_user_id = p_post.author_user_id AND k.blocked_user_id IN (p_identity, v_owner)) THEN
        RAISE EXCEPTION 'blocked_by_poster' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.forum_participants fp WHERE fp.post_id = p_post.id AND fp.user_id = p_identity) THEN
        RETURN;
    END IF;
    IF (SELECT count(*) FROM public.forum_participants fp
         WHERE fp.post_id = p_post.id AND fp.owner_user_id = v_owner) >= 3 THEN
        RAISE EXCEPTION 'owner_identity_limit' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT public.forum_account_established(v_owner) THEN
        RAISE EXCEPTION 'account_too_new' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.forum_participants (post_id, user_id, owner_user_id) VALUES (p_post.id, p_identity, v_owner);
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_admit(public.forum_posts, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- 这个 agent 此刻还能不能在这个帖子里干活:仍被指派、帖子没删、主人没被楼主拉黑。复核、收件箱、回复共用。
CREATE FUNCTION public.forum_agent_may_act(p_post_id UUID, p_agent TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
          FROM public.forum_assignments a
          JOIN public.forum_posts p ON p.id = a.post_id AND p.deleted_at IS NULL
          JOIN identity.users u ON u.id = a.agent_user_id AND u.type = 'agent'
         WHERE a.post_id = p_post_id AND a.agent_user_id = p_agent
           AND NOT EXISTS (SELECT 1 FROM public.forum_blocks k
                            WHERE k.blocker_user_id = p.author_user_id AND k.blocked_user_id IN (u.id, u.owner_user_id))
    )
$function$;
REVOKE ALL ON FUNCTION public.forum_agent_may_act(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- 唯一的「这条事件叫不叫醒这个已指派的 agent」:入队触发器与收件箱拉取共用。
--   assigned:只叫被指派的那个;settled:都叫;reply:人发的、来自楼主或这个 agent 的主人(后来的交代),
--   或者任何人明确回复了它的回答;并且这条回复它看得到。agent 发的普通回复不叫醒别的 agent;自己引起的事件不叫醒自己。
CREATE FUNCTION public.forum_event_wakes_agent(p_post_id UUID, p_seq BIGINT, p_agent TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
          FROM public.forum_post_events e
          JOIN public.forum_posts p ON p.id = e.post_id
          JOIN identity.users a ON a.id = p_agent AND a.type = 'agent'
         WHERE e.post_id = p_post_id AND e.seq = p_seq
           AND e.actor_user_id IS DISTINCT FROM p_agent
           AND CASE e.kind
                 WHEN 'assigned' THEN e.target_user_id = p_agent
                 WHEN 'settled'  THEN true
                 WHEN 'reply'    THEN
                     ((e.by_human AND e.actor_user_id IN (p.author_user_id, a.owner_user_id))
                      OR e.target_user_id = p_agent)
                     AND EXISTS (SELECT 1 FROM public.forum_replies r
                                  WHERE r.id = e.entity_id::uuid
                                    AND public.forum_reply_visible(r.deleted_at, r.to_poster_only, r.owner_user_id,
                                                                   p.author_user_id, p_agent, a.owner_user_id))
                 ELSE false
               END
    )
$function$;
REVOKE ALL ON FUNCTION public.forum_event_wakes_agent(UUID, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── ④ 事件的出口:看帖的人一条频道,被指派的 agent 一条设备命令 ───────────────────────────────
-- 广播不按人扇出(6061 的教训):gugu:forum:<post_id> 一条,页面收到后按种类重读。
-- 设备命令:与 chat.enqueue_agent_deliver_device_command 同样的「在线、有设备、设备归主人」条件,payload 只带引用。
CREATE FUNCTION public.forum_post_events_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    PERFORM realtime.send(
        jsonb_build_object('event', 'forum_changed', 'post_id', NEW.post_id, 'seq', NEW.seq, 'kind', NEW.kind,
                           'entity_id', NEW.entity_id),
        'forum_changed',
        'gugu:forum:' || NEW.post_id::text,
        true
    );
    INSERT INTO identity.gugu_device_commands (user_id, device_id, type, payload)
    SELECT u.owner_user_id::uuid, u.device_id, 'agent.deliver',
           jsonb_build_object('agent_user_id', u.id, 'source', 'forum', 'post_id', NEW.post_id, 'event_seq', NEW.seq)
      FROM public.forum_assignments a
      JOIN identity.users u
        ON u.id = a.agent_user_id
       AND u.type = 'agent'
       AND u.owner_user_id IS NOT NULL
       AND u.device_id IS NOT NULL
       AND u.desired_status = 'online'
      JOIN identity.gugu_devices d
        ON d.device_id = u.device_id
       AND d.user_id::text = u.owner_user_id
     WHERE a.post_id = NEW.post_id
       AND public.forum_agent_may_act(NEW.post_id, a.agent_user_id)
       AND public.forum_event_wakes_agent(NEW.post_id, NEW.seq, a.agent_user_id);
    RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_post_events_after_insert() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER forum_post_events_after_insert
    AFTER INSERT ON public.forum_post_events
    FOR EACH ROW EXECUTE FUNCTION public.forum_post_events_after_insert();

-- 论坛列表的频道:新帖、悬赏结局变化。
CREATE FUNCTION public.forum_feed_changed(p_post_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT realtime.send(
        jsonb_build_object('event', 'forum_feed_changed', 'post_id', p_post_id),
        'forum_feed_changed',
        'gugu:forum:feed',
        true
    )
$function$;
REVOKE ALL ON FUNCTION public.forum_feed_changed(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- 频道放行:gugu:forum:feed 与 gugu:forum:<post_id>,任何登录身份可订(帖子人人可读;私密回复的正文不在广播里)。
CREATE POLICY gugu_forum_events_select ON realtime.messages
    FOR SELECT TO authenticated
    USING (split_part(topic, ':', 1) = 'gugu' AND split_part(topic, ':', 2) = 'forum');

-- ── ⑤ 发帖 ───────────────────────────────────────────────────────────────────────────────
-- p_amount 为空 = 普通帖子;有值 = 悬赏帖(p_days ∈ {1,3,7},p_visibility ∈ {public, poster_only})。
CREATE FUNCTION public.forum_create_post(
    p_title TEXT, p_body TEXT, p_amount BIGINT DEFAULT NULL, p_days INTEGER DEFAULT NULL, p_visibility TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_uid TEXT := (SELECT auth.uid()::text);
    v_title TEXT := btrim(COALESCE(p_title, ''));
    v_body TEXT := btrim(COALESCE(p_body, ''));
    v_post public.forum_posts;
    v_balance BIGINT;
    v_created TIMESTAMPTZ;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;
    SELECT u.created_at INTO v_created FROM identity.users u WHERE u.id = v_uid AND u.type = 'human';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'forum_poster_must_be_human' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT public.forum_account_established(v_uid) THEN
        RAISE EXCEPTION 'account_too_new' USING ERRCODE = 'check_violation';
    END IF;
    IF length(v_title) NOT BETWEEN 1 AND 100 OR length(v_body) NOT BETWEEN 1 AND 20000 THEN
        RAISE EXCEPTION 'forum_title_or_body_invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF p_amount IS NOT NULL THEN
        IF p_amount NOT BETWEEN 1 AND 100 THEN
            RAISE EXCEPTION 'bounty_amount_out_of_range' USING ERRCODE = 'check_violation';
        END IF;
        IF p_days IS NULL OR p_days NOT IN (1, 3, 7) THEN
            RAISE EXCEPTION 'bounty_days_invalid' USING ERRCODE = 'check_violation';
        END IF;
        IF p_visibility IS NULL OR p_visibility NOT IN ('public', 'poster_only') THEN
            RAISE EXCEPTION 'bounty_visibility_invalid' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF p_days IS NOT NULL OR p_visibility IS NOT NULL THEN
        RAISE EXCEPTION 'forum: days and visibility belong to a bounty (pass an amount)' USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.forum_posts (author_user_id, title, body) VALUES (v_uid, v_title, v_body) RETURNING * INTO v_post;
    INSERT INTO public.forum_participants (post_id, user_id, owner_user_id) VALUES (v_post.id, v_uid, v_uid);
    IF p_amount IS NOT NULL THEN
        v_balance := public.forum_points_lock(v_uid);
        IF (SELECT count(*) FROM public.forum_bounties b WHERE b.poster_user_id = v_uid AND b.status = 'open') >= 3 THEN
            RAISE EXCEPTION 'bounty_active_limit' USING ERRCODE = 'check_violation';
        END IF;
        IF v_balance < p_amount THEN
            RAISE EXCEPTION 'bounty_insufficient_points' USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO public.forum_bounties (post_id, poster_user_id, amount, visibility, deadline_at)
        VALUES (v_post.id, v_uid, p_amount, p_visibility, pg_catalog.now() + make_interval(days => p_days));
        INSERT INTO public.forum_community_points (user_id, delta, source, ref)
        VALUES (v_uid, -p_amount, 'bounty_post', v_post.id::text);
    END IF;
    PERFORM public.forum_feed_changed(v_post.id);
    RETURN v_post.id;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_create_post(TEXT, TEXT, BIGINT, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_create_post(TEXT, TEXT, BIGINT, INTEGER, TEXT) TO authenticated;

-- 作者删自己的帖子;进行中的悬赏帖不能删(先结束悬赏),删帖不绕过结算。
CREATE FUNCTION public.forum_delete_post(p_post_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_post public.forum_posts := public.forum_lock_post(p_post_id);
BEGIN
    IF v_post.author_user_id IS DISTINCT FROM (SELECT auth.uid()::text) THEN
        RAISE EXCEPTION 'forum_post_not_yours' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.forum_bounties b WHERE b.post_id = p_post_id AND b.status = 'open') THEN
        RAISE EXCEPTION 'forum_post_has_open_bounty: end the bounty first' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.forum_posts p SET deleted_at = pg_catalog.now() WHERE p.id = p_post_id;
    PERFORM public.forum_feed_changed(p_post_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_delete_post(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_delete_post(UUID) TO authenticated;

-- ── ⑥ 回复 ───────────────────────────────────────────────────────────────────────────────
-- p_as:以自己名下的哪个 agent 回复(agent 必须被指派在这个帖子上)。结帖后只有楼主还能回复;
-- 「仅楼主可见」的悬赏进行中,别人的回复只给楼主(和回复者这一家)看。限速:每人每帖 10 分钟最多 10 条,楼主不限。
CREATE FUNCTION public.forum_reply(p_post_id UUID, p_body TEXT, p_reply_to UUID DEFAULT NULL, p_as TEXT DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor TEXT := public.forum_actor(p_as);
    v_owner TEXT := public.forum_owner_of(v_actor);
    v_body TEXT := btrim(COALESCE(p_body, ''));
    v_post public.forum_posts := public.forum_lock_post(p_post_id);
    v_bounty public.forum_bounties;
    v_private BOOLEAN := false;
    v_target TEXT;
    v_reply UUID;
BEGIN
    IF length(v_body) NOT BETWEEN 1 AND 20000 THEN
        RAISE EXCEPTION 'forum_body_invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id = v_actor AND u.type = 'agent')
       AND NOT public.forum_agent_may_act(p_post_id, v_actor) THEN
        RAISE EXCEPTION 'forum_agent_not_assigned: assign this agent to the post first' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_bounty FROM public.forum_bounties b WHERE b.post_id = p_post_id FOR UPDATE;
    IF v_actor IS DISTINCT FROM v_post.author_user_id THEN
        PERFORM public.forum_admit(v_post, v_actor);
        IF v_bounty.post_id IS NOT NULL AND v_bounty.status <> 'open' THEN
            RAISE EXCEPTION 'post_closed: this bounty has been settled' USING ERRCODE = 'check_violation';
        END IF;
        IF (SELECT count(*) FROM public.forum_replies r
             WHERE r.post_id = p_post_id AND r.author_user_id = v_actor
               AND r.created_at > pg_catalog.now() - INTERVAL '10 minutes') >= 10 THEN
            RAISE EXCEPTION 'rate-limited: at most 10 replies per 10 minutes from one identity in a post' USING ERRCODE = 'PT429';
        END IF;
        v_private := v_bounty.post_id IS NOT NULL AND v_bounty.visibility = 'poster_only' AND v_bounty.status = 'open';
    END IF;
    IF p_reply_to IS NOT NULL THEN
        SELECT r.author_user_id INTO v_target
          FROM public.forum_replies r
         WHERE r.id = p_reply_to AND r.post_id = p_post_id
           AND public.forum_reply_visible(r.deleted_at, r.to_poster_only, r.owner_user_id, v_post.author_user_id, v_actor, v_owner);
        IF NOT FOUND THEN
            RAISE EXCEPTION 'forum_reply_target_not_found' USING ERRCODE = 'P0002';
        END IF;
    END IF;

    INSERT INTO public.forum_replies (post_id, author_user_id, owner_user_id, body, to_poster_only, reply_to)
    VALUES (p_post_id, v_actor, v_owner, v_body, v_private, p_reply_to)
    RETURNING id INTO v_reply;
    IF v_bounty.post_id IS NOT NULL AND v_bounty.status = 'open' AND NOT v_bounty.had_answer
       AND v_owner IS DISTINCT FROM v_bounty.poster_user_id THEN
        UPDATE public.forum_bounties b SET had_answer = true WHERE b.post_id = p_post_id;
    END IF;
    PERFORM public.forum_append_event(p_post_id, 'reply', v_reply::text, v_actor, v_target);
    RETURN v_reply;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_reply(UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_reply(UUID, TEXT, UUID, TEXT) TO authenticated;

-- 楼主删任何人的回复,作者(或作者的主人)删自己的。删了不改 had_answer。
CREATE FUNCTION public.forum_delete_reply(p_reply_id UUID, p_as TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor TEXT := public.forum_actor(p_as);
    v_post_id UUID;
    v_post public.forum_posts;
    v_reply public.forum_replies;
BEGIN
    SELECT r.post_id INTO v_post_id FROM public.forum_replies r WHERE r.id = p_reply_id;
    IF v_post_id IS NULL THEN
        RAISE EXCEPTION 'forum_reply_not_found' USING ERRCODE = 'P0002';
    END IF;
    v_post := public.forum_lock_post(v_post_id);
    SELECT * INTO v_reply FROM public.forum_replies r WHERE r.id = p_reply_id AND r.deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'forum_reply_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_actor IS DISTINCT FROM v_post.author_user_id
       AND v_actor IS DISTINCT FROM v_reply.author_user_id
       AND v_actor IS DISTINCT FROM v_reply.owner_user_id THEN
        RAISE EXCEPTION 'forum_reply_not_yours' USING ERRCODE = '42501';
    END IF;
    UPDATE public.forum_replies r SET deleted_at = pg_catalog.now() WHERE r.id = p_reply_id;
    PERFORM public.forum_append_event(v_post_id, 'deleted', p_reply_id::text, v_actor, NULL);
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_delete_reply(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_delete_reply(UUID, TEXT) TO authenticated;

-- ── ⑦ 表情 ───────────────────────────────────────────────────────────────────────────────
-- 目标必须对这个身份可见(回复走同一个谓词)。p_on = false 取消。点赞计分在 forum_reactions 的触发器里。
CREATE FUNCTION public.forum_react(p_kind TEXT, p_target UUID, p_emoji TEXT, p_on BOOLEAN DEFAULT true, p_as TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor TEXT := public.forum_actor(p_as);
    v_owner TEXT := public.forum_owner_of(v_actor);
    v_post_id UUID;
    v_post public.forum_posts;
BEGIN
    IF p_kind = 'post' THEN
        v_post_id := p_target;
    ELSIF p_kind = 'reply' THEN
        SELECT r.post_id INTO v_post_id FROM public.forum_replies r WHERE r.id = p_target;
    ELSE
        RAISE EXCEPTION 'forum_react: kind is post|reply' USING ERRCODE = 'check_violation';
    END IF;
    IF v_post_id IS NULL THEN
        RAISE EXCEPTION 'forum_reaction_target_not_found' USING ERRCODE = 'P0002';
    END IF;
    v_post := public.forum_lock_post(v_post_id);
    IF p_kind = 'reply' AND NOT EXISTS (
        SELECT 1 FROM public.forum_replies r
         WHERE r.id = p_target
           AND public.forum_reply_visible(r.deleted_at, r.to_poster_only, r.owner_user_id, v_post.author_user_id, v_actor, v_owner)
    ) THEN
        RAISE EXCEPTION 'forum_reaction_target_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF length(btrim(COALESCE(p_emoji, ''))) NOT BETWEEN 1 AND 16 THEN
        RAISE EXCEPTION 'forum_emoji_invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF COALESCE(p_on, true) THEN
        INSERT INTO public.forum_reactions (target_kind, target_id, post_id, user_id, emoji)
        VALUES (p_kind, p_target, v_post_id, v_actor, btrim(p_emoji)) ON CONFLICT DO NOTHING;
    ELSE
        DELETE FROM public.forum_reactions x
         WHERE x.target_kind = p_kind AND x.target_id = p_target AND x.user_id = v_actor AND x.emoji = btrim(p_emoji);
    END IF;
    PERFORM public.forum_append_event(v_post_id, 'reaction', p_target::text, v_actor, NULL);
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_react(TEXT, UUID, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_react(TEXT, UUID, TEXT, BOOLEAN, TEXT) TO authenticated;

-- 点赞计分:作者的主人 +1。真人点的才算、不同主人、同一个人对同一条一次(唯一键;取消再点不重复,取消也不收回)、
-- 私密和已删的回复不算、每人每天(北京时间)靠赞最多 20 分。
CREATE FUNCTION public.forum_points_on_reaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_author TEXT;
    v_today INTEGER;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.users r WHERE r.id = NEW.user_id AND r.type = 'human') THEN
        RETURN NULL;
    END IF;
    IF NEW.target_kind = 'post' THEN
        SELECT p.author_user_id INTO v_author FROM public.forum_posts p WHERE p.id = NEW.target_id AND p.deleted_at IS NULL;
    ELSE
        SELECT r.owner_user_id INTO v_author FROM public.forum_replies r
         WHERE r.id = NEW.target_id AND NOT r.to_poster_only AND r.deleted_at IS NULL;
    END IF;
    IF v_author IS NULL OR v_author = NEW.user_id THEN
        RETURN NULL;
    END IF;
    PERFORM public.forum_points_lock(v_author);
    SELECT count(*) INTO v_today
      FROM public.forum_community_points p
     WHERE p.user_id = v_author AND p.source = 'like'
       AND p.created_at >= (date_trunc('day', pg_catalog.now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai');
    IF v_today >= 20 THEN
        RETURN NULL;
    END IF;
    INSERT INTO public.forum_community_points (user_id, delta, source, ref)
    VALUES (v_author, 1, 'like', NEW.target_kind || ':' || NEW.target_id::text || ':' || NEW.user_id)
    ON CONFLICT DO NOTHING;
    RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_points_on_reaction() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER forum_reactions_points
    AFTER INSERT ON public.forum_reactions
    FOR EACH ROW EXECUTE FUNCTION public.forum_points_on_reaction();

-- ── ⑧ 拉黑与指派 ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.forum_block(p_user_id TEXT, p_on BOOLEAN DEFAULT true)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_uid TEXT := (SELECT auth.uid()::text);
    v_target TEXT := public.forum_owner_of(p_user_id);
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;
    IF v_target IS NULL OR v_target = v_uid THEN
        RAISE EXCEPTION 'forum_block_target_invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF COALESCE(p_on, true) THEN
        INSERT INTO public.forum_blocks (blocker_user_id, blocked_user_id) VALUES (v_uid, v_target) ON CONFLICT DO NOTHING;
    ELSE
        DELETE FROM public.forum_blocks k WHERE k.blocker_user_id = v_uid AND k.blocked_user_id = v_target;
    END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_block(TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_block(TEXT, BOOLEAN) TO authenticated;

-- 主人把自己的 agent 派到帖子上(再派一次 = 把投递状态清回 pending 并重新投一次指派)。agent 也过门槛、记为参与者。
CREATE FUNCTION public.forum_assign(p_post_id UUID, p_agent TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_uid TEXT := (SELECT auth.uid()::text);
    v_post public.forum_posts := public.forum_lock_post(p_post_id);
    v_seq BIGINT;
BEGIN
    IF v_uid IS NULL OR NOT EXISTS (
        SELECT 1 FROM identity.users u WHERE u.id = p_agent AND u.type = 'agent' AND u.owner_user_id = v_uid
    ) THEN
        RAISE EXCEPTION 'forum_agent_not_yours' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.forum_bounties b WHERE b.post_id = p_post_id AND b.status <> 'open') THEN
        RAISE EXCEPTION 'post_closed: this bounty has been settled' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM public.forum_admit(v_post, p_agent);
    INSERT INTO public.forum_assignments (post_id, agent_user_id, assigned_by, acked_seq)
    VALUES (p_post_id, p_agent, v_uid, v_post.event_seq)
    ON CONFLICT (post_id, agent_user_id) DO UPDATE
       SET delivery_state = 'pending', last_error = NULL, updated_at = pg_catalog.now(), assigned_by = EXCLUDED.assigned_by;
    v_seq := public.forum_append_event(p_post_id, 'assigned', p_agent, v_uid, p_agent);
    RETURN v_seq;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_assign(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_assign(UUID, TEXT) TO authenticated;

-- ── ⑨ 结算 ───────────────────────────────────────────────────────────────────────────────
-- 公开「仅楼主可见」的回复;页面收到 settled 事件后整帖重读。调用方已锁住帖子和悬赏。
CREATE FUNCTION public.forum_bounty_close(p_bounty public.forum_bounties)
RETURNS public.forum_bounties
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_row public.forum_bounties;
BEGIN
    IF NOT p_bounty.had_answer AND p_bounty.poster_user_id IS NOT NULL THEN
        INSERT INTO public.forum_community_points (user_id, delta, source, ref)
        VALUES (p_bounty.poster_user_id, p_bounty.amount, 'bounty_refund', p_bounty.post_id::text);
        UPDATE public.forum_bounties b SET status = 'refunded', refunded = b.amount, settled_at = pg_catalog.now()
         WHERE b.post_id = p_bounty.post_id RETURNING * INTO v_row;
    ELSE
        UPDATE public.forum_bounties b SET status = 'burned', burned = b.amount, settled_at = pg_catalog.now()
         WHERE b.post_id = p_bounty.post_id RETURNING * INTO v_row;
    END IF;
    RETURN v_row;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_bounty_close(public.forum_bounties) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.forum_bounty_settled(p_post_id UUID, p_actor TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    UPDATE public.forum_replies r SET to_poster_only = false WHERE r.post_id = p_post_id AND r.to_poster_only;
    PERFORM public.forum_append_event(p_post_id, 'settled', p_post_id::text, p_actor, NULL);
    PERFORM public.forum_feed_changed(p_post_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_bounty_settled(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- 采纳 p_awards = [{reply_id, amount}](1–3 条,加起来等于赏金;发帖满 24 小时后、截止后 24 小时内);
-- 空数组 = 结束悬赏不采纳:从来没有别人回答过 ⇒ 全退,有过 ⇒ 销毁。
CREATE FUNCTION public.forum_award(p_post_id UUID, p_awards JSONB)
RETURNS public.forum_bounties
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_uid TEXT := (SELECT auth.uid()::text);
    v_post public.forum_posts := public.forum_lock_post(p_post_id);
    v_bounty public.forum_bounties;
    v_award JSONB;
    v_reply_id UUID;
    v_amount BIGINT;
    v_recipient TEXT;
    v_resolved JSONB := '[]'::jsonb;
    v_row public.forum_bounties;
BEGIN
    SELECT * INTO v_bounty FROM public.forum_bounties b WHERE b.post_id = p_post_id FOR UPDATE;
    IF NOT FOUND OR v_uid IS NULL OR v_bounty.poster_user_id IS DISTINCT FROM v_uid THEN
        RAISE EXCEPTION 'bounty_not_yours' USING ERRCODE = '42501';
    END IF;
    IF v_bounty.status <> 'open' THEN
        RAISE EXCEPTION 'bounty_already_settled' USING ERRCODE = 'check_violation';
    END IF;
    IF pg_catalog.now() > v_bounty.deadline_at + INTERVAL '24 hours' THEN
        RAISE EXCEPTION 'bounty_past_grace' USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(p_awards) IS DISTINCT FROM 'array' OR jsonb_array_length(p_awards) > 3 THEN
        RAISE EXCEPTION 'bounty_awards_invalid: an array of at most 3 {reply_id, amount}' USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_array_length(p_awards) = 0 THEN
        v_row := public.forum_bounty_close(v_bounty);
        PERFORM public.forum_bounty_settled(p_post_id, v_uid);
        RETURN v_row;
    END IF;
    IF pg_catalog.now() < v_bounty.created_at + INTERVAL '24 hours' THEN
        RAISE EXCEPTION 'bounty_award_too_early: awarding opens 24 hours after posting' USING ERRCODE = 'check_violation';
    END IF;

    FOR v_award IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_awards) AS e(value) LOOP
        v_reply_id := CASE WHEN (v_award ->> 'reply_id') ~* '^[0-9a-f-]{36}$' THEN (v_award ->> 'reply_id')::uuid END;
        v_amount := CASE WHEN (v_award ->> 'amount') ~ '^[0-9]{1,3}$' THEN (v_award ->> 'amount')::BIGINT END;
        IF v_amount IS NULL OR v_amount < 1 THEN
            RAISE EXCEPTION 'bounty_awards_invalid: amount must be a whole number of points >= 1' USING ERRCODE = 'check_violation';
        END IF;
        IF v_resolved @> jsonb_build_array(jsonb_build_object('reply_id', v_reply_id)) THEN
            RAISE EXCEPTION 'bounty_awards_invalid: the same answer twice' USING ERRCODE = 'check_violation';
        END IF;
        v_recipient := NULL;
        SELECT r.owner_user_id INTO v_recipient
          FROM public.forum_replies r
         WHERE r.id = v_reply_id AND r.post_id = p_post_id AND r.deleted_at IS NULL;
        IF v_recipient IS NULL THEN
            RAISE EXCEPTION 'bounty_awards_invalid: % is not an answer in this post', v_award ->> 'reply_id' USING ERRCODE = 'check_violation';
        END IF;
        IF v_recipient = v_uid THEN
            RAISE EXCEPTION 'bounty_award_to_self: cannot award yourself or your own agents' USING ERRCODE = 'check_violation';
        END IF;
        v_resolved := v_resolved || jsonb_build_array(jsonb_build_object(
            'user_id', v_recipient, 'reply_id', v_reply_id, 'amount', v_amount));
    END LOOP;
    IF public.forum_awards_total(v_resolved) <> v_bounty.amount THEN
        RAISE EXCEPTION 'bounty_awards_invalid: the awards must add up to the bounty (%)', v_bounty.amount USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.forum_community_points (user_id, delta, source, ref)
    SELECT e.value ->> 'user_id', (e.value ->> 'amount')::BIGINT, 'bounty_award', p_post_id::text || ':' || (e.value ->> 'reply_id')
      FROM pg_catalog.jsonb_array_elements(v_resolved) AS e(value);
    UPDATE public.forum_bounties b SET status = 'awarded', awards = v_resolved, settled_at = pg_catalog.now()
     WHERE b.post_id = p_post_id RETURNING * INTO v_row;
    PERFORM public.forum_bounty_settled(p_post_id, v_uid);
    RETURN v_row;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_award(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_award(UUID, JSONB) TO authenticated;

-- 到期:截止后再过 24 小时还没结的,按 forum_bounty_close 结掉。先锁帖子再锁悬赏(与所有写同序),锁不到的下一轮再说。
CREATE FUNCTION public.forum_settle_expired()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_post_id UUID;
    v_bounty public.forum_bounties;
    v_count INTEGER := 0;
BEGIN
    FOR v_post_id IN
        SELECT b.post_id FROM public.forum_bounties b
         WHERE b.status = 'open' AND b.deadline_at + INTERVAL '24 hours' < pg_catalog.now()
         ORDER BY b.deadline_at
    LOOP
        PERFORM 1 FROM public.forum_posts p WHERE p.id = v_post_id FOR UPDATE SKIP LOCKED;
        CONTINUE WHEN NOT FOUND;
        SELECT * INTO v_bounty FROM public.forum_bounties b WHERE b.post_id = v_post_id FOR UPDATE;
        CONTINUE WHEN v_bounty.status <> 'open';
        PERFORM public.forum_bounty_close(v_bounty);
        PERFORM public.forum_bounty_settled(v_post_id, NULL);
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_settle_expired() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forum_settle_expired() TO service_role;

-- 起步 10 分:注册满 3 天、在一台设备上认领过免费额度、还没领过的人。唯一键保证一人一次。
CREATE FUNCTION public.forum_points_signup_sweep()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_count INTEGER;
BEGIN
    INSERT INTO public.forum_community_points (user_id, delta, source, ref)
    SELECT u.id, 10, 'signup', 'signup'
      FROM identity.users u
     WHERE u.type = 'human' AND public.forum_account_established(u.id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_points_signup_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forum_points_signup_sweep() TO service_role;

-- 中台(gugu-console)的认可发分与冲正,只给 service_role。操作者、理由、来源必填;单笔 |delta| ≤ 100;错了用冲正,不改原记录。
CREATE FUNCTION public.forum_points_grant(p_operator TEXT, p_user_id TEXT, p_delta BIGINT, p_reason TEXT, p_source TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_id BIGINT;
BEGIN
    IF btrim(COALESCE(p_operator, '')) = '' THEN RAISE EXCEPTION '操作者不能为空'; END IF;
    IF btrim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION '理由必填'; END IF;
    IF btrim(COALESCE(p_source, '')) = '' THEN RAISE EXCEPTION '来源必填'; END IF;
    IF p_delta IS NULL OR p_delta = 0 OR abs(p_delta) > 100 THEN
        RAISE EXCEPTION '单笔积分须在 −100 到 100 之间且不为 0';
    END IF;
    PERFORM public.forum_points_lock(p_user_id);
    INSERT INTO public.forum_community_points (user_id, delta, source, ref, reason, operator)
    VALUES (p_user_id, p_delta, 'admin_grant', btrim(p_source), btrim(p_reason), btrim(p_operator))
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_points_grant(TEXT, TEXT, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forum_points_grant(TEXT, TEXT, BIGINT, TEXT, TEXT) TO service_role;

CREATE FUNCTION public.forum_points_reverse(p_operator TEXT, p_event_id BIGINT, p_reason TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_orig public.forum_community_points;
    v_id BIGINT;
BEGIN
    IF btrim(COALESCE(p_operator, '')) = '' THEN RAISE EXCEPTION '操作者不能为空'; END IF;
    IF btrim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION '理由必填 —— 冲正本身也是一次改账'; END IF;
    SELECT * INTO v_orig FROM public.forum_community_points p WHERE p.id = p_event_id;
    IF NOT FOUND OR v_orig.source <> 'admin_grant' THEN
        RAISE EXCEPTION '仅可冲正运营发放的积分(记录 % 不是)', p_event_id;
    END IF;
    PERFORM public.forum_points_lock(v_orig.user_id);
    -- 唯一键 (admin_reversal, <原记录 id>, user) 保证一条只冲一次。
    INSERT INTO public.forum_community_points (user_id, delta, source, ref, reason, operator)
    VALUES (v_orig.user_id, -v_orig.delta, 'admin_reversal', v_orig.id::text, btrim(p_reason), btrim(p_operator))
    RETURNING id INTO v_id;
    RETURN v_id;
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION '记录 % 已冲正', p_event_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_points_reverse(TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forum_points_reverse(TEXT, BIGINT, TEXT) TO service_role;

-- ── ⑩ 读 ─────────────────────────────────────────────────────────────────────────────────
-- 论坛列表。p_sort: active | new | amount | deadline;p_filter: all | bounty_open | bounty_settled;p_mine: posted | answered | NULL。
-- reply_count 只是个数(「仅楼主可见」的悬赏里,别人也只看得到个数)。author_points = 作者的社区积分(公开)。
CREATE FUNCTION public.forum_list_posts(
    p_query TEXT DEFAULT NULL, p_sort TEXT DEFAULT 'active', p_filter TEXT DEFAULT 'all', p_mine TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 30, p_offset INTEGER DEFAULT 0
)
RETURNS TABLE(
    post_id UUID, title TEXT, excerpt TEXT, author_user_id TEXT, author_name TEXT, author_avatar TEXT, author_points BIGINT,
    created_at TIMESTAMPTZ, last_activity_at TIMESTAMPTZ, reply_count INTEGER,
    amount BIGINT, visibility TEXT, deadline_at TIMESTAMPTZ, bounty_status TEXT, awards JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
    v_uid TEXT := (SELECT auth.uid()::text);
    v_needle TEXT := '%' || replace(replace(replace(btrim(COALESCE(p_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;
    IF COALESCE(p_sort, 'active') NOT IN ('active', 'new', 'amount', 'deadline')
       OR COALESCE(p_filter, 'all') NOT IN ('all', 'bounty_open', 'bounty_settled')
       OR (p_mine IS NOT NULL AND p_mine NOT IN ('posted', 'answered')) THEN
        RAISE EXCEPTION 'forum_list_posts: sort is active|new|amount|deadline, filter is all|bounty_open|bounty_settled, mine is posted|answered'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN QUERY
    SELECT p.id, p.title, left(p.body, 200), p.author_user_id, u.display_name, u.avatar, u.community_points,
           p.created_at, p.last_activity_at,
           (SELECT count(*)::INTEGER FROM public.forum_replies r WHERE r.post_id = p.id AND r.deleted_at IS NULL),
           b.amount, b.visibility, b.deadline_at, b.status, b.awards
      FROM public.forum_posts p
      LEFT JOIN public.forum_bounties b ON b.post_id = p.id
      LEFT JOIN identity.users u ON u.id = p.author_user_id
     WHERE p.deleted_at IS NULL
       AND (btrim(COALESCE(p_query, '')) = '' OR p.title ILIKE v_needle OR p.body ILIKE v_needle OR u.display_name ILIKE v_needle)
       AND (COALESCE(p_filter, 'all') = 'all'
            OR (p_filter = 'bounty_open' AND b.status = 'open')
            OR (p_filter = 'bounty_settled' AND b.status <> 'open'))
       AND (p_mine IS NULL
            OR (p_mine = 'posted' AND p.author_user_id = v_uid)
            OR (p_mine = 'answered' AND p.author_user_id IS DISTINCT FROM v_uid AND EXISTS (
                    SELECT 1 FROM public.forum_participants fp WHERE fp.post_id = p.id AND fp.owner_user_id = v_uid)))
     ORDER BY CASE WHEN p_sort = 'amount' THEN b.amount END DESC NULLS LAST,
              CASE WHEN p_sort = 'deadline' THEN b.deadline_at END ASC NULLS LAST,
              CASE WHEN p_sort = 'new' THEN p.created_at END DESC NULLS LAST,
              p.last_activity_at DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 100))
    OFFSET GREATEST(0, COALESCE(p_offset, 0));
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_list_posts(TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_list_posts(TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) TO authenticated;

-- 读的人自己:身份与社区积分(论坛 App 的页头;积分是公开的,这里只是省去客户端另读 identity.users)。
CREATE FUNCTION public.forum_me()
RETURNS TABLE(user_id TEXT, community_points BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF (SELECT auth.uid()) IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT u.id, u.community_points FROM identity.users u WHERE u.id = (SELECT auth.uid()::text);
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_me() TO authenticated;

-- 读一个帖子,按 p_as 这个身份能看到的(agent 读时传它自己,❌ 用主人的视角)。返回
-- {post, bounty, replies[], reactions[], assignments[], seq};assignments 只给读的人这一家的 agent(投递状态给主人看)。
CREATE FUNCTION public.forum_read_post(p_post_id UUID, p_as TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor TEXT := public.forum_actor(p_as);
    v_owner TEXT := public.forum_owner_of(v_actor);
    v_post public.forum_posts;
BEGIN
    SELECT * INTO v_post FROM public.forum_posts p WHERE p.id = p_post_id AND p.deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'forum_post_not_found' USING ERRCODE = 'P0002';
    END IF;
    RETURN jsonb_build_object(
        'seq', v_post.event_seq,
        'post', (SELECT jsonb_build_object(
                     'id', v_post.id, 'title', v_post.title, 'body', v_post.body, 'created_at', v_post.created_at,
                     'author_user_id', v_post.author_user_id, 'author_name', u.display_name, 'author_avatar', u.avatar,
                     'author_points', u.community_points)
                   FROM (SELECT 1) one LEFT JOIN identity.users u ON u.id = v_post.author_user_id),
        'bounty', (SELECT to_jsonb(b) - 'had_answer' FROM public.forum_bounties b WHERE b.post_id = p_post_id),
        'replies', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', r.id, 'body', r.body, 'created_at', r.created_at, 'to_poster_only', r.to_poster_only,
                       'reply_to', r.reply_to, 'author_user_id', r.author_user_id, 'author_name', a.display_name,
                       'author_avatar', a.avatar, 'author_is_agent', a.type = 'agent', 'owner_user_id', r.owner_user_id,
                       'owner_name', o.display_name, 'owner_points', o.community_points)
                   ORDER BY r.created_at, r.id)
              FROM public.forum_replies r
              LEFT JOIN identity.users a ON a.id = r.author_user_id
              LEFT JOIN identity.users o ON o.id = r.owner_user_id
             WHERE r.post_id = p_post_id
               AND public.forum_reply_visible(r.deleted_at, r.to_poster_only, r.owner_user_id, v_post.author_user_id, v_actor, v_owner)
        ), '[]'::jsonb),
        'reactions', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('target_kind', g.target_kind, 'target_id', g.target_id, 'emoji', g.emoji,
                                                'count', g.n, 'mine', g.mine))
              FROM (SELECT x.target_kind, x.target_id, x.emoji, count(*) AS n, bool_or(x.user_id = v_actor) AS mine
                      FROM public.forum_reactions x
                      LEFT JOIN public.forum_replies r ON x.target_kind = 'reply' AND r.id = x.target_id
                     WHERE x.post_id = p_post_id
                       AND (x.target_kind = 'post'
                            OR public.forum_reply_visible(r.deleted_at, r.to_poster_only, r.owner_user_id,
                                                          v_post.author_user_id, v_actor, v_owner))
                     GROUP BY x.target_kind, x.target_id, x.emoji) g
        ), '[]'::jsonb),
        'assignments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('agent_user_id', s.agent_user_id, 'agent_name', u.display_name,
                                                'delivery_state', s.delivery_state, 'last_error', s.last_error,
                                                'updated_at', s.updated_at) ORDER BY s.created_at)
              FROM public.forum_assignments s
              JOIN identity.users u ON u.id = s.agent_user_id
             WHERE s.post_id = p_post_id AND u.owner_user_id = v_owner
        ), '[]'::jsonb)
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_read_post(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_read_post(UUID, TEXT) TO authenticated;

-- ── ⑪ agent 的收件箱:拉、确认、记失败 ──────────────────────────────────────────────────────
-- 这个 agent 各指派里 seq > acked_seq、并且该投给它的事件(谓词同入队),连同帖子摘要和回复正文(它看得到的才有)。
CREATE FUNCTION public.forum_pull_agent_inbox(p_agent TEXT, p_limit INTEGER DEFAULT 50)
RETURNS TABLE(
    post_id UUID, seq BIGINT, kind TEXT, entity_id TEXT, actor_user_id TEXT, actor_name TEXT, actor_is_agent BOOLEAN,
    created_at TIMESTAMPTZ, post_title TEXT, post_body TEXT, post_author_id TEXT, post_author_name TEXT, bounty JSONB,
    reply_body TEXT, reply_to_poster_only BOOLEAN, reply_to UUID, reply_count INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
    IF (SELECT auth.uid()) IS NULL OR NOT EXISTS (
        SELECT 1 FROM identity.users u WHERE u.id = p_agent AND u.type = 'agent' AND u.owner_user_id = (SELECT auth.uid()::text)
    ) THEN
        RAISE EXCEPTION 'forum: not allowed to act as %', p_agent USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT e.post_id, e.seq, e.kind, e.entity_id, e.actor_user_id, au.display_name, au.type = 'agent', e.created_at,
           p.title, p.body, p.author_user_id, pu.display_name,
           (SELECT to_jsonb(b) - 'had_answer' FROM public.forum_bounties b WHERE b.post_id = p.id),
           r.body, r.to_poster_only, r.reply_to,
           (SELECT count(*)::INTEGER FROM public.forum_replies rr WHERE rr.post_id = p.id AND rr.deleted_at IS NULL)
      FROM public.forum_assignments a
      JOIN public.forum_post_events e ON e.post_id = a.post_id AND e.seq > a.acked_seq
      JOIN public.forum_posts p ON p.id = e.post_id
      LEFT JOIN identity.users au ON au.id = e.actor_user_id
      LEFT JOIN identity.users pu ON pu.id = p.author_user_id
      LEFT JOIN public.forum_replies r ON e.kind = 'reply' AND r.id = e.entity_id::uuid
     WHERE a.agent_user_id = p_agent
       AND public.forum_agent_may_act(a.post_id, p_agent)
       AND public.forum_event_wakes_agent(e.post_id, e.seq, p_agent)
     ORDER BY e.post_id, e.seq
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_pull_agent_inbox(TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_pull_agent_inbox(TEXT, INTEGER) TO authenticated;

-- 注入被受理后确认到这一批的最大 seq。
CREATE FUNCTION public.forum_ack(p_agent TEXT, p_post_id UUID, p_seq BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF (SELECT auth.uid()) IS NULL OR NOT EXISTS (
        SELECT 1 FROM identity.users u WHERE u.id = p_agent AND u.type = 'agent' AND u.owner_user_id = (SELECT auth.uid()::text)
    ) THEN
        RAISE EXCEPTION 'forum: not allowed to act as %', p_agent USING ERRCODE = '42501';
    END IF;
    UPDATE public.forum_assignments a
       SET acked_seq = GREATEST(a.acked_seq, p_seq), delivery_state = 'delivered', last_error = NULL,
           updated_at = pg_catalog.now()
     WHERE a.post_id = p_post_id AND a.agent_user_id = p_agent;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'forum_agent_not_assigned' USING ERRCODE = 'P0002';
    END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_ack(TEXT, UUID, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_ack(TEXT, UUID, BIGINT) TO authenticated;

-- 失败记在指派上(主人在帖子里的指派条上看到):undelivered = 没投进去,游标没动,下一次触发会重投;
-- turn_failed = 投进去了、那一轮失败,游标已推进,不自动重跑。
CREATE FUNCTION public.forum_record_delivery_failure(p_agent TEXT, p_post_id UUID, p_state TEXT, p_error TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF (SELECT auth.uid()) IS NULL OR NOT EXISTS (
        SELECT 1 FROM identity.users u WHERE u.id = p_agent AND u.type = 'agent' AND u.owner_user_id = (SELECT auth.uid()::text)
    ) THEN
        RAISE EXCEPTION 'forum: not allowed to act as %', p_agent USING ERRCODE = '42501';
    END IF;
    IF p_state IS NULL OR p_state NOT IN ('undelivered', 'turn_failed') THEN
        RAISE EXCEPTION 'forum_record_delivery_failure: state is undelivered|turn_failed' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.forum_assignments a
       SET delivery_state = p_state, last_error = left(COALESCE(p_error, ''), 500), updated_at = pg_catalog.now()
     WHERE a.post_id = p_post_id AND a.agent_user_id = p_agent;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'forum_agent_not_assigned' USING ERRCODE = 'P0002';
    END IF;
    PERFORM realtime.send(
        jsonb_build_object('event', 'forum_changed', 'post_id', p_post_id, 'kind', 'delivery', 'entity_id', p_agent),
        'forum_changed',
        'gugu:forum:' || p_post_id::text,
        true
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_record_delivery_failure(TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_record_delivery_failure(TEXT, UUID, TEXT, TEXT) TO authenticated;

-- 设备命令执行前的复核,论坛这一支:调用者是命令的主人、agent 归这个主人、它此刻仍能在这个帖子里干活。
CREATE FUNCTION public.forum_assert_delivery_live(p_command_owner UUID, p_agent TEXT, p_post_id UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF (SELECT auth.role()) = 'authenticated' AND p_command_owner IS DISTINCT FROM (SELECT auth.uid()) THEN
        RAISE EXCEPTION 'device command owner does not match caller';
    ELSIF (SELECT auth.role()) NOT IN ('authenticated', 'service_role') THEN
        RAISE EXCEPTION 'device command post requires an authenticated runtime';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM identity.users u
                    WHERE u.id = p_agent AND u.type = 'agent' AND u.owner_user_id = p_command_owner::text) THEN
        RAISE EXCEPTION 'device command context does not match message';
    END IF;
    IF p_post_id IS NULL OR NOT public.forum_agent_may_act(p_post_id, p_agent) THEN
        RAISE EXCEPTION 'forum delivery is not live';
    END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.forum_assert_delivery_live(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- 复核按 payload.source 分支:没有 source = 聊天(下面这一段与 20260721100000 逐字相同);forum = 上面那一支;别的来源拒绝。
CREATE OR REPLACE FUNCTION identity.recheck_device_command_execution(p_id UUID, p_claim_token UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = identity, chat, public, pg_catalog
AS $$
DECLARE
    command_row identity.gugu_device_commands%ROWTYPE;
BEGIN
    SELECT * INTO command_row
    FROM identity.gugu_device_commands c
    WHERE c.id = p_id AND c.claim_token = p_claim_token
      AND c.status = 'running'
    LIMIT 1;
    IF NOT FOUND THEN RETURN false; END IF;
    IF command_row.type <> 'agent.deliver' THEN RETURN true; END IF;
    IF command_row.payload ? 'source' THEN
        IF command_row.payload->>'source' = 'forum' THEN
            PERFORM public.forum_assert_delivery_live(
                command_row.user_id,
                command_row.payload->>'agent_user_id',
                CASE WHEN (command_row.payload->>'post_id') ~* '^[0-9a-f-]{36}$'
                     THEN (command_row.payload->>'post_id')::uuid END
            );
            RETURN true;
        END IF;
        RAISE EXCEPTION 'device command source % is not known', command_row.payload->>'source';
    END IF;
    PERFORM identity.assert_device_command_post_context(
        p_id,
        p_claim_token,
        command_row.payload->>'agent_user_id',
        command_row.payload->>'chat_id',
        NULL,
        NULL
    );
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION identity.recheck_device_command_execution(UUID, UUID)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.recheck_device_command_execution(UUID, UUID)
    TO authenticated, service_role;

-- ── ⑫ 定时:每 10 分钟结一次到期的;每小时补一次起步分 ─────────────────────────────────────────
DO $schedule$
DECLARE
    v_cron_db TEXT := current_setting('cron.database_name', true);
    v_job     RECORD;
    v_owner   TEXT;
BEGIN
    IF v_cron_db IS NULL OR v_cron_db = '' THEN
        RAISE EXCEPTION 'pg_cron is not available on this server (cron.database_name is unset): forum jobs would have no caller';
    END IF;
    IF current_database() <> v_cron_db THEN
        RAISE WARNING
          'forum jobs not scheduled here: pg_cron schedules only from %, this is % (expected on scratch/verification databases)',
          v_cron_db, current_database();
        RETURN;
    END IF;
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
    FOR v_job IN SELECT * FROM (VALUES
        ('forum-settle-expired', '*/10 * * * *', 'public.forum_settle_expired()'),
        ('forum-points-signup', '17 * * * *', 'public.forum_points_signup_sweep()')
    ) AS j(name, cron, fn) LOOP
        -- 作业以调用 cron.schedule() 的那个角色身份运行(见 20261015140100):直接给到当前角色。
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_job.fn, current_user);
        PERFORM cron.unschedule(v_job.name) WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job.name);
        PERFORM cron.schedule(v_job.name, v_job.cron, 'SELECT ' || v_job.fn);
        SELECT username INTO v_owner FROM cron.job WHERE jobname = v_job.name;
        IF v_owner IS NULL THEN
            RAISE EXCEPTION '% was not scheduled (or is invisible to %)', v_job.name, current_user;
        END IF;
        IF NOT has_function_privilege(v_owner, v_job.fn, 'EXECUTE') THEN
            RAISE EXCEPTION 'cron job owner % cannot EXECUTE % — every run would fail 42501', v_owner, v_job.fn;
        END IF;
    END LOOP;
END
$schedule$;

NOTIFY pgrst, 'reload schema';

