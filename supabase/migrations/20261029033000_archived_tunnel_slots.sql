-- Archived machines retain their registrations and total-machine slots.
-- Only their remote tunnel slots are released after seven offline days.

CREATE OR REPLACE FUNCTION identity.gugu_machine_limit_refusal(p_user_id uuid, p_machine_id text, p_via text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'identity', 'public', 'pg_catalog'
    AS $$
DECLARE
  v_caller     UUID := auth.uid();
  v_plan_id    TEXT;
  v_max        INTEGER;
  v_max_tunnel INTEGER;
  v_via        TEXT;
  v_listed     BOOLEAN;
  v_listed_tun BOOLEAN;
  v_total_machines JSONB;
  v_tunnel_machines JSONB;
  v_others     INTEGER;
  v_others_tun INTEGER;
BEGIN
  -- 客户端(心跳触发器)只能替自己判;service_role 没有 auth.uid(),可以替任何人判。
  IF v_caller IS NOT NULL AND v_caller IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'gugu_machine_limit_refusal: can only check the caller''s own machines';
  END IF;
  IF p_user_id IS NULL OR NULLIF(p_machine_id, '') IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT max_machines, max_tunnel_machines, plan_id
    INTO v_max, v_max_tunnel, v_plan_id
    FROM identity.machine_limits_for(p_user_id);

  v_via := COALESCE(
    p_via,
    (SELECT e.via FROM identity.gugu_server_enrollments e WHERE e.user_id = p_user_id AND e.machine_id = p_machine_id),
    'tunnel'
  );

  -- Group every endpoint first, as Settings Devices does. Host kind and enrollment
  -- still decide which machines count; archiving only releases tunnel slots.
  WITH machines AS (
    SELECT COALESCE(NULLIF(d.machine_id, ''), d.device_id) AS machine_key,
           (array_agg(d.label ORDER BY (d.status = 'online') DESC, d.last_seen_at DESC, d.device_id))[1] AS label,
           array_agg(d.device_id ORDER BY d.device_id) AS device_ids,
           CASE WHEN bool_or(COALESCE(e.via, 'tunnel') = 'ssh') THEN 'ssh' ELSE 'tunnel' END AS via,
           NOT bool_or(d.status = 'online')
             AND max(d.last_seen_at) FILTER (WHERE isfinite(d.last_seen_at)) < now() - interval '7 days' AS archived
      FROM identity.gugu_devices d
      LEFT JOIN identity.gugu_server_enrollments e
        ON e.user_id = d.user_id AND e.machine_id = d.machine_id
     WHERE d.user_id = p_user_id
     GROUP BY COALESCE(NULLIF(d.machine_id, ''), d.device_id)
    HAVING bool_or(d.capabilities ->> 'host_kind' = 'server')
  ), occupants AS (
    SELECT m.*, jsonb_build_object('machine_id', m.machine_key, 'label', m.label, 'device_ids', m.device_ids) AS detail
      FROM machines m
  )
  SELECT bool_or(m.machine_key = p_machine_id),
         bool_or(m.machine_key = p_machine_id AND m.via = 'tunnel' AND NOT COALESCE(m.archived, false)),
         count(*) FILTER (WHERE m.machine_key <> p_machine_id),
         count(*) FILTER (WHERE m.machine_key <> p_machine_id AND m.via = 'tunnel' AND NOT COALESCE(m.archived, false)),
         COALESCE(jsonb_agg(m.detail ORDER BY m.machine_key) FILTER (WHERE m.machine_key <> p_machine_id), '[]'::jsonb),
         COALESCE(jsonb_agg(m.detail ORDER BY m.machine_key) FILTER (WHERE m.machine_key <> p_machine_id AND m.via = 'tunnel' AND NOT COALESCE(m.archived, false)), '[]'::jsonb)
    INTO v_listed, v_listed_tun, v_others, v_others_tun, v_total_machines, v_tunnel_machines
    FROM occupants m;
  v_listed := COALESCE(v_listed, FALSE);
  v_listed_tun := COALESCE(v_listed_tun, FALSE);

  -- 新机器才会让总数变大。
  IF NOT v_listed AND v_others + 1 > v_max THEN
    RETURN jsonb_build_object('limit', 'total', 'used', v_others, 'max', v_max, 'plan', v_plan_id,
      'machine_id', p_machine_id, 'via', v_via, 'machines', v_total_machines);
  END IF;
  -- 远程隧道数只在「这台原来不算隧道、这次要算」时变大。
  IF v_via = 'tunnel'
     AND NOT v_listed_tun
     AND v_others_tun + 1 > v_max_tunnel THEN
    RETURN jsonb_build_object('limit', 'tunnel', 'used', v_others_tun, 'max', v_max_tunnel, 'plan', v_plan_id,
      'machine_id', p_machine_id, 'via', v_via, 'machines', v_tunnel_machines);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION identity.gugu_devices_enforce_machine_limit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'identity', 'public', 'pg_catalog'
    AS $$
DECLARE
  v_refusal JSONB;
BEGIN
  IF pg_has_role(current_user, 'service_role', 'MEMBER') THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.capabilities ->> 'host_kind', '') <> 'server' THEN
    RETURN NEW;
  END IF;
  -- A heartbeat from an archived server occupies a slot again. Metadata edits
  -- and the lease sweeper do not add activity and must remain possible.
  IF TG_OP = 'UPDATE' AND OLD.capabilities ->> 'host_kind' = 'server'
     AND NEW.status <> 'online' AND NEW.last_seen_at IS NOT DISTINCT FROM OLD.last_seen_at THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM identity.gugu_devices d WHERE d.device_id = NEW.device_id) THEN
    RETURN NEW;
  END IF;
  -- 同一个账号并发加两台:串行判,❌ 两边都看见「还差一台」一起放进来。
  PERFORM pg_advisory_xact_lock(hashtextextended('gugu-machine-limit:' || NEW.user_id::text, 0));
  v_refusal := identity.gugu_machine_limit_refusal(NEW.user_id, COALESCE(NULLIF(NEW.machine_id, ''), NEW.device_id), NULL);
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'DEVICE_LIMIT_REACHED: %', v_refusal::text USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- SSH grants learn the target identity at poll time. Preserve that same identity
-- on refusal, as the successful consume path already does.
CREATE OR REPLACE FUNCTION identity.server_login_mark_refused(p_id uuid, p_user_id text, p_refusal jsonb) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'identity', 'public'
    AS $$
  UPDATE identity.server_login_requests
     SET status = 'refused', refusal = p_refusal, refused_user_id = p_user_id, refused_at = now(),
         machine_id = COALESCE(NULLIF(p_refusal ->> 'machine_id', ''), machine_id),
         decided_at = COALESCE(decided_at, now())
   WHERE id = p_id;
