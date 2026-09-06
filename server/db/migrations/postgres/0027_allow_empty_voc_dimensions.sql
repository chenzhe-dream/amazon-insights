DO $$
DECLARE
  function_definition TEXT;
  updated_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('enforce_voc_data_snapshot_insert()'::regprocedure)
    INTO function_definition;
  -- Empty dimensions are valid in the shared schema; retain its upper bounds and item checks.
  updated_definition := replace(
    function_definition,
    'OR jsonb_array_length(record_value -> field_name) < 1',
    'OR jsonb_array_length(record_value -> field_name) > 256'
  );
  updated_definition := replace(
    updated_definition,
    'OR char_length(item.value #>> ''{}'') < 1',
    'OR char_length(item.value #>> ''{}'') < 1' || E'\n              OR char_length(item.value #>> ''{}'') > 16384'
  );
  IF updated_definition = function_definition THEN
    RAISE EXCEPTION 'VOC snapshot validator does not contain the expected dimension constraint';
  END IF;
  EXECUTE updated_definition;
END
$$;
