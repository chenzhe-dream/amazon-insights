ALTER TABLE data_snapshots ADD COLUMN snapshot_kind TEXT CHECK (
  snapshot_kind IS NULL OR snapshot_kind = 'voc'
);

CREATE UNIQUE INDEX data_snapshots_semantic_identity_idx
ON data_snapshots (run_id, schema_version, marketplace, asins_json, data_cutoff_at)
WHERE snapshot_kind = 'voc';

CREATE TRIGGER data_snapshots_legacy_insert_closed
BEFORE INSERT ON data_snapshots
WHEN NEW.snapshot_kind IS NULL
BEGIN
  SELECT RAISE(ABORT, 'legacy data snapshot inserts are closed');
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

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(json_extract(NEW.payload_json, '$.records.alexaVoc')) record
    WHERE json_type(record.value) IS NOT 'object'
      OR (SELECT count(*) FROM json_each(record.value)) IS NOT 10
      OR EXISTS (
        SELECT 1 FROM json_each(record.value) field
        WHERE field.key NOT IN (
          'asin', 'attention', 'positives', 'negatives', 'unmet', 'audiences',
          'scenarios', 'motives', 'captureStatus', 'alexaReport'
        )
      )
      OR json_type(record.value, '$.asin') IS NOT 'text'
      OR length(json_extract(record.value, '$.asin')) IS NOT 10
      OR json_extract(record.value, '$.asin') GLOB '*[^A-Z0-9]*'
      OR NOT EXISTS (
        SELECT 1 FROM json_each(NEW.asins_json) target
        WHERE target.value = json_extract(record.value, '$.asin')
      )
      OR json_type(record.value, '$.captureStatus') IS NOT 'text'
      OR json_extract(record.value, '$.captureStatus') IS NOT 'dialog'
      OR EXISTS (
        SELECT 1 FROM json_each(record.value) field
        WHERE field.key IN (
          'attention', 'positives', 'negatives', 'unmet', 'audiences',
          'scenarios', 'motives'
        )
          AND (
            field.type IS NOT 'array'
            OR json_array_length(field.value) < 1
            OR EXISTS (
              SELECT 1 FROM json_each(field.value) item
              WHERE item.type IS NOT 'text' OR length(item.value) < 1
            )
          )
      )
      OR json_type(record.value, '$.alexaReport') IS NOT 'object'
      OR (SELECT count(*) FROM json_each(record.value, '$.alexaReport')) NOT BETWEEN 6 AND 9
      OR EXISTS (
        SELECT 1 FROM json_each(record.value, '$.alexaReport') field
        WHERE field.key NOT IN (
          'title', 'asin', 'rating', 'reviewCount', 'starBreakdown', 'prompt',
          'overallConclusion', 'captureNote', 'captureStatus'
        )
      )
      OR json_type(record.value, '$.alexaReport.title') IS NOT 'text'
      OR length(json_extract(record.value, '$.alexaReport.title')) < 1
      OR json_type(record.value, '$.alexaReport.asin') IS NOT 'text'
      OR json_extract(record.value, '$.alexaReport.asin') IS NOT json_extract(record.value, '$.asin')
      OR json_type(record.value, '$.alexaReport.rating') NOT IN ('integer', 'real')
      OR json_extract(record.value, '$.alexaReport.rating') NOT BETWEEN 0 AND 5
      OR json_type(record.value, '$.alexaReport.reviewCount') IS NOT 'integer'
      OR json_extract(record.value, '$.alexaReport.reviewCount') < 0
      OR json_type(record.value, '$.alexaReport.prompt') IS NOT 'text'
      OR length(json_extract(record.value, '$.alexaReport.prompt')) < 1
      OR json_type(record.value, '$.alexaReport.overallConclusion') IS NOT 'text'
      OR length(json_extract(record.value, '$.alexaReport.overallConclusion')) < 1
      OR (
        json_type(record.value, '$.alexaReport.starBreakdown') IS NOT NULL
        AND (
          json_type(record.value, '$.alexaReport.starBreakdown') IS NOT 'text'
          OR length(json_extract(record.value, '$.alexaReport.starBreakdown')) < 1
        )
      )
      OR (
        json_type(record.value, '$.alexaReport.captureNote') IS NOT NULL
        AND (
          json_type(record.value, '$.alexaReport.captureNote') IS NOT 'text'
          OR length(json_extract(record.value, '$.alexaReport.captureNote')) < 1
        )
      )
      OR (
        json_type(record.value, '$.alexaReport.captureStatus') IS NOT NULL
        AND (
          json_type(record.value, '$.alexaReport.captureStatus') IS NOT 'text'
          OR json_extract(record.value, '$.alexaReport.captureStatus') IS NOT 'dialog'
        )
      )
  ) THEN RAISE(ABORT, 'invalid Alexa VOC snapshot record') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM (
      SELECT record.value AS value
      FROM json_each(json_extract(NEW.payload_json, '$.records.sorftimeReviewAnalysis')) record
      UNION ALL
      SELECT record.value AS value
      FROM json_each(json_extract(NEW.payload_json, '$.records.sellerSpriteReviewAnalysis')) record
    ) record
    WHERE json_type(record.value) IS NOT 'object'
      OR (SELECT count(*) FROM json_each(record.value)) NOT BETWEEN 6 AND 9
      OR EXISTS (
        SELECT 1 FROM json_each(record.value) field
        WHERE field.key NOT IN (
          'asin', 'marketplace', 'sampledReviews', 'mentionTopics', 'fetchedAt',
          'status', 'statusMessage', 'family', 'blocks'
        )
      )
      OR json_type(record.value, '$.asin') IS NOT 'text'
      OR length(json_extract(record.value, '$.asin')) IS NOT 10
      OR json_extract(record.value, '$.asin') GLOB '*[^A-Z0-9]*'
      OR NOT EXISTS (
        SELECT 1 FROM json_each(NEW.asins_json) target
        WHERE target.value = json_extract(record.value, '$.asin')
      )
      OR json_type(record.value, '$.marketplace') IS NOT 'text'
      OR json_extract(record.value, '$.marketplace') IS NOT NEW.marketplace
      OR json_type(record.value, '$.sampledReviews') IS NOT 'integer'
      OR json_extract(record.value, '$.sampledReviews') < 1
      OR (
        json_type(record.value, '$.mentionTopics') IS NOT NULL
        AND (
          json_type(record.value, '$.mentionTopics') IS NOT 'integer'
          OR json_extract(record.value, '$.mentionTopics') < 0
        )
      )
      OR json_type(record.value, '$.fetchedAt') IS NOT 'text'
      OR length(json_extract(record.value, '$.fetchedAt')) IS NOT 10
      OR date(json_extract(record.value, '$.fetchedAt'), '+0 days')
        IS NOT json_extract(record.value, '$.fetchedAt')
      OR json_type(record.value, '$.status') IS NOT 'text'
      OR json_extract(record.value, '$.status') IS NOT 'ready'
      OR (
        json_type(record.value, '$.statusMessage') IS NOT NULL
        AND (
          json_type(record.value, '$.statusMessage') IS NOT 'text'
          OR length(json_extract(record.value, '$.statusMessage')) < 1
        )
      )
      OR (
        json_type(record.value, '$.family') IS NOT NULL
        AND (
          json_type(record.value, '$.family') IS NOT 'text'
          OR json_extract(record.value, '$.family') NOT IN ('scooter', 'lighting', 'generic')
        )
      )
      OR json_type(record.value, '$.blocks') IS NOT 'array'
      OR EXISTS (
        SELECT 1 FROM json_each(record.value, '$.blocks') block
        WHERE json_type(block.value) IS NOT 'object'
          OR (SELECT count(*) FROM json_each(block.value)) IS NOT 3
          OR EXISTS (
            SELECT 1 FROM json_each(block.value) field
            WHERE field.key NOT IN ('key', 'label', 'rows')
          )
          OR json_type(block.value, '$.key') IS NOT 'text'
          OR json_extract(block.value, '$.key') NOT IN (
            'consumerProfile', 'scenarios', 'unmet', 'positives', 'negatives', 'motives'
          )
          OR json_type(block.value, '$.label') IS NOT 'text'
          OR length(json_extract(block.value, '$.label')) < 1
          OR json_type(block.value, '$.rows') IS NOT 'array'
          OR EXISTS (
            SELECT 1 FROM json_each(block.value, '$.rows') row
            WHERE json_type(row.value) IS NOT 'object'
              OR (SELECT count(*) FROM json_each(row.value)) IS NOT 3
              OR EXISTS (
                SELECT 1 FROM json_each(row.value) field
                WHERE field.key NOT IN ('label', 'sharePct', 'reason')
              )
              OR json_type(row.value, '$.label') IS NOT 'text'
              OR length(json_extract(row.value, '$.label')) < 1
              OR json_type(row.value, '$.sharePct') NOT IN ('integer', 'real')
              OR json_extract(row.value, '$.sharePct') NOT BETWEEN 0 AND 100
              OR json_type(row.value, '$.reason') IS NOT 'text'
          )
      )
  ) THEN RAISE(ABORT, 'invalid review-analysis snapshot record') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM (
      SELECT source_id, record_index, target_index,
        lag(target_index) OVER (
          PARTITION BY source_id ORDER BY record_index
        ) AS previous_target_index
      FROM (
        SELECT 'alexaVoc' AS source_id, CAST(record.key AS INTEGER) AS record_index,
          (
            SELECT CAST(target.key AS INTEGER) FROM json_each(NEW.asins_json) target
            WHERE target.value = json_extract(record.value, '$.asin')
          ) AS target_index
        FROM json_each(json_extract(NEW.payload_json, '$.records.alexaVoc')) record
        UNION ALL
        SELECT 'sorftimeReviewAnalysis', CAST(record.key AS INTEGER),
          (
            SELECT CAST(target.key AS INTEGER) FROM json_each(NEW.asins_json) target
            WHERE target.value = json_extract(record.value, '$.asin')
          )
        FROM json_each(json_extract(NEW.payload_json, '$.records.sorftimeReviewAnalysis')) record
        UNION ALL
        SELECT 'sellerSpriteReviewAnalysis', CAST(record.key AS INTEGER),
          (
            SELECT CAST(target.key AS INTEGER) FROM json_each(NEW.asins_json) target
            WHERE target.value = json_extract(record.value, '$.asin')
          )
        FROM json_each(json_extract(NEW.payload_json, '$.records.sellerSpriteReviewAnalysis')) record
      ) indexed_records
    ) ordered_records
    WHERE target_index IS NULL
      OR (
        previous_target_index IS NOT NULL
        AND target_index <= previous_target_index
      )
  ) THEN RAISE(ABORT, 'VOC snapshot records do not follow target ASIN order') END;

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

  SELECT CASE WHEN
    json_array_length(NEW.payload_json, '$.records.alexaVoc')
      + json_array_length(NEW.payload_json, '$.records.sorftimeReviewAnalysis')
      + json_array_length(NEW.payload_json, '$.records.sellerSpriteReviewAnalysis') < 1
    OR json_array_length(NEW.sources_json) IS NOT (
      (json_array_length(NEW.payload_json, '$.records.alexaVoc') > 0)
      + (json_array_length(NEW.payload_json, '$.records.sorftimeReviewAnalysis') > 0)
      + (json_array_length(NEW.payload_json, '$.records.sellerSpriteReviewAnalysis') > 0)
    )
    OR (
      SELECT count(*) FROM json_each(NEW.sources_json) source
      WHERE json_extract(source.value, '$.reference') = 'app/rufus-voc-data.ts#rufusVocData'
        AND json_extract(source.value, '$.type') = 'manual-voc'
    ) IS NOT (json_array_length(NEW.payload_json, '$.records.alexaVoc') > 0)
    OR (
      SELECT count(*) FROM json_each(NEW.sources_json) source
      WHERE json_extract(source.value, '$.reference') = 'app/sorftime-review-analysis-data.ts#sorftimeReviewAnalysisData'
        AND json_extract(source.value, '$.type') = 'connector'
    ) IS NOT (json_array_length(NEW.payload_json, '$.records.sorftimeReviewAnalysis') > 0)
    OR (
      SELECT count(*) FROM json_each(NEW.sources_json) source
      WHERE json_extract(source.value, '$.reference') = 'app/seller-sprite-mcp-review-analysis-data.ts#sellerSpriteMcpReviewAnalysisData'
        AND json_extract(source.value, '$.type') = 'connector'
    ) IS NOT (json_array_length(NEW.payload_json, '$.records.sellerSpriteReviewAnalysis') > 0)
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.sources_json) source
      WHERE json_extract(source.value, '$.reference') NOT IN (
        'app/rufus-voc-data.ts#rufusVocData',
        'app/sorftime-review-analysis-data.ts#sorftimeReviewAnalysisData',
        'app/seller-sprite-mcp-review-analysis-data.ts#sellerSpriteMcpReviewAnalysisData'
      )
    )
    OR (
      json_array_length(NEW.payload_json, '$.records.alexaVoc') > 0
      AND json_extract(NEW.sources_json, '$[0].reference')
        IS NOT 'app/rufus-voc-data.ts#rufusVocData'
    )
    OR (
      json_array_length(NEW.payload_json, '$.records.sorftimeReviewAnalysis') > 0
      AND json_extract(
        NEW.sources_json,
        '$[' || (json_array_length(NEW.payload_json, '$.records.alexaVoc') > 0) || '].reference'
      ) IS NOT 'app/sorftime-review-analysis-data.ts#sorftimeReviewAnalysisData'
    )
    OR (
      json_array_length(NEW.payload_json, '$.records.sellerSpriteReviewAnalysis') > 0
      AND json_extract(
        NEW.sources_json,
        '$['
          || ((json_array_length(NEW.payload_json, '$.records.alexaVoc') > 0)
            + (json_array_length(NEW.payload_json, '$.records.sorftimeReviewAnalysis') > 0))
          || '].reference'
      ) IS NOT 'app/seller-sprite-mcp-review-analysis-data.ts#sellerSpriteMcpReviewAnalysisData'
    )
  THEN RAISE(ABORT, 'snapshot sources do not match payload records') END;
END;

CREATE TRIGGER data_snapshots_update_immutable
BEFORE UPDATE ON data_snapshots
BEGIN
  SELECT RAISE(ABORT, 'data snapshots are immutable');
END;

CREATE TRIGGER data_snapshots_delete_immutable
BEFORE DELETE ON data_snapshots
WHEN OLD.snapshot_kind = 'voc'
BEGIN
  SELECT RAISE(ABORT, 'data snapshots are immutable');
END;
