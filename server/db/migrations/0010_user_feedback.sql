CREATE TABLE user_feedback (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('bug', 'suggestion', 'other')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 4000),
  page_path TEXT NOT NULL CHECK (
    length(page_path) BETWEEN 1 AND 1000
    AND substr(page_path, 1, 1) = '/'
    AND instr(page_path, '?') = 0
    AND instr(page_path, '#') = 0
  ),
  app_version TEXT CHECK (app_version IS NULL OR length(app_version) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_user_id, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX user_feedback_organization_created_idx
ON user_feedback (organization_id, created_at DESC, id);
