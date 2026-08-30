CREATE UNIQUE INDEX users_id_organization_unique ON users(id, organization_id);

CREATE TABLE manual_alexa_voc_revisions (
  organization_id text NOT NULL,
  marketplace text NOT NULL CHECK (marketplace IN ('US')),
  asin text NOT NULL CHECK (asin ~ '^[A-Z0-9]{10}$'),
  revision bigint NOT NULL CHECK (revision >= 1),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz NOT NULL,
  normalized_record jsonb NOT NULL CHECK (jsonb_typeof(normalized_record) = 'object'),
  normalized_schema_version text NOT NULL,
  parser_version text NOT NULL,
  raw_report_sha256 char(64) NOT NULL CHECK (raw_report_sha256 ~ '^[a-f0-9]{64}$'),
  raw_report_alg_version text,
  raw_report_key_id text,
  raw_report_wrapped_dek bytea,
  raw_report_nonce bytea,
  raw_report_ciphertext bytea,
  raw_report_tag bytea,
  raw_report_aad_sha256 char(64) CHECK (
    raw_report_aad_sha256 IS NULL OR raw_report_aad_sha256 ~ '^[a-f0-9]{64}$'
  ),
  raw_report_plaintext_bytes integer NOT NULL CHECK (
    raw_report_plaintext_bytes BETWEEN 1 AND 131072
  ),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, marketplace, asin, revision),
  UNIQUE (
    organization_id, marketplace, asin, revision, content_hash, captured_at
  ),
  UNIQUE (raw_report_key_id, raw_report_nonce),
  FOREIGN KEY (created_by, organization_id)
    REFERENCES users(id, organization_id) ON DELETE RESTRICT,
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
      octet_length(raw_report_wrapped_dek) > 0 AND
      raw_report_nonce IS NOT NULL AND
      octet_length(raw_report_nonce) = 12 AND
      raw_report_ciphertext IS NOT NULL AND
      octet_length(raw_report_ciphertext) BETWEEN 1 AND 135168 AND
      raw_report_tag IS NOT NULL AND
      octet_length(raw_report_tag) = 16 AND
      raw_report_aad_sha256 IS NOT NULL
    )
  )
);

CREATE INDEX manual_alexa_voc_revisions_cutoff_idx
ON manual_alexa_voc_revisions (
  organization_id, marketplace, asin, captured_at DESC, revision DESC
);

CREATE TABLE manual_alexa_voc_heads (
  organization_id text NOT NULL,
  marketplace text NOT NULL CHECK (marketplace IN ('US')),
  asin text NOT NULL CHECK (asin ~ '^[A-Z0-9]{10}$'),
  latest_revision bigint NOT NULL CHECK (latest_revision >= 1),
  latest_content_hash char(64) NOT NULL CHECK (
    latest_content_hash ~ '^[a-f0-9]{64}$'
  ),
  latest_captured_at timestamptz NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, marketplace, asin),
  FOREIGN KEY (
    organization_id, marketplace, asin, latest_revision,
    latest_content_hash, latest_captured_at
  ) REFERENCES manual_alexa_voc_revisions (
    organization_id, marketplace, asin, revision, content_hash, captured_at
  ) ON DELETE RESTRICT
);

CREATE TABLE manual_alexa_voc_publication_outbox (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  marketplace text NOT NULL CHECK (marketplace IN ('US')),
  asin text NOT NULL CHECK (asin ~ '^[A-Z0-9]{10}$'),
  revision bigint NOT NULL CHECK (revision >= 1),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  status text NOT NULL CHECK (
    status IN ('pending', 'leased', 'applied', 'failed')
  ),
  available_at timestamptz NOT NULL,
  leased_by text,
  lease_expires_at timestamptz,
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_json jsonb,
  applied_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
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
);

CREATE INDEX manual_alexa_voc_publication_claim_idx
ON manual_alexa_voc_publication_outbox (
  status, available_at, lease_expires_at, lease_generation
);

CREATE TABLE manual_alexa_voc_access_audit (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  actor_user_id text NOT NULL,
  marketplace text NOT NULL CHECK (marketplace IN ('US')),
  asin text NOT NULL CHECK (asin ~ '^[A-Z0-9]{10}$'),
  revision bigint CHECK (revision IS NULL OR revision >= 1),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 100),
  result text NOT NULL CHECK (result IN ('allowed', 'denied', 'not-found')),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (actor_user_id, organization_id)
    REFERENCES users(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, marketplace, asin, revision)
    REFERENCES manual_alexa_voc_revisions (
      organization_id, marketplace, asin, revision
    ) ON DELETE RESTRICT
);

CREATE INDEX manual_alexa_voc_access_audit_org_created_idx
ON manual_alexa_voc_access_audit (organization_id, created_at DESC);

CREATE UNIQUE INDEX data_snapshots_id_run_unique
ON data_snapshots (id, run_id);

CREATE TABLE run_creation_idempotency (
  organization_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint char(64) NOT NULL CHECK (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  project_id text NOT NULL,
  run_id text,
  snapshot_id text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, project_id)
    REFERENCES analysis_runs(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (snapshot_id, run_id)
    REFERENCES data_snapshots(id, run_id) ON DELETE RESTRICT,
  CHECK (
    (run_id IS NULL AND snapshot_id IS NULL AND completed_at IS NULL) OR
    (run_id IS NOT NULL AND snapshot_id IS NULL AND completed_at IS NULL) OR
    (run_id IS NOT NULL AND snapshot_id IS NOT NULL AND completed_at IS NOT NULL)
  )
);
