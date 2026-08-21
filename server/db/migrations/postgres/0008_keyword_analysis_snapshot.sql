CREATE TABLE keyword_analysis_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
  marketplace TEXT NOT NULL,
  asins_json JSONB NOT NULL CHECK (jsonb_typeof(asins_json) = 'array'),
  data_cutoff_at TIMESTAMPTZ NOT NULL,
  sources_json JSONB NOT NULL CHECK (jsonb_typeof(sources_json) = 'array'),
  payload_json JSONB NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, schema_version, marketplace, asins_json, data_cutoff_at)
);

CREATE INDEX keyword_analysis_snapshots_run_idx
ON keyword_analysis_snapshots (run_id, created_at, id);

CREATE FUNCTION enforce_keyword_analysis_snapshot_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_value JSONB;
BEGIN
  IF NEW.marketplace <> 'US'
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

CREATE TRIGGER keyword_analysis_snapshots_insert_closed
BEFORE INSERT ON keyword_analysis_snapshots
FOR EACH ROW EXECUTE FUNCTION enforce_keyword_analysis_snapshot_insert();

CREATE FUNCTION prevent_keyword_analysis_snapshot_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'keyword analysis snapshots are immutable';
END;
$$;

CREATE TRIGGER keyword_analysis_snapshots_update_immutable
BEFORE UPDATE ON keyword_analysis_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_keyword_analysis_snapshot_update();
