ALTER TABLE data_snapshots ADD COLUMN snapshot_kind TEXT CHECK (
  snapshot_kind IS NULL OR snapshot_kind = 'voc'
);

CREATE UNIQUE INDEX data_snapshots_semantic_identity_idx
ON data_snapshots (run_id, schema_version, marketplace, asins_json, data_cutoff_at)
WHERE snapshot_kind = 'voc';

CREATE TRIGGER data_snapshots_insert_consistency
BEFORE INSERT ON data_snapshots
WHEN NEW.snapshot_kind = 'voc'
BEGIN
  SELECT CASE WHEN
    NEW.schema_version <> '1.0.0'
    OR length(NEW.content_hash) <> 64
    OR NEW.content_hash GLOB '*[^0-9a-f]*'
    OR json_type(NEW.asins_json) <> 'array'
    OR json_array_length(NEW.asins_json) < 1
    OR json_type(NEW.sources_json) <> 'array'
    OR json_array_length(NEW.sources_json) < 1
    OR json_type(NEW.payload_json) <> 'object'
    OR julianday(NEW.data_cutoff_at) IS NULL
    OR julianday(NEW.created_at) IS NULL
  THEN RAISE(ABORT, 'invalid VOC data snapshot') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM analysis_runs r
    JOIN projects p ON p.id = r.project_id
    WHERE r.id = NEW.run_id
      AND p.marketplace = NEW.marketplace
      AND p.asins_json = NEW.asins_json
      AND julianday(NEW.data_cutoff_at) <= julianday(r.data_cutoff_at)
  ) THEN RAISE(ABORT, 'snapshot target does not match run project') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.sources_json) source
    WHERE json_type(source.value) <> 'object'
      OR json_type(source.value, '$.type') <> 'text'
      OR json_extract(source.value, '$.type') NOT IN (
        'repository-data', 'connector', 'manual-voc', 'file-import', 'agent-report'
      )
      OR json_type(source.value, '$.reference') <> 'text'
      OR length(json_extract(source.value, '$.reference')) < 1
      OR json_type(source.value, '$.capturedAt') <> 'text'
      OR julianday(json_extract(source.value, '$.capturedAt')) IS NULL
      OR json_type(source.value, '$.checksum') <> 'text'
      OR length(json_extract(source.value, '$.checksum')) <> 64
      OR json_extract(source.value, '$.checksum') GLOB '*[^0-9a-f]*'
  ) THEN RAISE(ABORT, 'invalid snapshot source provenance') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.sources_json) source
    WHERE julianday(json_extract(source.value, '$.capturedAt'))
      > julianday(NEW.data_cutoff_at)
  ) THEN RAISE(ABORT, 'snapshot sources exceed cutoff') END;
END;

CREATE TRIGGER data_snapshots_update_immutable
BEFORE UPDATE ON data_snapshots
WHEN OLD.snapshot_kind = 'voc'
BEGIN
  SELECT RAISE(ABORT, 'data snapshots are immutable');
END;

CREATE TRIGGER data_snapshots_delete_immutable
BEFORE DELETE ON data_snapshots
WHEN OLD.snapshot_kind = 'voc'
BEGIN
  SELECT RAISE(ABORT, 'data snapshots are immutable');
END;
