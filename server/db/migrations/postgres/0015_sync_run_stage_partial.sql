ALTER TABLE run_stages
  DROP CONSTRAINT run_stages_status_check;

ALTER TABLE run_stages
  ADD CONSTRAINT run_stages_status_check CHECK (
    status IN (
      'queued', 'running', 'waiting-input', 'succeeded', 'partial', 'failed',
      'skipped', 'budget-exceeded', 'cancelled', 'stale'
    )
  );
