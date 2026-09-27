CREATE TABLE market_shape_drafts (
 organization_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 marketplace TEXT NOT NULL,
 node_id_path TEXT NOT NULL CHECK (node_id_path ~ '^\d+(:\d+)*$'),
 version INTEGER NOT NULL CHECK (version >= 0),
 content_json JSONB NOT NULL CHECK (jsonb_typeof(content_json)='object'),
 content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
 updated_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY (organization_id,user_id,marketplace,node_id_path)
);
CREATE TABLE market_shape_draft_receipts (
 organization_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 idempotency_key UUID NOT NULL,
 request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 response_json JSONB NOT NULL CHECK (jsonb_typeof(response_json)='object'),
 created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY (organization_id,user_id,idempotency_key)
);
CREATE TRIGGER market_shape_draft_receipt_immutable BEFORE UPDATE OR DELETE ON market_shape_draft_receipts
FOR EACH ROW EXECUTE FUNCTION protect_market_analysis_snapshot();
