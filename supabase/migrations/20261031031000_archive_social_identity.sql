-- Social removal changes the identity, not its seats or its historical messages.
ALTER TABLE identity.users ADD COLUMN removed_at timestamptz;
GRANT SELECT (removed_at) ON identity.users TO authenticated;

CREATE FUNCTION identity.user_is_live(p_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM identity.users u WHERE u.id = p_user_id AND u.removed_at IS NULL)
$$;
REVOKE ALL ON FUNCTION identity.user_is_live(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.user_is_live(text) TO authenticated, service_role, gugu_files;

CREATE VIEW chat.active_members WITH (security_invoker = true) AS
  SELECT m.* FROM chat.chat_members m WHERE identity.user_is_live(m.user_id);
REVOKE ALL ON chat.active_members FROM PUBLIC, anon;
GRANT SELECT ON chat.active_members TO authenticated, service_role, gugu_files;

CREATE FUNCTION identity.guard_removed_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'identity_removed: restoring requires a new identity' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.guard_removed_identity() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER users_guard_removed_identity BEFORE UPDATE ON identity.users
  FOR EACH ROW EXECUTE FUNCTION identity.guard_removed_identity();

CREATE FUNCTION identity.archive_user(p_user_id text, p_remove_social_identity boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target identity.users%ROWTYPE; caller text := auth.uid()::text;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_remove_social_identity IS NULL THEN
    RAISE EXCEPTION 'remove_social_identity must be a boolean' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO target FROM identity.users u
    WHERE u.id = p_user_id AND (u.id = caller OR (u.type = 'agent' AND u.owner_user_id = caller))
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Identity is not owned by current user' USING ERRCODE = '42501'; END IF;
  IF target.removed_at IS NOT NULL AND NOT p_remove_social_identity THEN
    RAISE EXCEPTION 'identity_removed: restoring requires a new identity' USING ERRCODE = '55000';
  END IF;
  IF target.removed_at IS NULL AND NOT identity.user_is_live(caller) THEN
    RAISE EXCEPTION 'Identity is not active' USING ERRCODE = '42501';
  END IF;
  IF p_remove_social_identity AND target.removed_at IS NULL THEN
    UPDATE identity.users SET removed_at = clock_timestamp() WHERE id = target.id
      RETURNING * INTO target;
  END IF;
  -- false leaves social state alone; the host keeps its existing revisioned
  -- set_agent_session_archival/offline-interval path. No membership DML here.
  RETURN jsonb_build_object('user_id', target.id, 'removed_at', target.removed_at,
    'remove_social_identity', p_remove_social_identity);
END;
$$;
REVOKE ALL ON FUNCTION identity.archive_user(text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.archive_user(text,boolean) TO authenticated;

-- Compatibility entry, with the same irreversible archive semantics. The client
-- offers archive only; old callers must not retain a destructive second path.
CREATE OR REPLACE FUNCTION identity.remove_owned_agent(p_agent_user_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity.users u WHERE u.id = p_agent_user_id
    AND u.type = 'agent' AND u.owner_user_id = auth.uid()::text) THEN
    RAISE EXCEPTION 'Agent is not owned by current user' USING ERRCODE = '42501';
  END IF;
  PERFORM identity.archive_user(p_agent_user_id, true);
END;
$$;
REVOKE ALL ON FUNCTION identity.remove_owned_agent(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.remove_owned_agent(text) TO authenticated;
