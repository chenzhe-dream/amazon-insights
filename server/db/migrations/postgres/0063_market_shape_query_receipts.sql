CREATE TABLE market_shape_query_receipts (
 organization_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 command_id UUID NOT NULL,
 request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 run_id UUID NOT NULL REFERENCES market_analysis_module_runs(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(organization_id,user_id,command_id)
);
CREATE TRIGGER market_shape_query_receipt_immutable BEFORE UPDATE OR DELETE ON market_shape_query_receipts
FOR EACH ROW EXECUTE FUNCTION protect_market_analysis_snapshot();
