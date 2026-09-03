-- sqlite-migration-mode: rebuild-with-foreign-keys-off

CREATE TABLE run_stages_next (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (
    stage IN (
      'traffic-analysis', 'alexa-voc-normalization', 'voc-positioning',
      'product-definition'
    )
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'running', 'waiting-input', 'succeeded', 'failed', 'skipped',
      'budget-exceeded', 'cancelled', 'stale'
    )
  ),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  started_at TEXT,
  completed_at TEXT,
  last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, stage)
) STRICT;

INSERT INTO run_stages_next SELECT * FROM run_stages;
DROP TRIGGER agent_runs_audit_insert_consistency;
DROP TRIGGER model_budget_attempt_provenance_immutable;
DROP TRIGGER model_budget_job_attempt_consistency;
DROP TABLE run_stages;
ALTER TABLE run_stages_next RENAME TO run_stages;
CREATE INDEX run_stages_run_status_idx ON run_stages (run_id, status);

CREATE TRIGGER agent_runs_audit_insert_consistency
BEFORE INSERT ON agent_runs
WHEN NEW.execution_fingerprint IS NOT NULL
  OR NEW.output_schema_digest IS NOT NULL
  OR NEW.usage_completeness IS NOT NULL
  OR NEW.attempt_count IS NOT NULL
  OR NEW.attempts_json IS NOT NULL
  OR NEW.execution_claim_token IS NOT NULL
  OR NEW.execution_claim_owner_id IS NOT NULL
  OR NEW.execution_claim_generation IS NOT NULL
  OR NEW.execution_claim_acquired_at IS NOT NULL
  OR NEW.execution_claim_expires_at IS NOT NULL
  OR NEW.terminal_metadata_json IS NOT NULL
BEGIN
  SELECT CASE WHEN
    NEW.execution_fingerprint IS NULL
    OR length(NEW.execution_fingerprint) <> 64
    OR NEW.execution_fingerprint <> lower(NEW.execution_fingerprint)
    OR NEW.execution_fingerprint GLOB '*[^0-9a-f]*'
    OR NEW.output_schema_digest IS NULL
    OR length(NEW.output_schema_digest) <> 64
    OR NEW.output_schema_digest <> lower(NEW.output_schema_digest)
    OR NEW.output_schema_digest GLOB '*[^0-9a-f]*'
    OR NEW.job_attempt_id IS NULL
    OR NEW.validation_status <> 'pending'
    OR NEW.terminal_status IS NOT NULL
    OR NEW.response_id IS NOT NULL
    OR NEW.output_json IS NOT NULL
    OR NEW.error_json IS NOT NULL
    OR NEW.input_tokens IS NOT NULL
    OR NEW.output_tokens IS NOT NULL
    OR NEW.duration_ms IS NOT NULL
    OR NEW.estimated_cost_micros IS NOT NULL
    OR NEW.usage_completeness IS NOT NULL
    OR NEW.attempt_count IS NOT NULL
    OR NEW.attempts_json <> '[]'
    OR NEW.execution_claim_token IS NULL
    OR NEW.execution_claim_owner_id IS NULL
    OR NEW.execution_claim_generation IS NULL
    OR NEW.execution_claim_acquired_at IS NULL
    OR NEW.execution_claim_expires_at IS NULL
    OR NEW.terminal_metadata_json IS NOT NULL
    OR unixepoch(NEW.execution_claim_acquired_at) IS NULL
    OR unixepoch(NEW.execution_claim_expires_at) IS NULL
    OR unixepoch(NEW.execution_claim_expires_at) <= unixepoch(NEW.execution_claim_acquired_at)
    OR NEW.completed_at IS NOT NULL
    OR json_array_length(NEW.snapshot_ids_json) < 1
  THEN RAISE(ABORT, 'invalid pending agent run audit') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM run_stages
    WHERE id = NEW.stage_id AND run_id = NEW.run_id
  ) THEN RAISE(ABORT, 'agent run stage does not belong to run') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM analysis_runs
    WHERE id = NEW.run_id
      AND julianday(data_cutoff_at) = julianday(NEW.data_cutoff_at)
  ) THEN RAISE(ABORT, 'agent run cutoff does not match run') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM job_attempts
    WHERE id = NEW.job_attempt_id AND stage_id = NEW.stage_id
      AND status = 'running'
      AND leased_by = NEW.execution_claim_owner_id
      AND lease_generation = NEW.execution_claim_generation
      AND unixepoch(lease_expires_at) > unixepoch(NEW.execution_claim_acquired_at)
  ) THEN RAISE(ABORT, 'agent run job does not belong to stage') END;
