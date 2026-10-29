-- 20261029050000_task_agent_name_serial kept the nine-argument provision_taskpage_agent as a thin
-- delegate for clients that predate name_serial, but did not mark the retained overload. Revoke and
-- restore that grant in one release so the marker covers it; no caller loses or gains a privilege.
REVOKE EXECUTE ON FUNCTION identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text)
  FROM authenticated;
-- gugu-allow-intentional-overload: identity.provision_taskpage_agent - nine-argument delegate for clients that predate name_serial; the ten-argument form has no defaults, so PostgREST resolves both
GRANT EXECUTE ON FUNCTION identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text)
  TO authenticated;
