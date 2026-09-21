ALTER TABLE users ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE users ADD CONSTRAINT archived_user_disabled CHECK (archived_at IS NULL OR status = 'disabled');
