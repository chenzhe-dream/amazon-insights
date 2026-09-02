ALTER TABLE sync_job_stage_outputs
  DROP CONSTRAINT IF EXISTS sync_job_stage_outputs_stage_id_check,
  DROP CONSTRAINT IF EXISTS sync_job_stage_outputs_check;

UPDATE sync_job_stage_outputs
SET stage_status = 'failed',
    gap_json = jsonb_set(gap_json, '{state}', '"failed"'::jsonb)
WHERE stage_status = 'partial'
  AND data_json IS NULL
  AND gap_json IS NOT NULL;

ALTER TABLE sync_job_stage_outputs
  ADD CONSTRAINT sync_job_stage_outputs_stage_id_check
    CHECK (stage_id IN (
      'keywords','reviews','sales_trend','fba','listing','category','traffic',
      'child_sales','price_strategy','image_remarks'
    )),
  ADD CONSTRAINT sync_job_stage_outputs_payload_check
    CHECK (
      (stage_status = 'done' AND data_json IS NOT NULL AND gap_json IS NULL)
      OR (stage_status = 'partial' AND data_json IS NOT NULL AND gap_json IS NOT NULL AND gap_json->>'state' = 'partial')
      OR (stage_status = 'failed' AND data_json IS NULL AND gap_json IS NOT NULL AND gap_json->>'state' = 'failed')
    );
