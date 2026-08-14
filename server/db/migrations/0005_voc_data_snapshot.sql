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
    NEW.schema_version IS NOT '1.0.0'
    OR length(NEW.marketplace) IS NOT 2
    OR NEW.marketplace IS NOT upper(NEW.marketplace)
    OR length(NEW.content_hash) IS NOT 64
    OR NEW.content_hash IS NOT lower(NEW.content_hash)
    OR NEW.content_hash GLOB '*[^0-9a-f]*'
    OR json_type(NEW.asins_json) IS NOT 'array'
    OR json_array_length(NEW.asins_json) < 1
    OR NEW.asins_json IS NOT json(NEW.asins_json)
    OR json_type(NEW.sources_json) IS NOT 'array'
    OR json_array_length(NEW.sources_json) < 1
    OR NEW.sources_json IS NOT json(NEW.sources_json)
    OR json_type(NEW.payload_json) IS NOT 'object'
    OR NEW.payload_json IS NOT json(NEW.payload_json)
    OR NEW.data_cutoff_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', NEW.data_cutoff_at)
    OR NEW.created_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at)
  THEN RAISE(ABORT, 'invalid VOC data snapshot') END;

  SELECT CASE WHEN
    (SELECT count(*) FROM json_each(NEW.payload_json)) IS NOT 5
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.payload_json) field
      WHERE field.key NOT IN ('schemaVersion', 'kind', 'marketplace', 'asins', 'records')
    )
    OR json_type(NEW.payload_json, '$.schemaVersion') IS NOT 'text'
    OR json_extract(NEW.payload_json, '$.schemaVersion') IS NOT NEW.schema_version
    OR json_type(NEW.payload_json, '$.kind') IS NOT 'text'
    OR json_extract(NEW.payload_json, '$.kind') IS NOT 'voc'
    OR json_type(NEW.payload_json, '$.marketplace') IS NOT 'text'
    OR json_extract(NEW.payload_json, '$.marketplace') IS NOT NEW.marketplace
    OR json_type(NEW.payload_json, '$.asins') IS NOT 'array'
    OR json(json_extract(NEW.payload_json, '$.asins')) IS NOT NEW.asins_json
    OR json_type(NEW.payload_json, '$.records') IS NOT 'object'
    OR (SELECT count(*) FROM json_each(json_extract(NEW.payload_json, '$.records'))) IS NOT 3
    OR EXISTS (
      SELECT 1
      FROM json_each(json_extract(NEW.payload_json, '$.records')) field
      WHERE field.key NOT IN (
        'alexaVoc', 'sorftimeReviewAnalysis', 'sellerSpriteReviewAnalysis'
      )
    )
    OR json_type(NEW.payload_json, '$.records.alexaVoc') IS NOT 'array'
    OR json_type(NEW.payload_json, '$.records.sorftimeReviewAnalysis') IS NOT 'array'
    OR json_type(NEW.payload_json, '$.records.sellerSpriteReviewAnalysis') IS NOT 'array'
  THEN RAISE(ABORT, 'invalid VOC snapshot payload') END;

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
    WHERE json_type(source.value) IS NOT 'object'
      OR (SELECT count(*) FROM json_each(source.value)) IS NOT 5
      OR EXISTS (
        SELECT 1 FROM json_each(source.value) field
        WHERE field.key NOT IN (
          'type', 'reference', 'marketplace', 'capturedAt', 'checksum'
        )
      )
      OR json_type(source.value, '$.type') IS NOT 'text'
      OR json_extract(source.value, '$.type') NOT IN ('connector', 'manual-voc')
      OR json_type(source.value, '$.reference') IS NOT 'text'
      OR length(json_extract(source.value, '$.reference')) NOT BETWEEN 1 AND 500
      OR json_type(source.value, '$.marketplace') IS NOT 'text'
      OR json_extract(source.value, '$.marketplace') IS NOT NEW.marketplace
      OR length(json_extract(source.value, '$.marketplace')) IS NOT 2
      OR json_extract(source.value, '$.marketplace') IS NOT upper(
        json_extract(source.value, '$.marketplace')
      )
      OR json_type(source.value, '$.capturedAt') IS NOT 'text'
      OR json_extract(source.value, '$.capturedAt') IS NOT strftime(
        '%Y-%m-%dT%H:%M:%fZ', json_extract(source.value, '$.capturedAt')
      )
      OR julianday(json_extract(source.value, '$.capturedAt'))
        > julianday(NEW.data_cutoff_at)
      OR json_type(source.value, '$.checksum') IS NOT 'text'
      OR length(json_extract(source.value, '$.checksum')) IS NOT 64
      OR json_extract(source.value, '$.checksum') IS NOT lower(
        json_extract(source.value, '$.checksum')
      )
      OR json_extract(source.value, '$.checksum') GLOB '*[^0-9a-f]*'
  ) THEN RAISE(ABORT, 'invalid snapshot source provenance or snapshot sources exceed cutoff') END;
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
