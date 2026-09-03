CREATE UNIQUE INDEX user_feedback_id_organization_idx
ON user_feedback (id, organization_id);

CREATE TABLE user_feedback_workflow (
  feedback_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'processing', 'resolved', 'closed')),
  admin_seen_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (feedback_id, organization_id)
    REFERENCES user_feedback (id, organization_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX user_feedback_workflow_unread_idx
ON user_feedback_workflow (organization_id, admin_seen_at, feedback_id);

CREATE INDEX user_feedback_workflow_status_idx
ON user_feedback_workflow (organization_id, status, updated_at DESC, feedback_id);

CREATE TABLE user_feedback_events (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'status_changed')),
  from_status TEXT CHECK (
    from_status IS NULL
    OR from_status IN ('new', 'processing', 'resolved', 'closed')
  ),
  to_status TEXT NOT NULL CHECK (to_status IN ('new', 'processing', 'resolved', 'closed')),
  created_at TEXT NOT NULL,
  CHECK (
    (event_type = 'created' AND from_status IS NULL AND to_status = 'new')
    OR (
      event_type = 'status_changed'
      AND from_status IS NOT NULL
      AND from_status <> to_status
    )
  ),
  FOREIGN KEY (feedback_id, organization_id)
    REFERENCES user_feedback (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX user_feedback_events_feedback_created_idx
ON user_feedback_events (feedback_id, organization_id, created_at, id);

CREATE TRIGGER user_feedback_events_update_immutable
BEFORE UPDATE ON user_feedback_events
BEGIN
  SELECT RAISE(ABORT, 'user feedback events are immutable');
END;

CREATE TRIGGER user_feedback_events_delete_immutable
BEFORE DELETE ON user_feedback_events
BEGIN
  SELECT RAISE(ABORT, 'user feedback events are immutable');
END;

CREATE TABLE user_feedback_attachments (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  image_content BLOB NOT NULL CHECK (length(image_content) = byte_size),
  created_at TEXT NOT NULL,
  FOREIGN KEY (feedback_id, organization_id)
    REFERENCES user_feedback (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id, organization_id)
    REFERENCES users (id, organization_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX user_feedback_attachments_feedback_idx
ON user_feedback_attachments (feedback_id, organization_id, created_at, id);

INSERT INTO user_feedback_workflow (
  feedback_id, organization_id, status, admin_seen_at, version, updated_at
)
SELECT id, organization_id, 'new', NULL, 1, created_at
FROM user_feedback;

INSERT INTO user_feedback_events (
  id, feedback_id, organization_id, actor_user_id,
  event_type, from_status, to_status, created_at
)
SELECT id, id, organization_id, actor_user_id,
       'created', NULL, 'new', created_at
FROM user_feedback;
