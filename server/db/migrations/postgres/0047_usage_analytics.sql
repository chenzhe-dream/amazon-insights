CREATE TABLE usage_events (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id,user_id,event_id)
);
CREATE INDEX usage_events_user_time ON usage_events(organization_id,user_id,occurred_at);
CREATE INDEX usage_events_page_time ON usage_events(organization_id,page_key,occurred_at);
CREATE TABLE usage_daily_stats (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('user','page')),
  page_key TEXT NOT NULL,
  visits BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  visible_ms BIGINT NOT NULL DEFAULT 0,
  active_ms BIGINT NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(organization_id,user_id,day,scope,page_key)
);
CREATE INDEX usage_daily_org_day ON usage_daily_stats(organization_id,day,scope);
