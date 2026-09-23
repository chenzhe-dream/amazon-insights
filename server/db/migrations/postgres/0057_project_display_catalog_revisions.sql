ALTER TABLE project_display_versions
  DROP CONSTRAINT project_display_versions_project_id_source_job_id_key;

ALTER TABLE project_display_versions
  ADD COLUMN revision_kind TEXT NOT NULL DEFAULT 'job-publication'
    CHECK (revision_kind IN ('job-publication', 'catalog-revision')),
  ADD COLUMN supersedes_version_id TEXT,
  ADD COLUMN catalog_evidence_json JSONB
    CHECK (catalog_evidence_json IS NULL OR jsonb_typeof(catalog_evidence_json) = 'object'),
  ADD CONSTRAINT project_display_revision_lineage_check CHECK (
    (revision_kind = 'job-publication' AND supersedes_version_id IS NULL)
    OR (revision_kind = 'catalog-revision' AND supersedes_version_id IS NOT NULL AND catalog_evidence_json IS NOT NULL)
  ),
  ADD CONSTRAINT project_display_supersedes_fk
    FOREIGN KEY (project_id, supersedes_version_id)
    REFERENCES project_display_versions(project_id, id)
    ON DELETE SET NULL (supersedes_version_id);

CREATE UNIQUE INDEX project_display_one_publication_per_job_idx
  ON project_display_versions(project_id, source_job_id)
  WHERE revision_kind = 'job-publication';

CREATE UNIQUE INDEX project_display_one_revision_per_version_idx
  ON project_display_versions(project_id, supersedes_version_id)
  WHERE supersedes_version_id IS NOT NULL;
