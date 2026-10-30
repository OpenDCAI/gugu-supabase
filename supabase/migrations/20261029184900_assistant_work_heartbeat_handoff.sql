-- A resumed target takes delivery eligibility back from its delegate. Prompt its
-- existing pump when work is due instead of waiting for the five-minute scan.
-- These receipts deduplicate hints; events remain the only delivery outbox.
CREATE TABLE identity.assistant_work_ready_hints (
    event_seq bigint PRIMARY KEY REFERENCES identity.assistant_work_events(seq) ON DELETE CASCADE,
    target_device_id text NOT NULL,
    eligible_at timestamptz NOT NULL
);
ALTER TABLE identity.assistant_work_ready_hints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.assistant_work_ready_hints FROM PUBLIC,anon,authenticated;

CREATE INDEX assistant_work_events_active_target ON identity.assistant_work_events(owner_user_id,seq)
    WHERE delivery_state IN ('pending','claimed');

CREATE FUNCTION identity.assistant_work_prompt_ready_target() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_now timestamptz := clock_timestamp(); v_count integer; v_resumed boolean;
BEGIN
    IF (TG_OP='UPDATE' AND NEW.last_heartbeat_at IS NOT DISTINCT FROM OLD.last_heartbeat_at)
      OR NEW.last_heartbeat_at<=v_now-interval '90 seconds'
      OR NOT EXISTS (SELECT 1 FROM identity.gugu_devices d
        WHERE d.device_id=NEW.device_id AND d.user_id=NEW.owner_user_id) THEN
        RETURN NEW;
    END IF;
    -- A broadcast receipt only proves publication, not receipt by the target.
    -- Re-prompt once when the device returns, even for the same retry epoch.
    IF TG_OP='UPDATE' THEN
        v_resumed := OLD.last_heartbeat_at<=v_now-interval '90 seconds';
    ELSE
        v_resumed := true;
    END IF;
    v_resumed := v_resumed AND NOT EXISTS (
      SELECT 1 FROM identity.runtime_instances r
      WHERE r.device_id=NEW.device_id AND r.owner_user_id=NEW.owner_user_id
        AND r.instance_id<>NEW.instance_id AND r.last_heartbeat_at>v_now-interval '90 seconds');
    WITH candidates AS MATERIALIZED (
      SELECT e.seq,ready.eligible_at FROM identity.assistant_work_events e
      CROSS JOIN LATERAL (SELECT CASE WHEN e.kind='dispatch' THEN e.to_device_id
        ELSE identity.assistant_work_coordinator(e.owner_user_id,e.work_id)->>'device_id' END AS device_id,
        CASE WHEN e.delivery_state='pending' THEN e.available_at ELSE e.lease_until END AS eligible_at) ready
      LEFT JOIN identity.assistant_work_ready_hints prior ON prior.event_seq=e.seq
      WHERE e.owner_user_id=NEW.owner_user_id::text AND ready.device_id=NEW.device_id
        AND e.platform_received_at>v_now-interval '24 hours'
        AND ((e.delivery_state='pending' AND e.available_at<=v_now)
          OR (e.delivery_state='claimed' AND e.lease_until<v_now))
        AND NOT EXISTS (SELECT 1 FROM identity.assistant_work_claimant_cooldowns c
          WHERE c.event_seq=e.seq AND c.device_id=NEW.device_id AND c.retry_after>v_now)
        AND NOT EXISTS (
          SELECT 1 FROM identity.assistant_work_events older
          WHERE older.owner_user_id=e.owner_user_id AND older.work_id=e.work_id AND older.seq<e.seq
            AND older.delivery_state IN ('pending','claimed') AND (
              (e.kind<>'dispatch' AND older.kind<>'dispatch') OR
              (e.kind='dispatch' AND older.kind='dispatch' AND older.to_device_id=e.to_device_id
                AND older.to_session_id=e.to_session_id)))
        AND (v_resumed OR prior.event_seq IS NULL OR prior.target_device_id IS DISTINCT FROM NEW.device_id
          OR prior.eligible_at IS DISTINCT FROM ready.eligible_at)
      -- A heartbeat must neither block a delivery nor remember a stale snapshot
      -- after a concurrent admission has retired its hint.
      ORDER BY e.seq FOR UPDATE OF e SKIP LOCKED LIMIT 100
    )
    INSERT INTO identity.assistant_work_ready_hints AS hinted(event_seq,target_device_id,eligible_at)
      SELECT seq,NEW.device_id,eligible_at FROM candidates
      ON CONFLICT(event_seq) DO UPDATE SET target_device_id=EXCLUDED.target_device_id,eligible_at=EXCLUDED.eligible_at
        WHERE v_resumed OR hinted.target_device_id IS DISTINCT FROM EXCLUDED.target_device_id
          OR hinted.eligible_at IS DISTINCT FROM EXCLUDED.eligible_at;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN
        PERFORM chat.send_user_event('{}'::jsonb,'assistant_work_changed','gugu:user:'||NEW.owner_user_id::text||':events',true);
    END IF;
    RETURN NEW;
EXCEPTION
    -- PostgreSQL excludes query_canceled from OTHERS. A publication timeout is
    -- also best effort: roll back its hint receipt, preserving the heartbeat.
    WHEN query_canceled THEN
        RAISE LOG 'Assistant work ready hint failed (SQLSTATE %)',SQLSTATE;
        RETURN NEW;
    WHEN OTHERS THEN
        RAISE LOG 'Assistant work ready hint failed (SQLSTATE %)',SQLSTATE;
        RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_prompt_ready_target() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER runtime_instances_prompt_ready_work AFTER INSERT OR UPDATE OF last_heartbeat_at
    ON identity.runtime_instances FOR EACH ROW EXECUTE FUNCTION identity.assistant_work_prompt_ready_target();

-- A settled event no longer needs a hint receipt. Keep the original work history.
CREATE FUNCTION identity.assistant_work_retire_ready_hint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.delivery_state IN ('admitted','abandoned') THEN
        DELETE FROM identity.assistant_work_ready_hints WHERE event_seq=NEW.seq;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.assistant_work_retire_ready_hint() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER assistant_work_retire_ready_hint AFTER UPDATE OF delivery_state
    ON identity.assistant_work_events FOR EACH ROW EXECUTE FUNCTION identity.assistant_work_retire_ready_hint();
