-- Existing visibility, including legacy/default full selection, never implies a grant.
ALTER TABLE user_module_visibility
 ADD COLUMN statistics_view_granted BOOLEAN NOT NULL DEFAULT false;