END;

CREATE TRIGGER model_budget_attempt_provenance_immutable
BEFORE UPDATE ON model_budget_reservations
WHEN OLD.job_attempt_id IS NOT NULL OR NEW.job_attempt_id IS NOT NULL
BEGIN
  SELECT CASE WHEN
    NEW.run_id IS NOT OLD.run_id
    OR NEW.job_attempt_id IS NOT OLD.job_attempt_id
    OR NEW.request_ordinal IS NOT OLD.request_ordinal
    OR NEW.attempt_kind IS NOT OLD.attempt_kind
    OR NEW.transient_retry_count IS NOT OLD.transient_retry_count
    OR NEW.format_repair IS NOT OLD.format_repair
  THEN RAISE(ABORT, 'model request attempt provenance is immutable') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM job_attempts ja
    JOIN run_stages rs ON rs.id = ja.stage_id
    WHERE ja.id = NEW.job_attempt_id AND rs.run_id = NEW.run_id
  ) THEN RAISE(ABORT, 'model request job no longer belongs to run') END;
END;

CREATE TRIGGER model_budget_job_attempt_consistency
BEFORE INSERT ON model_budget_reservations
WHEN NEW.job_attempt_id IS NOT NULL
  OR NEW.request_ordinal IS NOT NULL
  OR NEW.attempt_kind IS NOT NULL
  OR NEW.transient_retry_count IS NOT NULL
  OR NEW.format_repair IS NOT NULL
BEGIN
  SELECT CASE WHEN
    NEW.job_attempt_id IS NULL
    OR NEW.request_ordinal IS NULL
    OR NEW.attempt_kind IS NULL
    OR NEW.transient_retry_count IS NULL
    OR NEW.format_repair IS NULL
  THEN RAISE(ABORT, 'incomplete model request attempt provenance') END;
  SELECT CASE WHEN NOT (
    (NEW.attempt_kind = 'initial'
      AND NEW.request_ordinal = 0
      AND NEW.transient_retry_count = 0
      AND NEW.format_repair = 0)
    OR (NEW.attempt_kind = 'format-repair' AND NEW.format_repair = 1)
    OR (NEW.attempt_kind = 'transient-retry' AND NEW.transient_retry_count > 0)
  ) THEN RAISE(ABORT, 'invalid model request attempt identity') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM job_attempts ja
    JOIN run_stages rs ON rs.id = ja.stage_id
    WHERE ja.id = NEW.job_attempt_id AND rs.run_id = NEW.run_id
  ) THEN RAISE(ABORT, 'model request job does not belong to run') END;
END;

