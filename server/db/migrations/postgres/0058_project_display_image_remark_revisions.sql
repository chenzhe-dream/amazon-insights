ALTER TABLE project_display_versions
  DROP CONSTRAINT project_display_versions_revision_kind_check,
  DROP CONSTRAINT project_display_revision_lineage_check;

ALTER TABLE project_display_versions
  ADD COLUMN image_remark_evidence_json JSONB
    CHECK (image_remark_evidence_json IS NULL OR jsonb_typeof(image_remark_evidence_json) = 'object'),
  ADD CONSTRAINT project_display_revision_kind_check CHECK (
    revision_kind IN ('job-publication', 'catalog-revision', 'image-remarks-revision')
  ),
  ADD CONSTRAINT project_display_revision_lineage_check CHECK (
    (revision_kind = 'job-publication' AND supersedes_version_id IS NULL)
    OR (revision_kind = 'catalog-revision' AND supersedes_version_id IS NOT NULL AND catalog_evidence_json IS NOT NULL)
    OR (revision_kind = 'image-remarks-revision' AND supersedes_version_id IS NOT NULL
        AND image_remark_evidence_json IS NOT NULL)
  );
