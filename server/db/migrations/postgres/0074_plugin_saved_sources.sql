-- Immutable plugin evidence is separate from the disposable connector cache.
-- Owner identifiers originate in the local worker and are checked on every read.
CREATE TABLE plugin_product_source_snapshots (
  snapshot_id text PRIMARY KEY CHECK (snapshot_id ~ '^plugin-source:[a-f0-9]{64}$'),
  job_id uuid NOT NULL UNIQUE,
  organization_id text NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 200),
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 200),
  node text NOT NULL CHECK (node ~ '^[0-9]+$'),
  marketplace text NOT NULL CHECK (marketplace IN ('US','UK','DE','CA')),
  collected_at timestamptz NOT NULL,
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX plugin_product_source_owner_time
  ON plugin_product_source_snapshots (organization_id, user_id, marketplace, collected_at DESC);
