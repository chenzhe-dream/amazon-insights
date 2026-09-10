-- Patch the live validator so previous empty-dimension and metric fixes survive.
DO $migration$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('enforce_voc_data_snapshot_insert()'::regprocedure);
  IF position('jsonb_object_key_count(NEW.payload_json) <> 5' in definition) = 0
    OR position('AND project.asins_json = NEW.asins_json' in definition) = 0 THEN
    RAISE EXCEPTION 'VOC validator baseline differs; refusing unsafe migration';
  END IF;
  definition := replace(definition,
    'jsonb_object_key_count(NEW.payload_json) <> 5',
    '(jsonb_object_key_count(NEW.payload_json) <> CASE WHEN NEW.payload_json ? ''evidenceSelection'' THEN 6 ELSE 5 END OR (NEW.payload_json ? ''evidenceSelection'' AND jsonb_typeof(NEW.payload_json->''evidenceSelection'') IS DISTINCT FROM ''object''))');
  definition := replace(definition,
    '(''schemaVersion'', ''kind'', ''marketplace'', ''asins'', ''records'')',
    '(''schemaVersion'', ''kind'', ''marketplace'', ''asins'', ''records'', ''evidenceSelection'')');
  definition := replace(definition, 'AND project.asins_json = NEW.asins_json', $replacement$
       AND (
         (NOT (NEW.payload_json ? 'evidenceSelection') AND project.asins_json = NEW.asins_json)
         OR (
           NEW.payload_json #>> '{evidenceSelection,schemaVersion}' IS NOT DISTINCT FROM 'voc-evidence/v1'
           AND NEW.payload_json #>> '{evidenceSelection,marketplace}' IS NOT DISTINCT FROM NEW.marketplace
           AND NEW.payload_json #>> '{evidenceSelection,projectId}' IS NOT DISTINCT FROM project.id
           AND NEW.payload_json #>> '{evidenceSelection,organizationId}' IS NOT DISTINCT FROM project.organization_id
           AND NEW.payload_json #> '{evidenceSelection,selectedAsins}' IS NOT DISTINCT FROM NEW.asins_json
           AND project.asins_json @> NEW.asins_json
         )
       )
       AND NOT EXISTS (SELECT 1 FROM data_snapshots fixed
         WHERE fixed.run_id = NEW.run_id AND fixed.snapshot_kind = 'voc'
           AND fixed.payload_json ? 'evidenceSelection' AND fixed.asins_json <> NEW.asins_json)
$replacement$);
  EXECUTE definition;
END;
$migration$;
CREATE FUNCTION enforce_keyword_evidence_scope_insert() RETURNS trigger LANGUAGE plpgsql AS $scope$
BEGIN
  IF EXISTS (SELECT 1 FROM data_snapshots fixed
    WHERE fixed.run_id = NEW.run_id AND fixed.snapshot_kind = 'voc'
      AND fixed.payload_json ? 'evidenceSelection' AND fixed.asins_json IS DISTINCT FROM NEW.asins_json)
  THEN RAISE EXCEPTION 'keyword snapshot conflicts with fixed VOC scope'; END IF;
  RETURN NEW;
END;
$scope$;
CREATE TRIGGER keyword_evidence_scope_insert BEFORE INSERT ON keyword_analysis_snapshots
FOR EACH ROW EXECUTE FUNCTION enforce_keyword_evidence_scope_insert();
