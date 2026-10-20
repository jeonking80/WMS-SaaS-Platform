-- Up Migration
ALTER TABLE tenants ADD COLUMN is_test boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN idle_lock_minutes integer NOT NULL DEFAULT 15 CHECK(idle_lock_minutes BETWEEN 1 AND 240);
ALTER TABLE "session" ADD COLUMN last_protected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('admin','supervisor','worker','viewer'));
ALTER TABLE memberships ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended','departed'));
ALTER TABLE memberships ADD COLUMN updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE memberships ADD CONSTRAINT memberships_tenant_user_unique UNIQUE (tenant_id,user_id);
CREATE TABLE v2_warehouse_grants (
 tenant_id uuid NOT NULL, user_id text NOT NULL, warehouse_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,user_id,warehouse_id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
-- Preserve existing access at migration; later warehouses require explicit grants.
INSERT INTO v2_warehouse_grants SELECT m.tenant_id,m.user_id,w.id FROM memberships m JOIN warehouses w ON w.tenant_id=m.tenant_id;
CREATE TABLE v2_identity_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 user_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('invite','reset')),
 token_hash text NOT NULL UNIQUE CHECK(length(token_hash)=64),
 expires_at timestamptz NOT NULL, consumed_at timestamptz, revoked_at timestamptz,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE v2_machine_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 128),
 source_system text NOT NULL CHECK(length(btrim(source_system)) BETWEEN 1 AND 128),
 environment text NOT NULL CHECK(environment IN ('test','production')),
 kind text NOT NULL CHECK(kind IN ('integration','automation')),
 role text NOT NULL DEFAULT 'worker' CHECK(role IN ('worker','supervisor')),
 scopes text[] NOT NULL CHECK(cardinality(scopes)>0),
 token_hash text NOT NULL UNIQUE CHECK(length(token_hash)=64),
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 rotated_from uuid,
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,rotated_from) REFERENCES v2_machine_keys(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id),
 CHECK(kind <> 'automation' OR environment='test')
);
CREATE TABLE v2_machine_warehouses (
 tenant_id uuid NOT NULL, key_id uuid NOT NULL, warehouse_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,key_id,warehouse_id),
 FOREIGN KEY(tenant_id,key_id) REFERENCES v2_machine_keys(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TABLE v2_identity_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 actor_id text NOT NULL, target_id text NOT NULL,
 action text NOT NULL, request_id uuid NOT NULL DEFAULT gen_random_uuid(),
 details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE TRIGGER v2_identity_audit_immutable BEFORE UPDATE OR DELETE ON v2_identity_audit FOR EACH ROW EXECUTE FUNCTION v2_workflow_immutable();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['v2_warehouse_grants','v2_identity_links','v2_machine_keys','v2_machine_warehouses','v2_identity_audit'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 END LOOP;
END $$;
-- Application must manage membership lifecycle, but cannot change a user's tenant.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wms_app') THEN
 GRANT SELECT,INSERT,UPDATE,DELETE ON v2_warehouse_grants,v2_identity_links,v2_machine_keys,v2_machine_warehouses TO wms_app;
 GRANT SELECT,INSERT ON v2_identity_audit TO wms_app;
 GRANT UPDATE(idle_lock_minutes) ON tenants TO wms_app;
 GRANT INSERT(user_id,tenant_id,role,status),UPDATE(role,status,updated_at) ON memberships TO wms_app;
 END IF;
END $$;

-- Down Migration
DROP TABLE v2_identity_audit,v2_machine_warehouses,v2_machine_keys,v2_identity_links,v2_warehouse_grants;
ALTER TABLE memberships DROP CONSTRAINT memberships_tenant_user_unique;
ALTER TABLE memberships DROP COLUMN updated_at, DROP COLUMN status;
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK(role IN ('admin','worker','viewer'));
ALTER TABLE "session" DROP COLUMN last_protected_at;
ALTER TABLE tenants DROP COLUMN is_test, DROP COLUMN idle_lock_minutes;
