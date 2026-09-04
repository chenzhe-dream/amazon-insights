CREATE TABLE auth_identities (
  provider TEXT NOT NULL CHECK (provider = 'dingtalk'),
  corp_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  last_login_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider, corp_id, subject_id),
  UNIQUE (provider, user_id)
);

CREATE INDEX auth_identities_user_idx ON auth_identities (user_id);

CREATE TABLE oauth_login_states (
  state_hash TEXT PRIMARY KEY CHECK (
    char_length(state_hash) = 64 AND state_hash = lower(state_hash)
  ),
  provider TEXT NOT NULL CHECK (provider = 'dingtalk'),
  return_path TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX oauth_login_states_expiry_idx ON oauth_login_states (
  expires_at, consumed_at
);