CREATE TABLE data_snapshots_next (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  asins_json TEXT NOT NULL CHECK (json_valid(asins_json)),
  data_cutoff_at TEXT NOT NULL,
  sources_json TEXT NOT NULL CHECK (json_valid(sources_json)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  snapshot_kind TEXT CHECK (
    snapshot_kind IS NULL
    OR snapshot_kind IN ('voc', 'alexa-voc-normalization-input')
  ),
  artifact_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (
    artifact_kind IN (
      'legacy', 'voc', 'traffic', 'alexa-voc-normalization-input'
    )
  )
) STRICT;

INSERT INTO data_snapshots_next SELECT * FROM data_snapshots;
DROP TRIGGER agent_run_snapshots_run_consistency;
DROP TABLE data_snapshots;
ALTER TABLE data_snapshots_next RENAME TO data_snapshots;

CREATE TRIGGER agent_run_snapshots_run_consistency
BEFORE INSERT ON agent_run_snapshots
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM agent_runs ar
    JOIN data_snapshots ds ON ds.id = NEW.snapshot_id
    WHERE ar.id = NEW.agent_run_id
      AND ar.validation_status = 'pending'
      AND ds.run_id = ar.run_id
      AND julianday(ds.data_cutoff_at) = julianday(ar.data_cutoff_at)
      AND NEW.ordinal < json_array_length(ar.snapshot_ids_json)
      AND json_extract(
        ar.snapshot_ids_json,
        '$[' || NEW.ordinal || ']'
      ) = NEW.snapshot_id
  ) THEN RAISE(ABORT, 'agent run snapshot does not belong to run') END;
END;

CREATE INDEX data_snapshots_run_idx ON data_snapshots (run_id, created_at);
CREATE UNIQUE INDEX data_snapshots_semantic_identity_idx
ON data_snapshots (run_id, schema_version, marketplace, asins_json, data_cutoff_at)
WHERE snapshot_kind = 'voc';
CREATE UNIQUE INDEX data_snapshots_traffic_semantic_identity_idx
ON data_snapshots (
  run_id, artifact_kind, schema_version, marketplace, asins_json, data_cutoff_at
)
WHERE artifact_kind = 'traffic';
CREATE UNIQUE INDEX data_snapshots_normalization_input_identity_idx
ON data_snapshots (run_id, artifact_kind, marketplace, asins_json, content_hash)
WHERE artifact_kind = 'alexa-voc-normalization-input';
CREATE UNIQUE INDEX data_snapshots_id_run_unique
ON data_snapshots (id, run_id);

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
  OR (NEW.artifact_kind = 'voc' AND NEW.snapshot_kind IS NOT 'voc')
  OR (
    NEW.snapshot_kind = 'alexa-voc-normalization-input'
    AND NEW.artifact_kind <> 'alexa-voc-normalization-input'
  )
  OR (
    NEW.artifact_kind = 'alexa-voc-normalization-input'
    AND NEW.snapshot_kind IS NOT 'alexa-voc-normalization-input'
  )
  OR (NEW.artifact_kind = 'traffic' AND NEW.snapshot_kind IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'data snapshot artifact kind is inconsistent');
END;

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

CREATE TRIGGER data_snapshots_update_immutable
BEFORE UPDATE ON data_snapshots
BEGIN
  SELECT RAISE(ABORT, 'data snapshots are immutable');
END;

CREATE TRIGGER data_snapshots_delete_immutable
BEFORE DELETE ON data_snapshots
BEGIN
  SELECT RAISE(ABORT, 'data snapshots are immutable');
