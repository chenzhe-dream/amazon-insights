CREATE TABLE system_owners (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
 organization_id TEXT NOT NULL UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(user_id,organization_id) REFERENCES users(id,organization_id) ON DELETE RESTRICT
);

CREATE FUNCTION protect_system_owner_registry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'protected system owner'; END IF;
 IF NOT EXISTS (
  SELECT 1 FROM users u JOIN auth_identities i ON i.user_id=u.id AND i.provider='dingtalk'
  WHERE u.id=NEW.user_id AND u.organization_id=NEW.organization_id
    AND u.role='admin' AND u.status='active' AND u.archived_at IS NULL
 ) THEN RAISE EXCEPTION 'system owner requires an active DingTalk administrator'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER system_owner_registry_guard BEFORE INSERT OR UPDATE OR DELETE ON system_owners
 FOR EACH ROW EXECUTE FUNCTION protect_system_owner_registry();

CREATE FUNCTION protect_system_owner_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM system_owners WHERE user_id=OLD.id) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'protected system owner'; END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.role<>'admin'
    OR NEW.status<>'active' OR NEW.archived_at IS NOT NULL
  THEN RAISE EXCEPTION 'protected system owner'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER system_owner_account_guard BEFORE UPDATE OR DELETE ON users
 FOR EACH ROW EXECUTE FUNCTION protect_system_owner_account();
