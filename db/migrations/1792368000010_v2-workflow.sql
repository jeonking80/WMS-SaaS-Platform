-- Up Migration
CREATE TABLE v2_workflow_state (
 tenant_id uuid NOT NULL REFERENCES tenants(id), warehouse_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 0 CHECK(version >= 0), state jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(tenant_id,warehouse_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TABLE v2_workflow_stock (
 tenant_id uuid NOT NULL, warehouse_id uuid NOT NULL, item_id uuid NOT NULL, location_id uuid NOT NULL,
 s bigint NOT NULL DEFAULT 0 CHECK(s>=0), r bigint NOT NULL DEFAULT 0 CHECK(r>=0 AND r<=s),
 p bigint NOT NULL DEFAULT 0 CHECK(p>=0), q bigint NOT NULL DEFAULT 0 CHECK(q>=0), b bigint NOT NULL DEFAULT 0 CHECK(b>=0),
 PRIMARY KEY(tenant_id,warehouse_id,item_id,location_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES v2_workflow_state(tenant_id,warehouse_id),
 FOREIGN KEY(tenant_id,item_id) REFERENCES items(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id,location_id) REFERENCES locations(tenant_id,warehouse_id,id)
);
CREATE TABLE v2_workflow_objects (
 tenant_id uuid NOT NULL,warehouse_id uuid NOT NULL,id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('receipt','order','return','package','shipment','approval','count')),
 external_id text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,kind,external_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES v2_workflow_state(tenant_id,warehouse_id)
);
CREATE TABLE v2_workflow_requests (
 tenant_id uuid NOT NULL,warehouse_id uuid NOT NULL,request_id uuid NOT NULL,
 request_hash text NOT NULL,command text NOT NULL,actor_id text NOT NULL,response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(tenant_id,request_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES v2_workflow_state(tenant_id,warehouse_id)
);
CREATE TABLE v2_workflow_performances (
 tenant_id uuid NOT NULL,warehouse_id uuid NOT NULL,request_id uuid NOT NULL,actor_id text NOT NULL,command text NOT NULL,
 evidence jsonb NOT NULL,reason text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(tenant_id,request_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES v2_workflow_requests(tenant_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES v2_workflow_state(tenant_id,warehouse_id)
);
CREATE TABLE v2_workflow_receivings (
 tenant_id uuid NOT NULL,warehouse_id uuid NOT NULL,receiving_id uuid NOT NULL,request_id uuid NOT NULL,object_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,receiving_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES v2_workflow_requests(tenant_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,object_id) REFERENCES v2_workflow_objects(tenant_id,id)
);
CREATE TABLE v2_workflow_ledger (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,warehouse_id uuid NOT NULL,item_id uuid NOT NULL,location_id uuid NOT NULL,
 request_id uuid NOT NULL,actor_id text NOT NULL,command text NOT NULL,bucket varchar(1) NOT NULL CHECK(bucket IN('S','R','P','Q','B')),
 delta bigint NOT NULL CHECK(delta<>0),reason text NOT NULL DEFAULT '',original_id text,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(tenant_id,request_id) REFERENCES v2_workflow_requests(tenant_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,warehouse_id,item_id,location_id) REFERENCES v2_workflow_stock(tenant_id,warehouse_id,item_id,location_id)
);
CREATE INDEX v2_workflow_ledger_balance ON v2_workflow_ledger(tenant_id,warehouse_id,item_id,location_id,bucket) INCLUDE(delta);
CREATE INDEX v2_workflow_ledger_scope ON v2_workflow_ledger(tenant_id,warehouse_id,created_at,id);
CREATE FUNCTION v2_workflow_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Workflow history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER v2_workflow_ledger_immutable BEFORE UPDATE OR DELETE ON v2_workflow_ledger FOR EACH ROW EXECUTE FUNCTION v2_workflow_immutable();
CREATE TRIGGER v2_workflow_performances_immutable BEFORE UPDATE OR DELETE ON v2_workflow_performances FOR EACH ROW EXECUTE FUNCTION v2_workflow_immutable();
CREATE TRIGGER v2_workflow_receivings_immutable BEFORE UPDATE OR DELETE ON v2_workflow_receivings FOR EACH ROW EXECUTE FUNCTION v2_workflow_immutable();
CREATE TRIGGER v2_workflow_requests_immutable BEFORE UPDATE OR DELETE ON v2_workflow_requests FOR EACH ROW EXECUTE FUNCTION v2_workflow_immutable();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['v2_workflow_state','v2_workflow_stock','v2_workflow_objects','v2_workflow_requests','v2_workflow_performances','v2_workflow_receivings','v2_workflow_ledger'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END LOOP; END $$;
-- Down Migration
DROP TABLE v2_workflow_ledger;
DROP TABLE v2_workflow_performances;
DROP TABLE v2_workflow_receivings;
DROP TABLE v2_workflow_requests;
DROP TABLE v2_workflow_objects;
DROP TABLE v2_workflow_stock;
DROP TABLE v2_workflow_state;
DROP FUNCTION v2_workflow_immutable();
