-- Permit explicit scoped VOC snapshots while retaining all integrity checks.
DROP TRIGGER data_snapshots_insert_consistency;
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
      AND ((json_extract(NEW.payload_json, '$.evidenceSelection') IS NULL AND p.asins_json = NEW.asins_json) OR (
        json_extract(NEW.payload_json, '$.evidenceSelection.schemaVersion') = 'voc-evidence/v1'
        AND json_extract(NEW.payload_json, '$.evidenceSelection.marketplace') = NEW.marketplace
        AND json_extract(NEW.payload_json, '$.evidenceSelection.projectId') = p.id
        AND json_extract(NEW.payload_json, '$.evidenceSelection.organizationId') = p.organization_id
        AND json_extract(NEW.payload_json, '$.evidenceSelection.selectedAsins') = NEW.asins_json
        AND NOT EXISTS (SELECT 1 FROM json_each(NEW.asins_json) selected
          WHERE selected.value NOT IN (SELECT value FROM json_each(p.asins_json)))
      ))
      AND NOT EXISTS (SELECT 1 FROM data_snapshots fixed WHERE fixed.run_id = NEW.run_id
        AND fixed.snapshot_kind = 'voc' AND json_extract(fixed.payload_json, '$.evidenceSelection') IS NOT NULL
        AND fixed.asins_json <> NEW.asins_json)
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
-- Keywords of an explicit evidence run must use exactly its fixed VOC scope.
CREATE TRIGGER keyword_evidence_scope_insert
BEFORE INSERT ON keyword_analysis_snapshots
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM data_snapshots fixed
    WHERE fixed.run_id = NEW.run_id AND fixed.snapshot_kind = 'voc'
      AND json_extract(fixed.payload_json, '$.evidenceSelection') IS NOT NULL
      AND fixed.asins_json IS NOT NEW.asins_json)
    THEN RAISE(ABORT, 'keyword snapshot conflicts with fixed VOC scope') END;
END;
