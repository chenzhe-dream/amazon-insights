DROP TRIGGER data_snapshots_legacy_insert_closed ON data_snapshots;
DROP TRIGGER data_snapshots_update_immutable ON data_snapshots;

ALTER TABLE data_snapshots
  ADD COLUMN artifact_kind TEXT NOT NULL DEFAULT 'legacy'
  CHECK (artifact_kind IN ('legacy', 'voc', 'traffic'));

UPDATE data_snapshots
SET artifact_kind = 'voc'
WHERE snapshot_kind = 'voc';

CREATE TRIGGER data_snapshots_update_immutable
BEFORE UPDATE ON data_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_data_snapshot_mutation();

CREATE TRIGGER data_snapshots_legacy_insert_closed
BEFORE INSERT ON data_snapshots
FOR EACH ROW
WHEN (
  NEW.artifact_kind = 'legacy'
  OR (NEW.snapshot_kind IS NULL AND NEW.artifact_kind <> 'traffic')
)
EXECUTE FUNCTION close_legacy_data_snapshot_insert();

CREATE FUNCTION enforce_data_snapshot_artifact_kind()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.snapshot_kind = 'voc' AND NEW.artifact_kind <> 'voc')
    OR (NEW.artifact_kind = 'traffic' AND NEW.snapshot_kind IS NOT NULL)
  THEN
    RAISE EXCEPTION 'data snapshot artifact kind is inconsistent';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER data_snapshots_artifact_kind_consistency
BEFORE INSERT ON data_snapshots
FOR EACH ROW EXECUTE FUNCTION enforce_data_snapshot_artifact_kind();

CREATE UNIQUE INDEX data_snapshots_traffic_semantic_identity_idx
ON data_snapshots (
  run_id, artifact_kind, schema_version, marketplace, asins_json, data_cutoff_at
)
WHERE artifact_kind = 'traffic';

CREATE FUNCTION enforce_traffic_data_snapshot_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff_text TEXT;
BEGIN
  cutoff_text := to_char(
    NEW.data_cutoff_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );

  IF NEW.schema_version <> '1.0.0'
    OR jsonb_typeof(NEW.asins_json) <> 'array'
    OR jsonb_array_length(NEW.asins_json) < 1
    OR jsonb_typeof(NEW.sources_json) <> 'array'
    OR jsonb_array_length(NEW.sources_json) <> 2
    OR jsonb_typeof(NEW.payload_json) <> 'object'
    OR jsonb_typeof(NEW.payload_json -> 'input') <> 'object'
    OR NEW.payload_json #>> '{input,kind}' <> 'competitor-traffic-analysis-input'
    OR NEW.payload_json #>> '{input,marketplace}' <> NEW.marketplace
    OR NEW.payload_json #>> '{input,dataCutoffAt}' <> cutoff_text
    OR NEW.content_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid traffic data snapshot';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER data_snapshots_traffic_insert_consistency
BEFORE INSERT ON data_snapshots
FOR EACH ROW
WHEN (NEW.artifact_kind = 'traffic')
EXECUTE FUNCTION enforce_traffic_data_snapshot_insert();
