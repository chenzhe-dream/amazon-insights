CREATE OR REPLACE FUNCTION enforce_keyword_analysis_snapshot_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_value JSONB;
BEGIN
  IF NEW.marketplace NOT IN ('US', 'UK', 'DE', 'CA')
    OR jsonb_typeof(NEW.asins_json) <> 'array'
    OR jsonb_array_length(NEW.asins_json) < 1
    OR jsonb_typeof(NEW.sources_json) <> 'array'
    OR jsonb_array_length(NEW.sources_json) < 1
    OR jsonb_typeof(NEW.payload_json) <> 'object'
    OR jsonb_typeof(NEW.payload_json -> 'groups') <> 'array'
    OR jsonb_array_length(NEW.payload_json -> 'groups') < 1
    OR jsonb_typeof(NEW.payload_json -> 'evidence') <> 'array'
    OR jsonb_array_length(NEW.payload_json -> 'evidence') < 1
    OR NEW.content_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid keyword analysis snapshot';
  END IF;

  FOR source_value IN SELECT value FROM jsonb_array_elements(NEW.sources_json)
  LOOP
    IF jsonb_typeof(source_value) <> 'object'
      OR jsonb_typeof(source_value -> 'id') <> 'string'
      OR char_length(source_value ->> 'id') < 1
      OR jsonb_typeof(source_value -> 'type') <> 'string'
      OR source_value ->> 'type' <> 'deterministic-analysis'
      OR jsonb_typeof(source_value -> 'capturedAt') <> 'string'
      OR NOT voc_is_canonical_utc_millis(source_value ->> 'capturedAt')
      OR (source_value ->> 'capturedAt')::timestamptz > NEW.data_cutoff_at
      OR jsonb_typeof(source_value -> 'checksum') <> 'string'
      OR source_value ->> 'checksum' !~ '^[0-9a-f]{64}$'
    THEN
      RAISE EXCEPTION 'invalid keyword analysis snapshot';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

