-- SQLite VOC row validation is delegated by the insert trigger to the
-- application-registered voc_snapshot_integrity function. Recording this
-- forward migration keeps deployed schemas aligned with the validator change.
SELECT 1;