$$;

CREATE OR REPLACE FUNCTION identity.my_recent_machine_limit_refusal(p_since timestamptz) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'identity', 'public', 'pg_catalog'
    AS $$
  WITH latest AS (
    SELECT r.*, COALESCE(NULLIF(r.refusal ->> 'machine_id', ''), NULLIF(r.machine_id, '')) AS refused_machine_id
    FROM identity.server_login_requests r
    WHERE auth.uid() IS NOT NULL
      AND r.refused_user_id = auth.uid()::text
      AND r.refused_at >= p_since
    ORDER BY r.refused_at DESC
    LIMIT 1
  )
  SELECT CASE WHEN r.refused_machine_id IS NULL THEN r.refusal
              ELSE identity.gugu_machine_limit_refusal(auth.uid(), r.refused_machine_id, r.via) END
         || jsonb_build_object('hostname', r.machine ->> 'hostname', 'refused_at', r.refused_at)
    FROM latest r;
$$;

REVOKE ALL ON FUNCTION identity.gugu_machine_limit_refusal(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.gugu_machine_limit_refusal(uuid, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION identity.gugu_devices_enforce_machine_limit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION identity.my_recent_machine_limit_refusal(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.my_recent_machine_limit_refusal(timestamptz) TO authenticated;
REVOKE ALL ON FUNCTION identity.server_login_mark_refused(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.server_login_mark_refused(uuid, text, jsonb) TO service_role;