END;

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
    OR voc_snapshot_integrity(
      NEW.schema_version,
      NEW.marketplace,
      NEW.asins_json,
      NEW.data_cutoff_at,
      NEW.sources_json,
      NEW.payload_json,
      NEW.content_hash
    ) IS NOT 1
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
    WHERE json_extract(source.value, '$.reference') =
        'repository://manual-alexa-voc/selected-revisions'
      AND (
        CAST(source.key AS INTEGER) IS NOT 0
        OR json_extract(source.value, '$.type') IS NOT 'manual-voc'
        OR (SELECT count(*) FROM json_each(source.value)) IS NOT 6
        OR json_type(source.value, '$.recordProvenance') IS NOT 'array'
        OR json_array_length(source.value, '$.recordProvenance') IS NOT
          json_array_length(NEW.payload_json, '$.records.alexaVoc')
        OR json_array_length(source.value, '$.recordProvenance') < 1
        OR json_extract(source.value, '$.capturedAt') IS NOT (
          SELECT max(json_extract(provenance.value, '$.capturedAt'))
          FROM json_each(source.value, '$.recordProvenance') provenance
        )
        OR EXISTS (
          SELECT 1
          FROM json_each(source.value, '$.recordProvenance') provenance
          WHERE json_type(provenance.value) IS NOT 'object'
            OR (SELECT count(*) FROM json_each(provenance.value)) IS NOT 8
            OR EXISTS (
              SELECT 1 FROM json_each(provenance.value) field
              WHERE field.key NOT IN (
                'asin', 'revision', 'contentHash', 'source', 'generation',
                'capturedAt', 'normalizedSchemaVersion', 'parserVersion'
              )
            )
            OR json_type(provenance.value, '$.asin') IS NOT 'text'
            OR json_extract(provenance.value, '$.asin') IS NOT json_extract(
              NEW.payload_json,
              '$.records.alexaVoc[' || provenance.key || '].asin'
            )
            OR json_type(provenance.value, '$.revision') IS NOT 'text'
            OR length(json_extract(provenance.value, '$.revision')) < 1
            OR json_extract(provenance.value, '$.revision') GLOB '*[^0-9]*'
            OR substr(json_extract(provenance.value, '$.revision'), 1, 1) = '0'
            OR json_type(provenance.value, '$.contentHash') IS NOT 'text'
            OR length(json_extract(provenance.value, '$.contentHash')) IS NOT 64
            OR json_extract(provenance.value, '$.contentHash') GLOB '*[^0-9a-f]*'
            OR json_type(provenance.value, '$.source') IS NOT 'text'
            OR json_extract(provenance.value, '$.source') NOT IN (
              'repository', 'legacy-static-stale', 'legacy-static-date-only'
            )
            OR (
              json_extract(provenance.value, '$.source') = 'repository'
              AND json_type(provenance.value, '$.generation') IS NOT 'null'
            )
            OR (
              json_extract(provenance.value, '$.source') != 'repository'
              AND (
                json_type(provenance.value, '$.generation') IS NOT 'text'
                OR length(json_extract(provenance.value, '$.generation')) < 1
                OR json_extract(provenance.value, '$.generation') GLOB '*[^0-9]*'
                OR substr(json_extract(provenance.value, '$.generation'), 1, 1) = '0'
              )
            )
            OR json_type(provenance.value, '$.capturedAt') IS NOT 'text'
            OR json_extract(provenance.value, '$.capturedAt') IS NOT strftime(
              '%Y-%m-%dT%H:%M:%fZ',
              json_extract(provenance.value, '$.capturedAt')
            )
            OR julianday(json_extract(provenance.value, '$.capturedAt')) >
              julianday(NEW.data_cutoff_at)
            OR json_extract(provenance.value, '$.normalizedSchemaVersion') IS NOT
              'alexa-voc-record/v2'
            OR json_extract(provenance.value, '$.parserVersion') IS NOT
              'deterministic-alexa-parser/v3'
            OR (
              json_extract(provenance.value, '$.source') = 'repository'
              AND NOT EXISTS (
                SELECT 1
                FROM manual_alexa_voc_revisions revision
                JOIN analysis_runs run ON run.id = NEW.run_id
                JOIN projects project ON project.id = run.project_id
                WHERE revision.organization_id = project.organization_id
                  AND revision.marketplace = NEW.marketplace
                  AND revision.asin = json_extract(provenance.value, '$.asin')
                  AND CAST(revision.revision AS TEXT) =
                    json_extract(provenance.value, '$.revision')
                  AND revision.content_hash =
                    json_extract(provenance.value, '$.contentHash')
                  AND revision.captured_at =
                    json_extract(provenance.value, '$.capturedAt')
                  AND revision.normalized_schema_version =
                    json_extract(provenance.value, '$.normalizedSchemaVersion')
                  AND revision.parser_version =
                    json_extract(provenance.value, '$.parserVersion')
                  AND json(revision.normalized_record) = json(json_extract(
                    NEW.payload_json,
                    '$.records.alexaVoc[' || provenance.key || ']'
                  ))
              )
            )
        )
      )
  ) THEN RAISE(ABORT, 'invalid per-ASIN VOC snapshot provenance') END;
END;
