ALTER TABLE run_stages
  DROP CONSTRAINT run_stages_stage_check;

ALTER TABLE run_stages
  ADD CONSTRAINT run_stages_stage_check CHECK (
    stage IN (
      'traffic-analysis', 'alexa-voc-normalization', 'voc-positioning',
      'product-definition'
    )
  );

ALTER TABLE data_snapshots
  DROP CONSTRAINT data_snapshots_snapshot_kind_check;

ALTER TABLE data_snapshots
  ADD CONSTRAINT data_snapshots_snapshot_kind_check CHECK (
    snapshot_kind IS NULL
    OR snapshot_kind IN ('voc', 'alexa-voc-normalization-input')
  );

ALTER TABLE data_snapshots
  DROP CONSTRAINT data_snapshots_artifact_kind_check;

ALTER TABLE data_snapshots
  ADD CONSTRAINT data_snapshots_artifact_kind_check CHECK (
    artifact_kind IN (
      'legacy', 'voc', 'traffic', 'alexa-voc-normalization-input'
    )
  );

CREATE OR REPLACE FUNCTION enforce_data_snapshot_artifact_kind()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.snapshot_kind = 'voc' AND NEW.artifact_kind <> 'voc')
    OR (NEW.artifact_kind = 'voc' AND NEW.snapshot_kind IS DISTINCT FROM 'voc')
    OR (
      NEW.snapshot_kind = 'alexa-voc-normalization-input'
      AND NEW.artifact_kind <> 'alexa-voc-normalization-input'
    )
    OR (
      NEW.artifact_kind = 'alexa-voc-normalization-input'
      AND NEW.snapshot_kind IS DISTINCT FROM 'alexa-voc-normalization-input'
    )
    OR (NEW.artifact_kind = 'traffic' AND NEW.snapshot_kind IS NOT NULL)
  THEN
    RAISE EXCEPTION 'data snapshot artifact kind is inconsistent';
  END IF;
  RETURN NEW;
END;
$$;

CREATE UNIQUE INDEX data_snapshots_normalization_input_identity_idx
ON data_snapshots (run_id, artifact_kind, marketplace, asins_json, content_hash)
WHERE artifact_kind = 'alexa-voc-normalization-input';
