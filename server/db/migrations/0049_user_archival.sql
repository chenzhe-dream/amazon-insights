ALTER TABLE users ADD COLUMN archived_at TEXT CHECK (archived_at IS NULL OR status = 'disabled');
