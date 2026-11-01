-- Group enrollment must not roll back an otherwise valid task identity. The legacy
-- nine-argument RPC delegates here too. Preserve the allocator, admission guards and ACL.
DO $enrollment$
DECLARE
    definition text;
    previous text;
BEGIN
    SELECT pg_get_functiondef('identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text,text)'::regprocedure)
      INTO previous;
    definition := replace(previous,
      '    IF p_group_name IS NOT NULL THEN',
      E'    IF p_group_name IS NOT NULL THEN\n      BEGIN');
    definition := replace(definition,
      E'        v_group := CASE WHEN v_prior = ''pending_approval'' THEN '''' ELSE v_target END;\n    END IF;',
      E'        v_group := CASE WHEN v_prior = ''pending_approval'' THEN '''' ELSE v_target END;\n'
      || E'      EXCEPTION WHEN OTHERS THEN\n'
      || E'        RAISE WARNING ''provision_taskpage_agent: project group enrollment failed for agent % in group % [%]: %'', v_minted.id, v_target, SQLSTATE, SQLERRM;\n'
      || E'        v_group := '''';\n'
      || E'        v_created := false;\n'
      || E'        v_prior := ''join_failed'';\n'
      || E'      END;\n    END IF;');
    IF definition = previous OR position('EXCEPTION WHEN OTHERS' in definition) = 0
      OR position(E'      BEGIN' in definition) = 0 THEN
        RAISE EXCEPTION 'Unexpected task agent group enrollment predecessor';
    END IF;
    EXECUTE definition;
END $enrollment$;
