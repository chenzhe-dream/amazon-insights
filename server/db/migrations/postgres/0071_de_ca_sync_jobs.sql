-- Extend scoped project sync admission without changing legacy/manual Alexa checks.
ALTER TABLE sync_jobs DROP CONSTRAINT sync_jobs_marketplace_check;
ALTER TABLE sync_jobs ADD CONSTRAINT sync_jobs_marketplace_check CHECK (marketplace IN ('US', 'UK', 'DE', 'CA'));
ALTER TABLE sync_job_submissions DROP CONSTRAINT sync_job_submissions_marketplace_check;
ALTER TABLE sync_job_submissions ADD CONSTRAINT sync_job_submissions_marketplace_check CHECK (marketplace IN ('US', 'UK', 'DE', 'CA'));
