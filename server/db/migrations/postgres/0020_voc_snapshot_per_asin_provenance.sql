CREATE OR REPLACE FUNCTION enforce_voc_data_snapshot_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  asin_value JSONB;
  record_value JSONB;
  block_value JSONB;
  row_value JSONB;
  item_value JSONB;
  source_value JSONB;
  provenance_value JSONB;
  field_name TEXT;
  records_name TEXT;
  source_id TEXT;
  expected_reference TEXT;
  expected_type TEXT;
  expected_checksum TEXT;
  expected_content_hash TEXT;
  record_index BIGINT;
  target_index BIGINT;
  previous_target_index BIGINT;
  source_index BIGINT;
  provenance_index BIGINT;
  source_record_count INTEGER := 0;
  alexa_count INTEGER;
  sorftime_count INTEGER;
  seller_sprite_count INTEGER;
  cutoff_text TEXT;
BEGIN
  cutoff_text := to_char(
    NEW.data_cutoff_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );

  IF NEW.schema_version <> '1.0.0'
    OR char_length(NEW.marketplace) <> 2
    OR NEW.marketplace <> upper(NEW.marketplace)
    OR NEW.content_hash !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(NEW.asins_json) <> 'array'
    OR jsonb_array_length(NEW.asins_json) < 1
    OR jsonb_typeof(NEW.sources_json) <> 'array'
    OR jsonb_array_length(NEW.sources_json) < 1
    OR jsonb_typeof(NEW.payload_json) <> 'object'
  THEN
    RAISE EXCEPTION 'invalid VOC data snapshot';
  END IF;

  FOR asin_value IN SELECT value FROM jsonb_array_elements(NEW.asins_json)
  LOOP
    IF jsonb_typeof(asin_value) <> 'string'
      OR trim(BOTH '"' FROM asin_value::text) !~ '^[A-Z0-9]{10}$'
    THEN
      RAISE EXCEPTION 'invalid VOC data snapshot';
    END IF;
  END LOOP;
  IF (
    SELECT count(*) <> count(DISTINCT value)
      FROM jsonb_array_elements_text(NEW.asins_json)
  ) THEN
    RAISE EXCEPTION 'invalid VOC data snapshot';
  END IF;

  IF jsonb_object_key_count(NEW.payload_json) <> 5
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(NEW.payload_json) AS field(key)
       WHERE field.key NOT IN ('schemaVersion', 'kind', 'marketplace', 'asins', 'records')
    )
    OR jsonb_typeof(NEW.payload_json -> 'schemaVersion') <> 'string'
    OR NEW.payload_json ->> 'schemaVersion' <> NEW.schema_version
    OR jsonb_typeof(NEW.payload_json -> 'kind') <> 'string'
    OR NEW.payload_json ->> 'kind' <> 'voc'
    OR jsonb_typeof(NEW.payload_json -> 'marketplace') <> 'string'
    OR NEW.payload_json ->> 'marketplace' <> NEW.marketplace
    OR jsonb_typeof(NEW.payload_json -> 'asins') <> 'array'
    OR NEW.payload_json -> 'asins' IS DISTINCT FROM NEW.asins_json
    OR jsonb_typeof(NEW.payload_json -> 'records') <> 'object'
    OR jsonb_object_key_count(NEW.payload_json -> 'records') <> 3
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(NEW.payload_json -> 'records') AS field(key)
       WHERE field.key NOT IN (
         'alexaVoc', 'sorftimeReviewAnalysis', 'sellerSpriteReviewAnalysis'
       )
    )
    OR jsonb_typeof(NEW.payload_json #> '{records,alexaVoc}') <> 'array'
    OR jsonb_typeof(NEW.payload_json #> '{records,sorftimeReviewAnalysis}') <> 'array'
    OR jsonb_typeof(NEW.payload_json #> '{records,sellerSpriteReviewAnalysis}') <> 'array'
  THEN
    RAISE EXCEPTION 'invalid VOC snapshot payload';
  END IF;

  FOR record_value IN
    SELECT value FROM jsonb_array_elements(NEW.payload_json #> '{records,alexaVoc}')
  LOOP
    IF jsonb_typeof(record_value) <> 'object'
      OR jsonb_object_key_count(record_value) <> 10
      OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(record_value) AS field(key)
         WHERE field.key NOT IN (
           'asin', 'attention', 'positives', 'negatives', 'unmet', 'audiences',
           'scenarios', 'motives', 'captureStatus', 'alexaReport'
         )
      )
      OR jsonb_typeof(record_value -> 'asin') <> 'string'
      OR record_value ->> 'asin' !~ '^[A-Z0-9]{10}$'
      OR NOT (NEW.asins_json ? (record_value ->> 'asin'))
      OR jsonb_typeof(record_value -> 'captureStatus') <> 'string'
      OR record_value ->> 'captureStatus' <> 'dialog'
    THEN
      RAISE EXCEPTION 'invalid Alexa VOC snapshot record';
    END IF;

    FOREACH field_name IN ARRAY ARRAY[
      'attention', 'positives', 'negatives', 'unmet', 'audiences',
      'scenarios', 'motives'
    ]
    LOOP
      IF jsonb_typeof(record_value -> field_name) <> 'array'
        OR jsonb_array_length(record_value -> field_name) < 1
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(record_value -> field_name) AS item(value)
           WHERE jsonb_typeof(item.value) <> 'string'
              OR char_length(item.value #>> '{}') < 1
        )
      THEN
        RAISE EXCEPTION 'invalid Alexa VOC snapshot record';
      END IF;
    END LOOP;

    IF jsonb_typeof(record_value -> 'alexaReport') <> 'object'
      OR jsonb_object_key_count(record_value -> 'alexaReport') NOT BETWEEN 6 AND 9
      OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(record_value -> 'alexaReport') AS field(key)
         WHERE field.key NOT IN (
           'title', 'asin', 'rating', 'reviewCount', 'starBreakdown', 'prompt',
           'overallConclusion', 'captureNote', 'captureStatus'
         )
      )
      OR jsonb_typeof(record_value #> '{alexaReport,title}') <> 'string'
      OR char_length(record_value #>> '{alexaReport,title}') < 1
      OR jsonb_typeof(record_value #> '{alexaReport,asin}') <> 'string'
      OR record_value #>> '{alexaReport,asin}' <> record_value ->> 'asin'
      OR jsonb_typeof(record_value #> '{alexaReport,rating}') <> 'number'
      OR (record_value #>> '{alexaReport,rating}')::numeric NOT BETWEEN 0 AND 5
      OR jsonb_typeof(record_value #> '{alexaReport,reviewCount}') <> 'number'
      OR (record_value #>> '{alexaReport,reviewCount}') !~ '^\d+$'
      OR (record_value #>> '{alexaReport,reviewCount}')::numeric < 0
      OR jsonb_typeof(record_value #> '{alexaReport,prompt}') <> 'string'
      OR char_length(record_value #>> '{alexaReport,prompt}') < 1
      OR jsonb_typeof(record_value #> '{alexaReport,overallConclusion}') <> 'string'
      OR char_length(record_value #>> '{alexaReport,overallConclusion}') < 1
    THEN
      RAISE EXCEPTION 'invalid Alexa VOC snapshot record';
    END IF;
    FOREACH field_name IN ARRAY ARRAY['starBreakdown', 'captureNote']
    LOOP
      IF record_value #> ARRAY['alexaReport', field_name] IS NOT NULL
        AND (
          jsonb_typeof(record_value #> ARRAY['alexaReport', field_name]) <> 'string'
          OR char_length(record_value #>> ARRAY['alexaReport', field_name]) < 1
        )
      THEN
        RAISE EXCEPTION 'invalid Alexa VOC snapshot record';
      END IF;
    END LOOP;
    IF record_value #> '{alexaReport,captureStatus}' IS NOT NULL
      AND (
        jsonb_typeof(record_value #> '{alexaReport,captureStatus}') <> 'string'
        OR record_value #>> '{alexaReport,captureStatus}' <> 'dialog'
      )
    THEN
      RAISE EXCEPTION 'invalid Alexa VOC snapshot record';
    END IF;
  END LOOP;

  FOR record_value IN
    SELECT value FROM jsonb_array_elements(NEW.payload_json #> '{records,sorftimeReviewAnalysis}')
    UNION ALL
    SELECT value FROM jsonb_array_elements(NEW.payload_json #> '{records,sellerSpriteReviewAnalysis}')
  LOOP
    IF jsonb_typeof(record_value) <> 'object'
      OR jsonb_object_key_count(record_value) NOT BETWEEN 6 AND 9
      OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(record_value) AS field(key)
         WHERE field.key NOT IN (
           'asin', 'marketplace', 'sampledReviews', 'mentionTopics', 'fetchedAt',
           'status', 'statusMessage', 'family', 'blocks'
         )
      )
      OR jsonb_typeof(record_value -> 'asin') <> 'string'
      OR record_value ->> 'asin' !~ '^[A-Z0-9]{10}$'
      OR NOT (NEW.asins_json ? (record_value ->> 'asin'))
      OR jsonb_typeof(record_value -> 'marketplace') <> 'string'
      OR record_value ->> 'marketplace' <> NEW.marketplace
      OR jsonb_typeof(record_value -> 'sampledReviews') <> 'number'
      OR (record_value ->> 'sampledReviews') !~ '^\d+$'
      OR (record_value ->> 'sampledReviews')::numeric < 1
      OR jsonb_typeof(record_value -> 'fetchedAt') <> 'string'
      OR NOT voc_is_iso_date(record_value ->> 'fetchedAt')
      OR jsonb_typeof(record_value -> 'status') <> 'string'
      OR record_value ->> 'status' <> 'ready'
      OR jsonb_typeof(record_value -> 'blocks') <> 'array'
    THEN
      RAISE EXCEPTION 'invalid review-analysis snapshot record';
    END IF;
    IF record_value -> 'mentionTopics' IS NOT NULL
      AND (
        jsonb_typeof(record_value -> 'mentionTopics') <> 'number'
        OR (record_value ->> 'mentionTopics') !~ '^\d+$'
        OR (record_value ->> 'mentionTopics')::numeric < 0
      )
    THEN
      RAISE EXCEPTION 'invalid review-analysis snapshot record';
    END IF;
    IF record_value -> 'statusMessage' IS NOT NULL
      AND (
        jsonb_typeof(record_value -> 'statusMessage') <> 'string'
        OR char_length(record_value ->> 'statusMessage') < 1
      )
    THEN
      RAISE EXCEPTION 'invalid review-analysis snapshot record';
    END IF;
    IF record_value -> 'family' IS NOT NULL
      AND (
        jsonb_typeof(record_value -> 'family') <> 'string'
        OR record_value ->> 'family' NOT IN ('scooter', 'lighting', 'generic')
      )
    THEN
      RAISE EXCEPTION 'invalid review-analysis snapshot record';
    END IF;

    FOR block_value IN SELECT value FROM jsonb_array_elements(record_value -> 'blocks')
    LOOP
      IF jsonb_typeof(block_value) <> 'object'
        OR jsonb_object_key_count(block_value) <> 3
        OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(block_value) AS field(key)
           WHERE field.key NOT IN ('key', 'label', 'rows')
        )
        OR jsonb_typeof(block_value -> 'key') <> 'string'
        OR block_value ->> 'key' NOT IN (
          'consumerProfile', 'scenarios', 'unmet', 'positives', 'negatives', 'motives'
        )
        OR jsonb_typeof(block_value -> 'label') <> 'string'
        OR char_length(block_value ->> 'label') < 1
        OR jsonb_typeof(block_value -> 'rows') <> 'array'
      THEN
        RAISE EXCEPTION 'invalid review-analysis snapshot record';
      END IF;
      FOR row_value IN SELECT value FROM jsonb_array_elements(block_value -> 'rows')
      LOOP
        IF jsonb_typeof(row_value) <> 'object'
          OR jsonb_object_key_count(row_value) <> 3
          OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(row_value) AS field(key)
             WHERE field.key NOT IN ('label', 'sharePct', 'reason')
          )
          OR jsonb_typeof(row_value -> 'label') <> 'string'
          OR char_length(row_value ->> 'label') < 1
          OR jsonb_typeof(row_value -> 'sharePct') <> 'number'
          OR (row_value ->> 'sharePct')::numeric NOT BETWEEN 0 AND 100
          OR jsonb_typeof(row_value -> 'reason') <> 'string'
        THEN
          RAISE EXCEPTION 'invalid review-analysis snapshot record';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  FOREACH records_name IN ARRAY ARRAY[
    'alexaVoc', 'sorftimeReviewAnalysis', 'sellerSpriteReviewAnalysis'
  ]
  LOOP
    previous_target_index := NULL;
    FOR record_value, record_index IN
      SELECT value, ordinal
        FROM jsonb_array_elements(NEW.payload_json #> ARRAY['records', records_name])
             WITH ORDINALITY AS record(value, ordinal)
       ORDER BY ordinal
    LOOP
      SELECT target.ordinal INTO target_index
        FROM jsonb_array_elements_text(NEW.asins_json)
             WITH ORDINALITY AS target(value, ordinal)
       WHERE target.value = record_value ->> 'asin';
      IF target_index IS NULL
        OR (previous_target_index IS NOT NULL AND target_index <= previous_target_index)
      THEN
        RAISE EXCEPTION 'VOC snapshot records do not follow target ASIN order';
      END IF;
      previous_target_index := target_index;
    END LOOP;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM analysis_runs run
      JOIN projects project ON project.id = run.project_id
     WHERE run.id = NEW.run_id
       AND project.marketplace = NEW.marketplace
       AND project.asins_json = NEW.asins_json
       AND NEW.data_cutoff_at <= run.data_cutoff_at
  ) THEN
    RAISE EXCEPTION 'snapshot target does not match run project';
  END IF;

  alexa_count := jsonb_array_length(NEW.payload_json #> '{records,alexaVoc}');
  sorftime_count := jsonb_array_length(NEW.payload_json #> '{records,sorftimeReviewAnalysis}');
  seller_sprite_count := jsonb_array_length(NEW.payload_json #> '{records,sellerSpriteReviewAnalysis}');
  IF alexa_count + sorftime_count + seller_sprite_count < 1 THEN
    RAISE EXCEPTION 'snapshot sources do not match payload records';
  END IF;

  FOR source_value, source_index IN
    SELECT value, ordinal
      FROM jsonb_array_elements(NEW.sources_json)
           WITH ORDINALITY AS source(value, ordinal)
     ORDER BY ordinal
  LOOP
    IF jsonb_typeof(source_value) <> 'object'
      OR jsonb_object_key_count(source_value) NOT IN (5, 6)
      OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(source_value) AS field(key)
         WHERE field.key NOT IN (
           'type', 'reference', 'marketplace', 'capturedAt', 'checksum',
           'recordProvenance'
         )
      )
      OR jsonb_typeof(source_value -> 'type') <> 'string'
      OR source_value ->> 'type' NOT IN ('connector', 'manual-voc')
      OR jsonb_typeof(source_value -> 'reference') <> 'string'
      OR char_length(source_value ->> 'reference') NOT BETWEEN 1 AND 500
      OR jsonb_typeof(source_value -> 'marketplace') <> 'string'
      OR source_value ->> 'marketplace' <> NEW.marketplace
      OR jsonb_typeof(source_value -> 'capturedAt') <> 'string'
      OR NOT voc_is_canonical_utc_millis(source_value ->> 'capturedAt')
      OR (source_value ->> 'capturedAt')::timestamptz > NEW.data_cutoff_at
      OR jsonb_typeof(source_value -> 'checksum') <> 'string'
      OR source_value ->> 'checksum' !~ '^[0-9a-f]{64}$'
    THEN
      RAISE EXCEPTION 'invalid snapshot source provenance or snapshot sources exceed cutoff';
    END IF;

    IF alexa_count > 0 AND source_index = 1 THEN
      source_id := 'alexa-voc';
      expected_type := 'manual-voc';
      records_name := 'alexaVoc';
      IF source_value ->> 'reference' NOT IN (
        'app/rufus-voc-data.ts#rufusVocData',
        'repository://manual-alexa-voc/selected-revisions'
      ) THEN
        RAISE EXCEPTION 'snapshot sources do not match payload records';
      END IF;
      expected_reference := source_value ->> 'reference';
    ELSIF sorftime_count > 0
      AND source_index = (alexa_count > 0)::integer + 1
    THEN
      source_id := 'sorftime-review-analysis';
      expected_reference := 'app/sorftime-review-analysis-data.ts#sorftimeReviewAnalysisData';
      expected_type := 'connector';
      records_name := 'sorftimeReviewAnalysis';
    ELSIF seller_sprite_count > 0
      AND source_index = (alexa_count > 0)::integer
        + (sorftime_count > 0)::integer + 1
    THEN
      source_id := 'seller-sprite-review-analysis';
      expected_reference := 'app/seller-sprite-mcp-review-analysis-data.ts#sellerSpriteMcpReviewAnalysisData';
      expected_type := 'connector';
      records_name := 'sellerSpriteReviewAnalysis';
    ELSE
      RAISE EXCEPTION 'snapshot sources do not match payload records';
    END IF;

    IF expected_reference = 'repository://manual-alexa-voc/selected-revisions' THEN
      IF jsonb_object_key_count(source_value) <> 6
        OR jsonb_typeof(source_value -> 'recordProvenance') <> 'array'
        OR jsonb_array_length(source_value -> 'recordProvenance') <> alexa_count
        OR alexa_count < 1
      THEN
        RAISE EXCEPTION 'invalid per-ASIN VOC snapshot provenance';
      END IF;
      FOR provenance_value, provenance_index IN
        SELECT value, ordinal
          FROM jsonb_array_elements(source_value -> 'recordProvenance')
               WITH ORDINALITY AS provenance(value, ordinal)
         ORDER BY ordinal
      LOOP
        IF jsonb_typeof(provenance_value) <> 'object'
          OR jsonb_object_key_count(provenance_value) <> 8
          OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(provenance_value) AS field(key)
             WHERE field.key NOT IN (
               'asin', 'revision', 'contentHash', 'source', 'generation',
               'capturedAt', 'normalizedSchemaVersion', 'parserVersion'
             )
          )
          OR jsonb_typeof(provenance_value -> 'asin') <> 'string'
          OR provenance_value ->> 'asin' <>
            NEW.payload_json #>> ARRAY[
              'records', 'alexaVoc', (provenance_index - 1)::text, 'asin'
            ]
          OR jsonb_typeof(provenance_value -> 'revision') <> 'string'
          OR provenance_value ->> 'revision' !~ '^[1-9]\d*$'
          OR jsonb_typeof(provenance_value -> 'contentHash') <> 'string'
          OR provenance_value ->> 'contentHash' !~ '^[0-9a-f]{64}$'
          OR jsonb_typeof(provenance_value -> 'source') <> 'string'
          OR provenance_value ->> 'source' NOT IN (
            'repository', 'legacy-static-stale', 'legacy-static-date-only'
          )
          OR (
            provenance_value ->> 'source' = 'repository'
            AND jsonb_typeof(provenance_value -> 'generation') <> 'null'
          )
          OR (
            provenance_value ->> 'source' <> 'repository'
            AND (
              jsonb_typeof(provenance_value -> 'generation') <> 'string'
              OR provenance_value ->> 'generation' !~ '^[1-9]\d*$'
            )
          )
          OR jsonb_typeof(provenance_value -> 'capturedAt') <> 'string'
          OR NOT voc_is_canonical_utc_millis(provenance_value ->> 'capturedAt')
          OR (provenance_value ->> 'capturedAt')::timestamptz > NEW.data_cutoff_at
          OR jsonb_typeof(provenance_value -> 'normalizedSchemaVersion') IS DISTINCT FROM 'string'
          OR provenance_value ->> 'normalizedSchemaVersion' <> 'alexa-voc-record/v2'
          OR jsonb_typeof(provenance_value -> 'parserVersion') IS DISTINCT FROM 'string'
          OR provenance_value ->> 'parserVersion' <> 'deterministic-alexa-parser/v3'
          OR (
            provenance_value ->> 'source' = 'repository'
            AND NOT EXISTS (
              SELECT 1
                FROM manual_alexa_voc_revisions revision
                JOIN analysis_runs run ON run.id = NEW.run_id
                JOIN projects project ON project.id = run.project_id
               WHERE revision.organization_id = project.organization_id
                 AND revision.marketplace = NEW.marketplace
                 AND revision.asin = provenance_value ->> 'asin'
                 AND revision.revision::text = provenance_value ->> 'revision'
                 AND revision.content_hash::text = provenance_value ->> 'contentHash'
                 AND to_char(
                       revision.captured_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                     ) = provenance_value ->> 'capturedAt'
                 AND revision.normalized_schema_version =
                   provenance_value ->> 'normalizedSchemaVersion'
                 AND revision.parser_version = provenance_value ->> 'parserVersion'
                 AND revision.normalized_record = NEW.payload_json #> ARRAY[
                   'records', 'alexaVoc', (provenance_index - 1)::text
                 ]
            )
          )
        THEN
          RAISE EXCEPTION 'invalid per-ASIN VOC snapshot provenance';
        END IF;
      END LOOP;
      IF source_value ->> 'capturedAt' <> (
        SELECT max(value ->> 'capturedAt')
          FROM jsonb_array_elements(source_value -> 'recordProvenance')
      ) THEN
        RAISE EXCEPTION 'invalid per-ASIN VOC snapshot provenance';
      END IF;
      expected_checksum := voc_sha256_jsonb(jsonb_build_object(
        'sourceId', source_id,
        'marketplace', NEW.marketplace,
        'records', NEW.payload_json #> ARRAY['records', records_name],
        'recordProvenance', source_value -> 'recordProvenance'
      ));
    ELSE
      IF jsonb_object_key_count(source_value) <> 5
        OR source_value ? 'recordProvenance'
      THEN
        RAISE EXCEPTION 'snapshot sources do not match payload records';
      END IF;
      expected_checksum := voc_sha256_jsonb(jsonb_build_object(
        'sourceId', source_id,
        'marketplace', NEW.marketplace,
        'records', NEW.payload_json #> ARRAY['records', records_name]
      ));
    END IF;

    IF source_value ->> 'type' <> expected_type
      OR source_value ->> 'reference' <> expected_reference
      OR source_value ->> 'checksum' <> expected_checksum
    THEN
      RAISE EXCEPTION 'snapshot sources do not match payload records';
    END IF;
    source_record_count := source_record_count + 1;
  END LOOP;

  IF source_record_count <> (alexa_count > 0)::integer
      + (sorftime_count > 0)::integer
      + (seller_sprite_count > 0)::integer
  THEN
    RAISE EXCEPTION 'snapshot sources do not match payload records';
  END IF;

  expected_content_hash := voc_sha256_jsonb(jsonb_build_object(
    'schemaVersion', NEW.schema_version,
    'marketplace', NEW.marketplace,
    'asins', NEW.asins_json,
    'dataCutoffAt', cutoff_text,
    'sources', NEW.sources_json,
    'payload', NEW.payload_json
  ));
  IF NEW.content_hash <> expected_content_hash THEN
    RAISE EXCEPTION 'invalid VOC data snapshot';
  END IF;

  RETURN NEW;
END;
$$;
