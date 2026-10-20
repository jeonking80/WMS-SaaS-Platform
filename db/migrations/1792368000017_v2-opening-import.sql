-- Up Migration
CREATE TABLE v2_opening_imports (
 id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id), warehouse_id uuid NOT NULL,
 request_id uuid NOT NULL, phase text NOT NULL CHECK(phase IN('request','approve','reject')),
 parent_id uuid, payload jsonb NOT NULL, actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,warehouse_id,id),
 UNIQUE(tenant_id,request_id), UNIQUE(tenant_id,parent_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id,parent_id) REFERENCES v2_opening_imports(tenant_id,warehouse_id,id),
 CHECK((phase='request' AND parent_id IS NULL) OR (phase<>'request' AND parent_id IS NOT NULL))
);
ALTER TABLE v2_opening_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE v2_opening_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON v2_opening_imports USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY warehouse_scope ON v2_opening_imports AS RESTRICTIVE
 USING((SELECT NULLIF(current_setting('app.user_id',true),'')) IS NULL OR warehouse_id=ANY((SELECT v2_authorized_warehouse_ids())::uuid[]))
 WITH CHECK((SELECT NULLIF(current_setting('app.user_id',true),'')) IS NULL OR warehouse_id=ANY((SELECT v2_authorized_warehouse_ids())::uuid[]));
CREATE TRIGGER v2_opening_imports_immutable BEFORE UPDATE OR DELETE ON v2_opening_imports
 FOR EACH ROW EXECUTE FUNCTION v2_workflow_immutable();
-- Down Migration
DROP TABLE v2_opening_imports;
