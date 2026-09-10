CREATE TABLE traffic_detail_recoveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  run_id TEXT NOT NULL REFERENCES analysis_runs(id),
  base_snapshot_id TEXT NOT NULL REFERENCES data_snapshots(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  marketplace TEXT NOT NULL CHECK (marketplace = 'US'),
  asins_json JSONB NOT NULL CHECK (jsonb_typeof(asins_json) = 'array'),
  collection_json JSONB NOT NULL CHECK (jsonb_typeof(collection_json) = 'object'),
  requests_json JSONB NOT NULL CHECK (jsonb_typeof(requests_json) = 'array'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  collected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, revision)
);
CREATE INDEX traffic_detail_recoveries_scope_idx ON traffic_detail_recoveries (organization_id, run_id, collected_at DESC, revision DESC);
CREATE TRIGGER traffic_detail_recoveries_no_update BEFORE UPDATE ON traffic_detail_recoveries
FOR EACH ROW EXECUTE FUNCTION prevent_data_snapshot_mutation();
CREATE TRIGGER traffic_detail_recoveries_no_delete BEFORE DELETE ON traffic_detail_recoveries
FOR EACH ROW EXECUTE FUNCTION prevent_data_snapshot_mutation();
