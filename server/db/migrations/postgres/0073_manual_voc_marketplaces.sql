-- Preserve historic US records; admit explicitly scoped new records.
ALTER TABLE manual_alexa_voc_revisions DROP CONSTRAINT manual_alexa_voc_revisions_marketplace_check;
ALTER TABLE manual_alexa_voc_revisions ADD CONSTRAINT manual_alexa_voc_revisions_marketplace_check CHECK (marketplace IN ('US', 'UK', 'DE', 'CA'));
ALTER TABLE manual_alexa_voc_heads DROP CONSTRAINT manual_alexa_voc_heads_marketplace_check;
ALTER TABLE manual_alexa_voc_heads ADD CONSTRAINT manual_alexa_voc_heads_marketplace_check CHECK (marketplace IN ('US', 'UK', 'DE', 'CA'));
ALTER TABLE manual_alexa_voc_publication_outbox DROP CONSTRAINT manual_alexa_voc_publication_outbox_marketplace_check;
ALTER TABLE manual_alexa_voc_publication_outbox ADD CONSTRAINT manual_alexa_voc_publication_outbox_marketplace_check CHECK (marketplace IN ('US', 'UK', 'DE', 'CA'));
ALTER TABLE manual_alexa_voc_access_audit DROP CONSTRAINT manual_alexa_voc_access_audit_marketplace_check;
ALTER TABLE manual_alexa_voc_access_audit ADD CONSTRAINT manual_alexa_voc_access_audit_marketplace_check CHECK (marketplace IN ('US', 'UK', 'DE', 'CA'));
