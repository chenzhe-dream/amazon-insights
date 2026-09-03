PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX users_id_organization_unique
ON users (id, organization_id);

CREATE TABLE manual_alexa_voc_revisions (
  organization_id TEXT NOT NULL,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('US')),
  asin TEXT NOT NULL CHECK (
    length(asin) = 10 AND asin NOT GLOB '*[^A-Z0-9]*'
  ),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^a-f0-9]*'
  ),
  captured_at TEXT NOT NULL,
  normalized_record TEXT NOT NULL CHECK (
    json_valid(normalized_record) AND json_type(normalized_record) = 'object'
  ),
  normalized_schema_version TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  raw_report_sha256 TEXT NOT NULL CHECK (
    length(raw_report_sha256) = 64 AND raw_report_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  raw_report_alg_version TEXT,
  raw_report_key_id TEXT,
  raw_report_wrapped_dek BLOB,
  raw_report_nonce BLOB,
  raw_report_ciphertext BLOB,
  raw_report_tag BLOB,
  raw_report_aad_sha256 TEXT CHECK (
    raw_report_aad_sha256 IS NULL OR (
      length(raw_report_aad_sha256) = 64 AND
      raw_report_aad_sha256 NOT GLOB '*[^a-f0-9]*'
    )
  ),
  raw_report_plaintext_bytes INTEGER NOT NULL CHECK (
    raw_report_plaintext_bytes BETWEEN 1 AND 131072
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, marketplace, asin, revision),
  UNIQUE (
    organization_id, marketplace, asin, revision, content_hash, captured_at
  ),
  UNIQUE (raw_report_key_id, raw_report_nonce),
  FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  CHECK (
    (
      raw_report_alg_version IS NULL AND
      raw_report_key_id IS NULL AND
      raw_report_wrapped_dek IS NULL AND
      raw_report_nonce IS NULL AND
      raw_report_ciphertext IS NULL AND
      raw_report_tag IS NULL AND
      raw_report_aad_sha256 IS NULL
    ) OR (
      raw_report_alg_version = 'AES-256-GCM/v1' AND
      raw_report_key_id IS NOT NULL AND
      raw_report_wrapped_dek IS NOT NULL AND
      length(raw_report_wrapped_dek) > 0 AND
      raw_report_nonce IS NOT NULL AND
      length(raw_report_nonce) = 12 AND
      raw_report_ciphertext IS NOT NULL AND
      length(raw_report_ciphertext) BETWEEN 1 AND 135168 AND
      raw_report_tag IS NOT NULL AND
      length(raw_report_tag) = 16 AND
      raw_report_aad_sha256 IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX manual_alexa_voc_revisions_cutoff_idx
ON manual_alexa_voc_revisions (
  organization_id, marketplace, asin, captured_at DESC, revision DESC
);

CREATE TABLE manual_alexa_voc_heads (
  organization_id TEXT NOT NULL,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('US')),
  asin TEXT NOT NULL CHECK (
    length(asin) = 10 AND asin NOT GLOB '*[^A-Z0-9]*'
  ),
  latest_revision INTEGER NOT NULL CHECK (latest_revision >= 1),
  latest_content_hash TEXT NOT NULL CHECK (
    length(latest_content_hash) = 64 AND
    latest_content_hash NOT GLOB '*[^a-f0-9]*'
  ),
  latest_captured_at TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, marketplace, asin),
  FOREIGN KEY (
    organization_id, marketplace, asin, latest_revision,
    latest_content_hash, latest_captured_at
  ) REFERENCES manual_alexa_voc_revisions (
    organization_id, marketplace, asin, revision, content_hash, captured_at
  ) ON DELETE RESTRICT
) STRICT;

CREATE TABLE manual_alexa_voc_publication_outbox (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('US')),
  asin TEXT NOT NULL CHECK (
    length(asin) = 10 AND asin NOT GLOB '*[^A-Z0-9]*'
  ),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^a-f0-9]*'
  ),
  captured_at TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'leased', 'applied', 'failed')
  ),
  available_at TEXT NOT NULL,
  leased_by TEXT,
  lease_expires_at TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND 2147483647
  ),
  last_error_json TEXT CHECK (
    last_error_json IS NULL OR json_valid(last_error_json)
  ),
  applied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, marketplace, asin, revision, content_hash),
  FOREIGN KEY (
    organization_id, marketplace, asin, revision, content_hash, captured_at
  ) REFERENCES manual_alexa_voc_revisions (
    organization_id, marketplace, asin, revision, content_hash, captured_at
  ) ON DELETE RESTRICT,
  CHECK (
    status <> 'leased' OR (leased_by IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (status = 'applied' AND applied_at IS NOT NULL) OR
    (status <> 'applied' AND applied_at IS NULL)
  )
) STRICT;

CREATE INDEX manual_alexa_voc_publication_claim_idx
ON manual_alexa_voc_publication_outbox (
  status, available_at, lease_expires_at, lease_generation
);

CREATE TABLE manual_alexa_voc_access_audit (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('US')),
  asin TEXT NOT NULL CHECK (
    length(asin) = 10 AND asin NOT GLOB '*[^A-Z0-9]*'
  ),
  revision INTEGER CHECK (revision IS NULL OR revision >= 1),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 100),
  result TEXT NOT NULL CHECK (result IN ('allowed', 'denied', 'not-found')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_user_id, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, marketplace, asin, revision)
    REFERENCES manual_alexa_voc_revisions (
      organization_id, marketplace, asin, revision
    ) ON DELETE RESTRICT
) STRICT;

CREATE INDEX manual_alexa_voc_access_audit_org_created_idx
ON manual_alexa_voc_access_audit (organization_id, created_at DESC);

CREATE UNIQUE INDEX data_snapshots_id_run_unique
ON data_snapshots (id, run_id);

CREATE TABLE run_creation_idempotency (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND
    request_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  project_id TEXT NOT NULL,
  run_id TEXT,
  snapshot_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects (id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, project_id)
    REFERENCES analysis_runs (id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (snapshot_id, run_id)
    REFERENCES data_snapshots (id, run_id) ON DELETE RESTRICT,
  CHECK (
    (run_id IS NULL AND snapshot_id IS NULL AND completed_at IS NULL) OR
    (run_id IS NOT NULL AND snapshot_id IS NULL AND completed_at IS NULL) OR
    (run_id IS NOT NULL AND snapshot_id IS NOT NULL AND completed_at IS NOT NULL)
  )
) STRICT;
