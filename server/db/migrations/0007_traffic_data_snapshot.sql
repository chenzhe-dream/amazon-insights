DROP TRIGGER data_snapshots_legacy_insert_closed;
DROP TRIGGER data_snapshots_update_immutable;

ALTER TABLE data_snapshots ADD COLUMN artifact_kind TEXT NOT NULL DEFAULT 'legacy'
  CHECK (artifact_kind IN ('legacy', 'voc', 'traffic'));

UPDATE data_snapshots
SET artifact_kind = 'voc'
WHERE snapshot_kind = 'voc';

CREATE TRIGGER data_snapshots_update_immutable
BEFORE UPDATE ON data_snapshots
BEGIN
  SELECT RAISE(ABORT, 'data snapshots are immutable');
END;

CREATE TRIGGER data_snapshots_legacy_insert_closed
BEFORE INSERT ON data_snapshots
WHEN NEW.artifact_kind = 'legacy'
  OR (NEW.snapshot_kind IS NULL AND NEW.artifact_kind <> 'traffic')
BEGIN
  SELECT RAISE(ABORT, 'legacy data snapshot inserts are closed');
END;

CREATE TRIGGER data_snapshots_artifact_kind_consistency
BEFORE INSERT ON data_snapshots
WHEN (NEW.snapshot_kind = 'voc' AND NEW.artifact_kind <> 'voc')
  OR (NEW.artifact_kind = 'traffic' AND NEW.snapshot_kind IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'data snapshot artifact kind is inconsistent');
END;

CREATE UNIQUE INDEX data_snapshots_traffic_semantic_identity_idx
ON data_snapshots (
  run_id, artifact_kind, schema_version, marketplace, asins_json, data_cutoff_at
)
WHERE artifact_kind = 'traffic';

CREATE TRIGGER data_snapshots_traffic_insert_consistency
BEFORE INSERT ON data_snapshots
WHEN NEW.artifact_kind = 'traffic'
BEGIN
  SELECT CASE WHEN
    NEW.schema_version IS NOT '1.0.0'
    OR json_type(NEW.asins_json) IS NOT 'array'
    OR json_array_length(NEW.asins_json) < 1
    OR NEW.asins_json IS NOT json(NEW.asins_json)
    OR json_type(NEW.sources_json) IS NOT 'array'
    OR json_array_length(NEW.sources_json) IS NOT 2
    OR NEW.sources_json IS NOT json(NEW.sources_json)
    OR json_type(NEW.payload_json) IS NOT 'object'
    OR json_type(NEW.payload_json, '$.input') IS NOT 'object'
    OR json_extract(NEW.payload_json, '$.input.kind') IS NOT 'competitor-traffic-analysis-input'
    OR json_extract(NEW.payload_json, '$.input.marketplace') IS NOT NEW.marketplace
    OR json_extract(NEW.payload_json, '$.input.dataCutoffAt') IS NOT NEW.data_cutoff_at
    OR length(NEW.content_hash) IS NOT 64
    OR NEW.content_hash IS NOT lower(NEW.content_hash)
    OR NEW.content_hash GLOB '*[^0-9a-f]*'
  THEN RAISE(ABORT, 'invalid traffic data snapshot') END;
END;
