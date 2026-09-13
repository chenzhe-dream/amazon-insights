CREATE TABLE market_research_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  scope_json JSONB NOT NULL CHECK (jsonb_typeof(scope_json) = 'object'),
  scope_hash TEXT NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_owner_id TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_until TIMESTAMPTZ,
  report_json JSONB,
  report_hash TEXT CHECK (report_hash ~ '^[a-f0-9]{64}$'),
  error_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, idempotency_key),
  CHECK ((status IN ('succeeded', 'partial')) = (report_json IS NOT NULL)),
  CHECK ((report_json IS NOT NULL) = (report_hash IS NOT NULL)),
  CHECK (report_json IS NULL OR jsonb_typeof(report_json) = 'object'),
  CHECK ((status = 'failed') = (error_json IS NOT NULL)),
  CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  CHECK ((status = 'running' AND lease_owner_id IS NOT NULL AND lease_until IS NOT NULL)
      OR (status <> 'running' AND lease_owner_id IS NULL AND lease_until IS NULL)),
  CHECK (status <> 'running' OR (attempts > 0 AND lease_generation > 0)),
  CHECK (status <> 'queued' OR attempts < 3)
);

CREATE INDEX market_research_jobs_history ON market_research_jobs (organization_id, created_at DESC, id DESC);
CREATE INDEX market_research_jobs_claim ON market_research_jobs (created_at, id) WHERE status IN ('queued', 'running');

CREATE FUNCTION protect_market_research_job() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.report_json IS NOT NULL THEN
    RAISE EXCEPTION 'Published market research reports are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.scope_json IS DISTINCT FROM OLD.scope_json
      OR NEW.scope_hash IS DISTINCT FROM OLD.scope_hash
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Market research request identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER market_research_jobs_immutable
BEFORE UPDATE OR DELETE ON market_research_jobs
FOR EACH ROW EXECUTE FUNCTION protect_market_research_job();
