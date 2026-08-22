CREATE TABLE seller_sprite_quota_settings (
  organization_id TEXT PRIMARY KEY,
  manual_total INTEGER CHECK (manual_total IS NULL OR manual_total > 0),
  updated_by TEXT REFERENCES users (id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE seller_sprite_quota_snapshots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  remaining INTEGER CHECK (remaining IS NULL OR remaining >= 0),
  used_count INTEGER CHECK (used_count IS NULL OR used_count >= 0),
  provider_total INTEGER CHECK (provider_total IS NULL OR provider_total > 0),
  configured_total INTEGER CHECK (configured_total IS NULL OR configured_total > 0),
  source TEXT NOT NULL CHECK (source IN ('provider', 'configured', 'local-observed', 'unknown')),
  status TEXT NOT NULL CHECK (status IN ('unknown', 'ok', 'warning', 'conservative', 'paused', 'error')),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN ('ERROR_VISIT_MAX', 'MALFORMED_RESPONSE', 'UPSTREAM_UNAVAILABLE', 'REQUEST_TIMEOUT')),
  checked_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX seller_sprite_quota_snapshots_org_checked_idx
ON seller_sprite_quota_snapshots (organization_id, checked_at DESC);

CREATE TABLE concurrency_resource_circuits (
  organization_id TEXT NOT NULL,
  resource TEXT NOT NULL CHECK (resource IN ('sellerSprite', 'sif', 'sorftime')),
  manual_hold BOOLEAN NOT NULL DEFAULT FALSE,
  auto_paused BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT CHECK (reason IS NULL OR reason IN ('manual-hold', 'quota-exhausted', 'upstream-error', 'rate-limited')),
  updated_by TEXT REFERENCES users (id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, resource)
);
