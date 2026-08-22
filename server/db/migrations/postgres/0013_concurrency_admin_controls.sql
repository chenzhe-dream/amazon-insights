CREATE TABLE seller_sprite_quota_settings (
  organization_id TEXT PRIMARY KEY,
  manual_total INTEGER CHECK (manual_total IS NULL OR manual_total > 0),
  updated_by TEXT NOT NULL REFERENCES users (id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE seller_sprite_quota_snapshots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users (id),
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
  CONSTRAINT concurrency_resource_circuits_actor_required_for_manual
    CHECK (updated_by IS NOT NULL OR (auto_paused AND NOT manual_hold AND reason IS NOT NULL AND reason <> 'manual-hold')),
  PRIMARY KEY (organization_id, resource)
);

CREATE OR REPLACE FUNCTION assert_concurrency_admin_actor_same_active_org()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id = NEW.updated_by
      AND organization_id = NEW.organization_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'concurrency admin actor must belong to same active organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assert_concurrency_circuit_actor_same_active_org()
RETURNS trigger AS $$
BEGIN
  IF NEW.updated_by IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id = NEW.updated_by
      AND organization_id = NEW.organization_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'concurrency circuit actor must belong to same active organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER seller_sprite_quota_settings_actor_scope
BEFORE INSERT OR UPDATE ON seller_sprite_quota_settings
FOR EACH ROW
EXECUTE FUNCTION assert_concurrency_admin_actor_same_active_org();

CREATE TRIGGER concurrency_resource_circuits_actor_scope
BEFORE INSERT OR UPDATE ON concurrency_resource_circuits
FOR EACH ROW
EXECUTE FUNCTION assert_concurrency_circuit_actor_same_active_org();

CREATE OR REPLACE FUNCTION assert_seller_sprite_quota_snapshot_scope()
RETURNS trigger AS $$
BEGIN
  IF NEW.actor_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id = NEW.actor_user_id
      AND organization_id = NEW.organization_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'seller sprite quota snapshot actor must belong to same active organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER seller_sprite_quota_snapshots_actor_scope
BEFORE INSERT ON seller_sprite_quota_snapshots
FOR EACH ROW
EXECUTE FUNCTION assert_seller_sprite_quota_snapshot_scope();

CREATE OR REPLACE FUNCTION reject_seller_sprite_quota_snapshot_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'seller sprite quota snapshots are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER seller_sprite_quota_snapshots_no_update
BEFORE UPDATE ON seller_sprite_quota_snapshots
FOR EACH ROW
EXECUTE FUNCTION reject_seller_sprite_quota_snapshot_mutation();

CREATE TRIGGER seller_sprite_quota_snapshots_no_delete
BEFORE DELETE ON seller_sprite_quota_snapshots
FOR EACH ROW
EXECUTE FUNCTION reject_seller_sprite_quota_snapshot_mutation();
