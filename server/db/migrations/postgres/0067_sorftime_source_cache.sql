CREATE TABLE sorftime_source_cache (
  cache_key text PRIMARY KEY,
  credential_scope text NOT NULL,
  operation text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sorftime_source_cache_expiry ON sorftime_source_cache(expires_at);
CREATE TABLE sorftime_source_pauses (
  pause_key text PRIMARY KEY,
  reason text NOT NULL CHECK (reason IN ('quota','failure')),
  until_at timestamptz NOT NULL
);
CREATE TABLE sorftime_source_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cache_key text NOT NULL,
  credential_scope text NOT NULL,
  operation text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dispatch','hit','quota-blocked','failed')),
  estimated_units integer,
  job_id text,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX sorftime_source_events_job ON sorftime_source_events(job_id, recorded_at);
CREATE INDEX sorftime_source_events_time ON sorftime_source_events(recorded_at);
CREATE TABLE sorftime_source_refresh_scopes (
  job_id text PRIMARY KEY,
  not_before timestamptz NOT NULL
);
