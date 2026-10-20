-- Up Migration
CREATE TABLE api_request_metrics (
 tenant_id uuid NOT NULL REFERENCES tenants(id),warehouse_id uuid NOT NULL,request_id uuid NOT NULL,
 actor_id text NOT NULL,operation varchar(100) NOT NULL,command varchar(64),method varchar(8) NOT NULL,
 status integer NOT NULL CHECK(status BETWEEN 100 AND 599),error_code varchar(100) NOT NULL,
 duration_ms integer NOT NULL CHECK(duration_ms>=0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE INDEX api_request_metrics_scope ON api_request_metrics(tenant_id,warehouse_id,created_at DESC) INCLUDE(status,error_code,operation,command,duration_ms);
ALTER TABLE api_request_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_request_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_request_metrics USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY warehouse_scope ON api_request_metrics AS RESTRICTIVE USING(v2_can_access_warehouse(tenant_id,warehouse_id))
 WITH CHECK(v2_can_access_warehouse(tenant_id,warehouse_id));
CREATE TRIGGER api_request_metrics_immutable BEFORE UPDATE OR DELETE ON api_request_metrics FOR EACH ROW EXECUTE FUNCTION v2_workflow_immutable();
-- Down Migration
DROP TABLE api_request_metrics;
