CREATE TABLE market_linked_batches (
 id UUID PRIMARY KEY,
 organization_id TEXT NOT NULL,
 created_by TEXT NOT NULL,
 request_json JSONB NOT NULL,
 request_hash TEXT NOT NULL,
 basic_job_id TEXT NOT NULL REFERENCES market_research_jobs(id) ON DELETE RESTRICT,
 state_json JSONB NOT NULL,
 pending BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(created_by,organization_id) REFERENCES users(id,organization_id) ON DELETE RESTRICT
);
CREATE INDEX market_linked_batches_pending ON market_linked_batches(created_at,id) WHERE pending;
