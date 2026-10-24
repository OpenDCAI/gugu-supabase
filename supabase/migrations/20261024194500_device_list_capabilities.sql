-- Keep the full manifest stored once; device lists omit agent-only documentation.
CREATE FUNCTION identity.device_list_capabilities(identity.gugu_devices)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof($1.capabilities #> '{actions,actions}') = 'array'
    THEN jsonb_set(
      $1.capabilities,
      '{actions,actions}',
      COALESCE((
        SELECT jsonb_agg(
          entry.value - 'description' - 'input_schema'
          ORDER BY entry.ordinality
        )
        FROM jsonb_array_elements($1.capabilities #> '{actions,actions}')
          WITH ORDINALITY AS entry(value, ordinality)
      ), '[]'::jsonb),
      false
    )
    ELSE $1.capabilities
  END
$$;
REVOKE ALL ON FUNCTION identity.device_list_capabilities(identity.gugu_devices) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.device_list_capabilities(identity.gugu_devices) TO authenticated;
