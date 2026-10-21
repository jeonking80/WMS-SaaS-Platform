-- Generated from canonical migrations. Run the ENTIRE file in Neon SQL Editor, wms_demo.
-- Existing users, passwords, documents and inventory are retained. No seed/reset/cutover is performed.
BEGIN;
DO $target$ BEGIN
 IF current_database()<>'wms_demo' THEN RAISE EXCEPTION 'Select wms_demo'; END IF;
 IF to_regclass('public.pgmigrations') IS NULL THEN RAISE EXCEPTION 'Existing WMS database required'; END IF;
END $target$;
SET LOCAL ROLE wms_migrator;
SET LOCAL search_path=public;
SELECT pg_advisory_xact_lock(hashtext('wms-field-operations-upgrade'));
DO $history$ DECLARE existing text[]; expected text[]:=ARRAY['1792368000000_create-tenants','1792368000001_auth','1792368000002_tenant-access','1792368000003_p2-drafts','1792368000004_p3-posting','1792368000005_p5-reversals','1792368000006_p6-dashboard','1792368000007_outbound-delivery','1792368000008_delivery-destinations','1792368000009_document-numbers','1792368000010_v2-workflow','1792368000011_v2-identity','1792368000012_v2-masters','1792368000013_v2-integration','1792368000014_v2-cutover','1792368000015_api-request-metrics','1792368000016_v2-warehouse-policy-plan','1792368000017_v2-opening-import','1792368000018_v2-security-persistence','1792368000019_v2-object-state','1792368000020_v2-count-master-usage','1792368000021_v2-supplier-pending-lots']; n integer; BEGIN
 SELECT array_agg(name::text ORDER BY name),count(*) INTO existing,n FROM public.pgmigrations;
 IF n<10 OR n>22 OR existing IS DISTINCT FROM expected[1:n] THEN
  RAISE EXCEPTION 'Expected a complete known migration prefix (10 through 22); nothing changed';
 END IF;
END $history$;

-- 1792368000010_v2-workflow.sql
DO $upgrade$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000010_v2-workflow') THEN
 EXECUTE $migration_sql$CREATE TABLE v2_workflow_state (
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
 END LOOP; END $$;$migration_sql$;
 INSERT INTO public.pgmigrations(name,run_on) VALUES('1792368000010_v2-workflow',CURRENT_TIMESTAMP);
 END IF;
END $upgrade$;

-- 1792368000011_v2-identity.sql
DO $upgrade$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000011_v2-identity') THEN
 EXECUTE $migration_sql$ALTER TABLE tenants ADD COLUMN is_test boolean NOT NULL DEFAULT false;
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
END $$;$migration_sql$;
 INSERT INTO public.pgmigrations(name,run_on) VALUES('1792368000011_v2-identity',CURRENT_TIMESTAMP);
 END IF;
END $upgrade$;

-- 1792368000012_v2-masters.sql
DO $upgrade$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000012_v2-masters') THEN
 EXECUTE $migration_sql$ALTER TABLE items ADD COLUMN search_terms text NOT NULL DEFAULT '',
  ADD COLUMN base_unit text NOT NULL DEFAULT 'EA' CHECK (base_unit = 'EA');
ALTER TABLE locations ADD COLUMN kind text NOT NULL DEFAULT 'STORAGE' CHECK (kind IN ('RECEIVING','STORAGE','STAGING','SHIPPING','HOLD')),
  ADD COLUMN priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0),
  ADD COLUMN reservation_blocked boolean NOT NULL DEFAULT false;
CREATE TABLE business_partners (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 code varchar(64) NOT NULL CHECK (length(btrim(code)) > 0), name varchar(128) NOT NULL CHECK (length(btrim(name)) > 0),
 supplier boolean NOT NULL DEFAULT false, customer boolean NOT NULL DEFAULT false,
 external_code varchar(128) NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (supplier OR customer), UNIQUE(tenant_id,id), UNIQUE(tenant_id,code)
);
CREATE UNIQUE INDEX business_partners_external_key ON business_partners(tenant_id,external_code) WHERE external_code <> '';
ALTER TABLE delivery_destinations ADD COLUMN partner_id uuid,
 ADD COLUMN external_code varchar(128) NOT NULL DEFAULT '',
 ADD COLUMN contact_name varchar(128) NOT NULL DEFAULT '', ADD COLUMN phone varchar(64) NOT NULL DEFAULT '',
 ADD CONSTRAINT delivery_destinations_partner_fk FOREIGN KEY(tenant_id,partner_id) REFERENCES business_partners(tenant_id,id);
CREATE UNIQUE INDEX delivery_destinations_external_key ON delivery_destinations(tenant_id,external_code) WHERE external_code <> '';
CREATE TABLE master_barcodes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 barcode varchar(128) NOT NULL CHECK (barcode = btrim(barcode) AND length(barcode)>0),
 item_id uuid, location_id uuid, unit text, quantity integer,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,barcode),
 FOREIGN KEY(tenant_id,item_id) REFERENCES items(tenant_id,id),
 FOREIGN KEY(tenant_id,location_id) REFERENCES locations(tenant_id,id),
 CHECK ((item_id IS NOT NULL AND location_id IS NULL AND unit IS NOT NULL AND quantity IS NOT NULL AND ((unit='EA' AND quantity=1) OR (unit='BOX' AND quantity BETWEEN 2 AND 1000000000)))
 OR (item_id IS NULL AND location_id IS NOT NULL AND unit IS NULL AND quantity IS NULL))
);
CREATE TABLE master_csv_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 warehouse_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('items','locations','partners','destinations','barcodes','receipts','orders')),
 request_key varchar(128) NOT NULL, fingerprint text NOT NULL, rows jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TABLE master_csv_applies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 preview_id uuid NOT NULL, request_key varchar(128) NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES master_csv_previews(tenant_id,id)
);
CREATE TABLE master_csv_applied_rows (
 tenant_id uuid NOT NULL REFERENCES tenants(id), preview_id uuid NOT NULL, row_number integer NOT NULL,
 result jsonb NOT NULL, PRIMARY KEY(tenant_id,preview_id,row_number),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES master_csv_previews(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['business_partners','master_barcodes','master_csv_previews','master_csv_applies','master_csv_applied_rows'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE FUNCTION master_barcode_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BARCODE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF (NEW.tenant_id,NEW.barcode,NEW.item_id,NEW.location_id,NEW.unit,NEW.quantity) IS DISTINCT FROM
 (OLD.tenant_id,OLD.barcode,OLD.item_id,OLD.location_id,OLD.unit,OLD.quantity) THEN
 RAISE EXCEPTION 'BARCODE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.active=false AND OLD.active=true AND (master_workflow_in_use(OLD.tenant_id,CASE WHEN OLD.item_id IS NOT NULL THEN 'items' ELSE 'locations' END,COALESCE(OLD.item_id,OLD.location_id)) OR EXISTS(SELECT 1 FROM stock_balances WHERE tenant_id=OLD.tenant_id AND (item_id=OLD.item_id OR location_id=OLD.location_id) AND quantity>0)) THEN RAISE EXCEPTION 'MASTER_IN_USE' USING ERRCODE='23503'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER master_barcode_immutable BEFORE UPDATE OR DELETE ON master_barcodes FOR EACH ROW EXECUTE FUNCTION master_barcode_immutable();
-- Existing endpoints also obey physical stock and unfinished-document blocking.
CREATE FUNCTION master_workflow_in_use(target_tenant uuid,target_kind text,target_id uuid) RETURNS boolean LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE st jsonb; obj jsonb; ln jsonb;
BEGIN
 IF target_kind IN ('items','locations') AND EXISTS(SELECT 1 FROM v2_workflow_stock WHERE tenant_id=target_tenant
 AND ((target_kind='items' AND item_id=target_id) OR (target_kind='locations' AND location_id=target_id))
 AND (s>0 OR r>0 OR p>0 OR q>0 OR b>0)) THEN RETURN true; END IF;
 FOR st IN SELECT state FROM v2_workflow_state WHERE tenant_id=target_tenant LOOP
  FOR obj IN SELECT value FROM jsonb_array_elements(COALESCE(st->'receipts','[]') || COALESCE(st->'returns','[]')) LOOP
   IF NOT COALESCE((obj->>'closed')::boolean,false) THEN
    IF target_kind='partners' AND obj->>'supplier_id'=target_id::text AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(obj->'lines','[]')) l WHERE COALESCE((l->>'quantity')::bigint,0)>COALESCE((l->>'received')::bigint,0)+COALESCE((l->>'cancelled')::bigint,0)) THEN RETURN true; END IF;
    FOR ln IN SELECT value FROM jsonb_array_elements(COALESCE(obj->'lines','[]')) LOOP
     IF target_kind='items' AND ln->>'item_id'=target_id::text AND COALESCE((ln->>'quantity')::bigint,0)>COALESCE((ln->>'received')::bigint,0)+COALESCE((ln->>'cancelled')::bigint,0) THEN RETURN true; END IF;
    END LOOP;
   END IF;
  END LOOP;
  FOR obj IN SELECT value FROM jsonb_array_elements(COALESCE(st->'orders','[]')) LOOP
   FOR ln IN SELECT value FROM jsonb_array_elements(COALESCE(obj->'lines','[]')) LOOP
    IF COALESCE((ln->>'quantity')::bigint,0)>COALESCE((ln->>'shipped')::bigint,0)+COALESCE((ln->>'cancelled')::bigint,0) THEN
     IF (target_kind='items' AND ln->>'item_id'=target_id::text)
      OR (target_kind='partners' AND obj->'delivery'->>'partner_id'=target_id::text)
      OR (target_kind='destinations' AND (obj->'delivery'->>'destination_id'=target_id::text OR obj->'delivery'->>'delivery_destination_id'=target_id::text)) THEN RETURN true; END IF;
    END IF;
   END LOOP;
  END LOOP;
  FOR obj IN SELECT value FROM jsonb_array_elements(COALESCE(st->'counts','[]')) LOOP
   IF obj->>'status' IN ('counting','submitted') AND (target_kind='locations' AND obj->>'location_id'=target_id::text OR target_kind='items' AND (obj->'baseline')::text LIKE '%' || target_id::text || '%') THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END $$;
CREATE FUNCTION master_active_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$ DECLARE used boolean; BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MASTER_DELETE_FORBIDDEN' USING ERRCODE='23503'; END IF;
 IF NEW.active=false AND OLD.active=true OR (TG_TABLE_NAME='business_partners' AND ((to_jsonb(OLD)->>'supplier'='true' AND to_jsonb(NEW)->>'supplier'='false') OR (to_jsonb(OLD)->>'customer'='true' AND to_jsonb(NEW)->>'customer'='false'))) OR (TG_TABLE_NAME='locations' AND (to_jsonb(NEW)->>'warehouse_id',to_jsonb(NEW)->>'kind') IS DISTINCT FROM (to_jsonb(OLD)->>'warehouse_id',to_jsonb(OLD)->>'kind')) THEN
 IF master_workflow_in_use(OLD.tenant_id,CASE TG_TABLE_NAME WHEN 'business_partners' THEN 'partners' WHEN 'delivery_destinations' THEN 'destinations' ELSE TG_TABLE_NAME END,OLD.id) THEN RAISE EXCEPTION 'MASTER_IN_USE' USING ERRCODE='23503'; END IF;
 IF TG_TABLE_NAME='items' THEN
 SELECT EXISTS(SELECT 1 FROM stock_balances WHERE tenant_id=OLD.tenant_id AND item_id=OLD.id AND quantity>0)
 OR EXISTS(SELECT 1 FROM inventory_document_lines l JOIN inventory_documents d ON d.tenant_id=l.tenant_id AND d.id=l.document_id WHERE l.tenant_id=OLD.tenant_id AND l.item_id=OLD.id AND d.status='DRAFT') INTO used;
 ELSIF TG_TABLE_NAME='locations' THEN
 SELECT EXISTS(SELECT 1 FROM stock_balances WHERE tenant_id=OLD.tenant_id AND location_id=OLD.id AND quantity>0)
 OR EXISTS(SELECT 1 FROM inventory_documents WHERE tenant_id=OLD.tenant_id AND status='DRAFT' AND (source_location_id=OLD.id OR destination_location_id=OLD.id)) INTO used;
 END IF;
 IF used THEN RAISE EXCEPTION 'MASTER_IN_USE' USING ERRCODE='23503'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER items_active_guard BEFORE UPDATE OR DELETE ON items FOR EACH ROW EXECUTE FUNCTION master_active_guard();
CREATE TRIGGER locations_active_guard BEFORE UPDATE OR DELETE ON locations FOR EACH ROW EXECUTE FUNCTION master_active_guard();
CREATE TRIGGER partners_delete_guard BEFORE UPDATE OR DELETE ON business_partners FOR EACH ROW EXECUTE FUNCTION master_active_guard();
CREATE TRIGGER destinations_delete_guard BEFORE UPDATE OR DELETE ON delivery_destinations FOR EACH ROW EXECUTE FUNCTION master_active_guard();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wms_app') THEN
 GRANT SELECT,INSERT,UPDATE,DELETE ON business_partners,master_barcodes,master_csv_previews,master_csv_applies,master_csv_applied_rows TO wms_app;
END IF; END $$;$migration_sql$;
 INSERT INTO public.pgmigrations(name,run_on) VALUES('1792368000012_v2-masters',CURRENT_TIMESTAMP);
 END IF;
END $upgrade$;

-- 1792368000013_v2-integration.sql
DO $upgrade$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000013_v2-integration') THEN
 EXECUTE $migration_sql$CREATE TABLE v2_integration_limits (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  rate_per_minute integer NOT NULL DEFAULT 600 CHECK (rate_per_minute BETWEEN 1 AND 60000),
  queue_limit integer NOT NULL DEFAULT 10000 CHECK (queue_limit BETWEEN 1 AND 1000000),
  window_start timestamptz NOT NULL DEFAULT now(),
  window_count integer NOT NULL DEFAULT 0 CHECK (window_count >= 0)
);
CREATE TABLE v2_integration_entities (
  tenant_id uuid NOT NULL REFERENCES tenants(id), source_system varchar(100) NOT NULL,
  entity_kind varchar(30) NOT NULL, external_entity_id varchar(160) NOT NULL,
  warehouse_id uuid NOT NULL, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  object_id uuid, PRIMARY KEY(tenant_id,source_system,entity_kind,external_entity_id),
  FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TABLE v2_integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sequence bigserial UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id), source_system varchar(100) NOT NULL,
  warehouse_id uuid NOT NULL, actor_id text NOT NULL, source_key_id uuid NOT NULL, event_id uuid NOT NULL, entity_kind varchar(30) NOT NULL,
  external_entity_id varchar(160) NOT NULL, revision integer NOT NULL CHECK(revision > 0),
  event_type varchar(60) NOT NULL, schema_version varchar(8) NOT NULL CHECK(schema_version='2.0'),
  occurred_at timestamptz NOT NULL, correlation_id varchar(160) NOT NULL, run_id varchar(160),
  request_hash char(64) NOT NULL, revision_hash char(64) NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  status varchar(30) NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted','dependency_wait','applied','business_rejected','retry_wait','quarantined')),
  reason varchar(100), result jsonb, attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(), received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  UNIQUE(tenant_id,source_system,event_id),
  UNIQUE(tenant_id,source_system,entity_kind,external_entity_id,revision),
  FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE INDEX v2_integration_pending ON v2_integration_events(tenant_id,warehouse_id,next_attempt_at,sequence) WHERE status IN ('accepted','dependency_wait','retry_wait');
CREATE INDEX v2_integration_poll ON v2_integration_events(tenant_id,source_system,warehouse_id,sequence);
ALTER TABLE v2_integration_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE v2_integration_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY v2_integration_limits_tenant ON v2_integration_limits USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE v2_integration_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE v2_integration_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY v2_integration_entities_tenant ON v2_integration_entities USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE v2_integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE v2_integration_events FORCE ROW LEVEL SECURITY;
CREATE POLICY v2_integration_events_tenant ON v2_integration_events USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
-- The content and deduplication identifiers survive result/log retention.
CREATE FUNCTION v2_integration_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'integration identifiers are retained' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','reason','result','attempts','next_attempt_at','processed_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','reason','result','attempts','next_attempt_at','processed_at']) THEN
    RAISE EXCEPTION 'integration event content is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER v2_integration_event_immutable BEFORE UPDATE OR DELETE ON v2_integration_events FOR EACH ROW EXECUTE FUNCTION v2_integration_event_immutable();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wms_app') THEN
  GRANT SELECT,INSERT,UPDATE ON v2_integration_limits,v2_integration_entities,v2_integration_events TO wms_app;
  GRANT USAGE,SELECT ON SEQUENCE v2_integration_events_sequence_seq TO wms_app;
END IF; END $$;$migration_sql$;
 INSERT INTO public.pgmigrations(name,run_on) VALUES('1792368000013_v2-integration',CURRENT_TIMESTAMP);
 END IF;
END $upgrade$;

-- 1792368000014_v2-cutover.sql
DO $upgrade$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000014_v2-cutover') THEN
 EXECUTE $migration_sql$CREATE TABLE v2_cutovers (
 tenant_id uuid NOT NULL REFERENCES tenants(id), warehouse_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state='active'),
 snapshot_hash text NOT NULL CHECK(length(snapshot_hash)=64), opening jsonb NOT NULL,
 actor_id text NOT NULL, request_id uuid NOT NULL, activated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(tenant_id,warehouse_id), UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
ALTER TABLE v2_cutovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE v2_cutovers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON v2_cutovers USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER v2_cutovers_immutable BEFORE UPDATE OR DELETE ON v2_cutovers FOR EACH ROW EXECUTE FUNCTION v2_workflow_immutable();

-- Authentication sets this server-side request context; internal maintenance still uses explicit scope checks.
CREATE FUNCTION v2_can_access_warehouse(t uuid,w uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
 SELECT CASE WHEN NULLIF(current_setting('app.user_id',true),'') IS NULL THEN true
 WHEN current_setting('app.user_id',true) LIKE 'machine:%' THEN EXISTS (
  SELECT 1 FROM v2_machine_keys k JOIN v2_machine_warehouses g ON(g.tenant_id,g.key_id)=(k.tenant_id,k.id)
  JOIN tenants tenant ON tenant.id=k.tenant_id
  WHERE k.tenant_id=t AND g.warehouse_id=w AND 'machine:'||k.id::text=current_setting('app.user_id',true)
    AND k.revoked_at IS NULL AND k.expires_at>CURRENT_TIMESTAMP AND tenant.active
    AND k.environment=COALESCE(NULLIF(current_setting('app.environment',true),''),'production')
    AND (k.environment<>'test' OR tenant.is_test)
 ) ELSE EXISTS (
  SELECT 1 FROM memberships m WHERE m.tenant_id=t AND m.user_id=current_setting('app.user_id',true) AND m.status='active'
   AND (EXISTS(SELECT 1 FROM v2_warehouse_grants g WHERE(g.tenant_id,g.user_id,g.warehouse_id)=(t,m.user_id,w))
     OR (m.role='admin' AND w::text=NULLIF(current_setting('app.creating_warehouse',true),'')))
 ) END
$$;
CREATE POLICY warehouse_scope ON warehouses AS RESTRICTIVE USING(v2_can_access_warehouse(tenant_id,id)) WITH CHECK(v2_can_access_warehouse(tenant_id,id));
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['locations','inventory_documents','stock_balances','stock_ledger','v2_workflow_state','v2_workflow_stock','v2_workflow_objects','v2_workflow_performances','v2_workflow_receivings','v2_workflow_requests','v2_workflow_ledger','v2_cutovers'] LOOP
 EXECUTE format('CREATE POLICY warehouse_scope ON %I AS RESTRICTIVE USING(v2_can_access_warehouse(tenant_id,warehouse_id)) WITH CHECK(v2_can_access_warehouse(tenant_id,warehouse_id))',tab);
 END LOOP;
END $$;
CREATE POLICY warehouse_scope ON inventory_document_lines AS RESTRICTIVE
 USING(EXISTS(SELECT 1 FROM inventory_documents d WHERE(d.tenant_id,d.id)=(inventory_document_lines.tenant_id,inventory_document_lines.document_id)))
 WITH CHECK(EXISTS(SELECT 1 FROM inventory_documents d WHERE(d.tenant_id,d.id)=(inventory_document_lines.tenant_id,inventory_document_lines.document_id)));
CREATE POLICY warehouse_scope ON audit_logs AS RESTRICTIVE
 USING(EXISTS(SELECT 1 FROM inventory_documents d WHERE(d.tenant_id,d.id)=(audit_logs.tenant_id,audit_logs.document_id)))
 WITH CHECK(EXISTS(SELECT 1 FROM inventory_documents d WHERE(d.tenant_id,d.id)=(audit_logs.tenant_id,audit_logs.document_id)));

CREATE FUNCTION v2_block_legacy_inventory() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE target_tenant uuid; target_warehouse uuid;
BEGIN
 IF TG_OP='DELETE' THEN target_tenant=OLD.tenant_id; target_warehouse=OLD.warehouse_id;
 ELSE target_tenant=NEW.tenant_id; target_warehouse=NEW.warehouse_id; END IF;
 -- The warehouse lock serializes legacy posting with cutover. No data can slip between snapshot and activation.
 PERFORM 1 FROM warehouses WHERE tenant_id=target_tenant AND id=target_warehouse FOR SHARE;
 IF EXISTS(SELECT 1 FROM v2_cutovers WHERE tenant_id=target_tenant AND warehouse_id=target_warehouse) THEN
  RAISE EXCEPTION 'WAREHOUSE_CUTOVER_READ_ONLY' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER v2_legacy_document_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_documents FOR EACH ROW EXECUTE FUNCTION v2_block_legacy_inventory();
CREATE TRIGGER v2_legacy_balance_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_balances FOR EACH ROW EXECUTE FUNCTION v2_block_legacy_inventory();
CREATE TRIGGER v2_legacy_ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_ledger FOR EACH ROW EXECUTE FUNCTION v2_block_legacy_inventory();$migration_sql$;
 INSERT INTO public.pgmigrations(name,run_on) VALUES('1792368000014_v2-cutover',CURRENT_TIMESTAMP);
 END IF;
END $upgrade$;

-- 1792368000015_api-request-metrics.sql
DO $upgrade$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000015_api-request-metrics') THEN
 EXECUTE $migration_sql$CREATE TABLE api_request_metrics (
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
CREATE TRIGGER api_request_metrics_immutable BEFORE UPDATE OR DELETE ON api_request_metrics FOR EACH ROW EXECUTE FUNCTION v2_workflow_immutable();$migration_sql$;
 INSERT INTO public.pgmigrations(name,run_on) VALUES('1792368000015_api-request-metrics',CURRENT_TIMESTAMP);
 END IF;
END $upgrade$;

-- 1792368000016_v2-warehouse-policy-plan.sql
DO $upgrade$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000016_v2-warehouse-policy-plan') THEN
 EXECUTE $migration_sql$-- Resolve live warehouse grants once per SQL statement, not once per ledger row.
-- SECURITY INVOKER and the existing FORCE tenant policies remain in force.
CREATE FUNCTION v2_authorized_warehouse_ids() RETURNS uuid[] LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
 SELECT COALESCE(array_agg(warehouse_id),ARRAY[]::uuid[]) FROM (
  SELECT g.warehouse_id
   FROM v2_warehouse_grants g JOIN memberships m ON (m.tenant_id,m.user_id)=(g.tenant_id,g.user_id)
   JOIN tenants t ON t.id=m.tenant_id
   WHERE g.tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
    AND m.user_id=NULLIF(current_setting('app.user_id',true),'') AND m.status='active' AND t.active
  UNION
  SELECT g.warehouse_id
   FROM v2_machine_keys k JOIN v2_machine_warehouses g ON (g.tenant_id,g.key_id)=(k.tenant_id,k.id)
   JOIN tenants t ON t.id=k.tenant_id
   WHERE k.tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
    AND 'machine:'||k.id::text=NULLIF(current_setting('app.user_id',true),'')
    AND k.revoked_at IS NULL AND k.expires_at>CURRENT_TIMESTAMP AND t.active
    AND k.environment=COALESCE(NULLIF(current_setting('app.environment',true),''),'production')
    AND (k.environment<>'test' OR t.is_test)
  UNION
  SELECT NULLIF(current_setting('app.creating_warehouse',true),'')::uuid AS warehouse_id
   WHERE NULLIF(current_setting('app.creating_warehouse',true),'') IS NOT NULL
    AND EXISTS(SELECT 1 FROM memberships m JOIN tenants t ON t.id=m.tenant_id
     WHERE m.tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
      AND m.user_id=NULLIF(current_setting('app.user_id',true),'') AND m.status='active' AND m.role='admin' AND t.active)
 ) allowed
$$;
ALTER POLICY warehouse_scope ON warehouses
 USING((SELECT NULLIF(current_setting('app.user_id',true),'')) IS NULL OR id=ANY((SELECT v2_authorized_warehouse_ids())::uuid[]))
 WITH CHECK((SELECT NULLIF(current_setting('app.user_id',true),'')) IS NULL OR id=ANY((SELECT v2_authorized_warehouse_ids())::uuid[]));
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['locations','inventory_documents','stock_balances','stock_ledger','v2_workflow_state','v2_workflow_stock','v2_workflow_objects','v2_workflow_performances','v2_workflow_receivings','v2_workflow_requests','v2_workflow_ledger','v2_cutovers','api_request_metrics'] LOOP
  EXECUTE format('ALTER POLICY warehouse_scope ON %I USING((SELECT NULLIF(current_setting(''app.user_id'',true),'''')) IS NULL OR warehouse_id=ANY((SELECT v2_authorized_warehouse_ids())::uuid[])) WITH CHECK((SELECT NULLIF(current_setting(''app.user_id'',true),'''')) IS NULL OR warehouse_id=ANY((SELECT v2_authorized_warehouse_ids())::uuid[]))',tab);
 END LOOP;
END $$;$migration_sql$;
 INSERT INTO public.pgmigrations(name,run_on) VALUES('1792368000016_v2-warehouse-policy-plan',CURRENT_TIMESTAMP);
 END IF;
END $upgrade$;

-- 1792368000017_v2-opening-import.sql
DO $upgrade$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000017_v2-opening-import') THEN
 EXECUTE $migration_sql$CREATE TABLE v2_opening_imports (
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
 FOR EACH ROW EXECUTE FUNCTION v2_workflow_immutable();$migration_sql$;
 INSERT INTO public.pgmigrations(name,run_on) VALUES('1792368000017_v2-opening-import',CURRENT_TIMESTAMP);
 END IF;
END $upgrade$;

-- 1792368000018_v2-security-persistence.sql
DO $upgrade$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000018_v2-security-persistence') THEN
 EXECUTE $migration_sql$-- Explicit pg_temp last prevents temporary-table shadowing inside definer guards.
SELECT set_config('search_path',current_setting('search_path') || ', pg_temp',true);
ALTER FUNCTION master_workflow_in_use(uuid,text,uuid) RENAME TO master_workflow_in_use_scoped;
ALTER FUNCTION master_workflow_in_use_scoped(uuid,text,uuid) SET search_path FROM CURRENT;
REVOKE ALL ON FUNCTION master_workflow_in_use_scoped(uuid,text,uuid) FROM PUBLIC;

-- A bounded boolean safety check, never a warehouse visibility API. Company-shared
-- masters cannot be disabled while any warehouse in that same company uses them.
CREATE FUNCTION master_workflow_in_use(target_tenant uuid,target_kind text,target_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE previous_actor text := current_setting('app.user_id',true); used boolean;
BEGIN
 IF target_tenant IS NULL OR target_tenant IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'TENANT_CONTEXT_REQUIRED' USING ERRCODE='42501';
 END IF;
 IF target_kind IS NULL OR target_kind NOT IN ('items','locations','partners','destinations','barcodes') OR target_id IS NULL THEN
  RAISE EXCEPTION 'INVALID_MASTER_TARGET' USING ERRCODE='22023';
 END IF;
 -- Only this fixed query block suspends warehouse filtering. Tenant predicates
 -- remain explicit even if the migration owner is a database administrator.
 PERFORM set_config('app.user_id','',true);
 used := master_workflow_in_use_scoped(target_tenant,target_kind,target_id);
 IF NOT used AND target_kind='items' THEN
  SELECT EXISTS(SELECT 1 FROM stock_balances WHERE tenant_id=target_tenant AND item_id=target_id AND quantity>0)
   OR EXISTS(SELECT 1 FROM inventory_document_lines l JOIN inventory_documents d ON d.tenant_id=l.tenant_id AND d.id=l.document_id WHERE l.tenant_id=target_tenant AND l.item_id=target_id AND d.status='DRAFT') INTO used;
 ELSIF NOT used AND target_kind='locations' THEN
  SELECT EXISTS(SELECT 1 FROM stock_balances WHERE tenant_id=target_tenant AND location_id=target_id AND quantity>0)
   OR EXISTS(SELECT 1 FROM inventory_documents WHERE tenant_id=target_tenant AND status='DRAFT' AND (source_location_id=target_id OR destination_location_id=target_id)) INTO used;
 ELSIF NOT used AND target_kind='destinations' THEN
  SELECT EXISTS(SELECT 1 FROM inventory_documents WHERE tenant_id=target_tenant AND delivery_destination_id=target_id AND status='DRAFT') INTO used;
 END IF;
 PERFORM set_config('app.user_id',COALESCE(previous_actor,''),true);
 RETURN used;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('app.user_id',COALESCE(previous_actor,''),true);
 RAISE;
END $$;
REVOKE ALL ON FUNCTION master_workflow_in_use(uuid,text,uuid) FROM PUBLIC;
-- Trigger execution does not require callers to have direct helper privileges.
ALTER FUNCTION master_active_guard() SECURITY DEFINER;
ALTER FUNCTION master_active_guard() SET search_path FROM CURRENT;
ALTER FUNCTION master_barcode_immutable() SECURITY DEFINER;
ALTER FUNCTION master_barcode_immutable() SET search_path FROM CURRENT;
REVOKE ALL ON FUNCTION master_active_guard(),master_barcode_immutable() FROM PUBLIC;

-- Installed BetterAuth database storage schema (get-tables / incrementOne).
-- Authentication runs before tenant resolution, like account/session tables.
CREATE TABLE "rateLimit" (
 id text PRIMARY KEY,
 key text NOT NULL UNIQUE,
 count integer NOT NULL CHECK(count>=0),
 "lastRequest" bigint NOT NULL
);
CREATE INDEX auth_rate_limit_expiry ON "rateLimit"("lastRequest");
REVOKE ALL ON TABLE "rateLimit" FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wms_app') THEN
 GRANT EXECUTE ON FUNCTION master_workflow_in_use(uuid,text,uuid) TO wms_app;
 GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE "rateLimit" TO wms_app;
END IF; END $$;$migration_sql$;
 INSERT INTO public.pgmigrations(name,run_on) VALUES('1792368000018_v2-security-persistence',CURRENT_TIMESTAMP);
 END IF;
END $upgrade$;

-- 1792368000019_v2-object-state.sql
DO $upgrade$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000019_v2-object-state') THEN
 EXECUTE $migration_sql$-- Header locks remain the transaction boundary; format 2 stores every ordered array
-- element separately. The compatibility view supports legacy imports and readers.
ALTER TABLE v2_workflow_state RENAME TO v2_workflow_state_header;
-- The normal migrator owns this FORCE-RLS table without BYPASSRLS. The rename
-- holds ACCESS EXCLUSIVE through commit, so only its owner backfill bypasses RLS.
ALTER TABLE v2_workflow_state_header NO FORCE ROW LEVEL SECURITY;
ALTER TABLE v2_workflow_state_header ADD COLUMN storage_format integer NOT NULL DEFAULT 2 CHECK(storage_format=2);
CREATE TABLE v2_workflow_object_state (
 tenant_id uuid NOT NULL,warehouse_id uuid NOT NULL,kind text NOT NULL,
 object_key text NOT NULL,object_id text,position integer NOT NULL CHECK(position>=0),
 body jsonb NOT NULL,changed_version integer NOT NULL CHECK(changed_version>=0),
 PRIMARY KEY(tenant_id,warehouse_id,kind,object_key),
 UNIQUE(tenant_id,warehouse_id,kind,position),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES v2_workflow_state_header(tenant_id,warehouse_id) ON DELETE CASCADE
);
CREATE INDEX v2_workflow_object_state_id ON v2_workflow_object_state(tenant_id,warehouse_id,kind,object_id);

CREATE FUNCTION v2_workflow_full_state(target_tenant uuid,target_warehouse uuid,metadata jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
 SELECT metadata || COALESCE(jsonb_object_agg(kind,bodies),'{}'::jsonb) FROM (
  SELECT kind,jsonb_agg(body ORDER BY position) AS bodies FROM v2_workflow_object_state
  WHERE tenant_id=target_tenant AND warehouse_id=target_warehouse GROUP BY kind
 ) arrays
$$;
CREATE FUNCTION v2_workflow_state_metadata(full_state jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(jsonb_object_agg(key,CASE WHEN jsonb_typeof(value)='array' THEN '[]'::jsonb ELSE value END),'{}'::jsonb) FROM jsonb_each(full_state)
$$;
INSERT INTO v2_workflow_object_state(tenant_id,warehouse_id,kind,object_key,object_id,position,body,changed_version)
 SELECT h.tenant_id,h.warehouse_id,a.key,COALESCE(CASE WHEN jsonb_typeof(e.body->'id')='string' THEN e.body->>'id' END,'')||':'||(e.ordinality-1)::text,CASE WHEN jsonb_typeof(e.body->'id')='string' THEN e.body->>'id' END,(e.ordinality-1)::integer,e.body,h.version
 FROM v2_workflow_state_header h CROSS JOIN LATERAL jsonb_each(h.state) a
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.value)='array' THEN a.value ELSE '[]'::jsonb END) WITH ORDINALITY e(body,ordinality);
-- Prove reconstruction before replacing the original JSON in this transaction.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM v2_workflow_state_header h WHERE h.state IS DISTINCT FROM v2_workflow_full_state(h.tenant_id,h.warehouse_id,v2_workflow_state_metadata(h.state))) THEN
  RAISE EXCEPTION 'WORKFLOW_OBJECT_BACKFILL_PARITY_FAILED';
 END IF;
END $$;
UPDATE v2_workflow_state_header SET state=v2_workflow_state_metadata(state);
ALTER TABLE v2_workflow_state_header FORCE ROW LEVEL SECURITY;
ALTER TABLE v2_workflow_object_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE v2_workflow_object_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON v2_workflow_object_state
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY warehouse_scope ON v2_workflow_object_state AS RESTRICTIVE
 USING((SELECT NULLIF(current_setting('app.user_id',true),'')) IS NULL OR warehouse_id=ANY((SELECT v2_authorized_warehouse_ids())::uuid[]))
 WITH CHECK((SELECT NULLIF(current_setting('app.user_id',true),'')) IS NULL OR warehouse_id=ANY((SELECT v2_authorized_warehouse_ids())::uuid[]));
CREATE VIEW v2_workflow_state WITH (security_invoker=true) AS
 SELECT tenant_id,warehouse_id,version,v2_workflow_full_state(tenant_id,warehouse_id,state) AS state,updated_at FROM v2_workflow_state_header;
ALTER VIEW v2_workflow_state ALTER COLUMN version SET DEFAULT 0;
ALTER VIEW v2_workflow_state ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
-- Invalidate existing pooled sessions' cached plans against the renamed table.
CREATE OR REPLACE FUNCTION master_workflow_in_use_scoped(target_tenant uuid,target_kind text,target_id uuid) RETURNS boolean LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE st jsonb; obj jsonb; ln jsonb;
BEGIN
 IF target_kind IN ('items','locations') AND EXISTS(SELECT 1 FROM v2_workflow_stock WHERE tenant_id=target_tenant
 AND ((target_kind='items' AND item_id=target_id) OR (target_kind='locations' AND location_id=target_id))
 AND (s>0 OR r>0 OR p>0 OR q>0 OR b>0)) THEN RETURN true; END IF;
 FOR st IN SELECT state FROM v2_workflow_state WHERE tenant_id=target_tenant LOOP
  FOR obj IN SELECT value FROM jsonb_array_elements(COALESCE(st->'receipts','[]') || COALESCE(st->'returns','[]')) LOOP
   IF NOT COALESCE((obj->>'closed')::boolean,false) THEN
    IF target_kind='partners' AND obj->>'supplier_id'=target_id::text AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(obj->'lines','[]')) l WHERE COALESCE((l->>'quantity')::bigint,0)>COALESCE((l->>'received')::bigint,0)+COALESCE((l->>'cancelled')::bigint,0)) THEN RETURN true; END IF;
    FOR ln IN SELECT value FROM jsonb_array_elements(COALESCE(obj->'lines','[]')) LOOP
     IF target_kind='items' AND ln->>'item_id'=target_id::text AND COALESCE((ln->>'quantity')::bigint,0)>COALESCE((ln->>'received')::bigint,0)+COALESCE((ln->>'cancelled')::bigint,0) THEN RETURN true; END IF;
    END LOOP;
   END IF;
  END LOOP;
  FOR obj IN SELECT value FROM jsonb_array_elements(COALESCE(st->'orders','[]')) LOOP
   FOR ln IN SELECT value FROM jsonb_array_elements(COALESCE(obj->'lines','[]')) LOOP
    IF COALESCE((ln->>'quantity')::bigint,0)>COALESCE((ln->>'shipped')::bigint,0)+COALESCE((ln->>'cancelled')::bigint,0) THEN
     IF (target_kind='items' AND ln->>'item_id'=target_id::text)
      OR (target_kind='partners' AND obj->'delivery'->>'partner_id'=target_id::text)
      OR (target_kind='destinations' AND (obj->'delivery'->>'destination_id'=target_id::text OR obj->'delivery'->>'delivery_destination_id'=target_id::text)) THEN RETURN true; END IF;
    END IF;
   END LOOP;
  END LOOP;
  FOR obj IN SELECT value FROM jsonb_array_elements(COALESCE(st->'counts','[]')) LOOP
   IF obj->>'status' IN ('counting','submitted') AND (target_kind='locations' AND obj->>'location_id'=target_id::text OR target_kind='items' AND (obj->'baseline')::text LIKE '%' || target_id::text || '%') THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END $$;


CREATE FUNCTION v2_workflow_legacy_state_write() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE current_body jsonb; current_version integer;
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM v2_workflow_state_header WHERE tenant_id=OLD.tenant_id AND warehouse_id=OLD.warehouse_id;
  RETURN OLD;
 END IF;
 IF NEW.state IS NULL THEN RAISE EXCEPTION 'Workflow state must not be null' USING ERRCODE='23502'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.warehouse_id) IS DISTINCT FROM (OLD.tenant_id,OLD.warehouse_id) THEN
   RAISE EXCEPTION 'WORKFLOW_STATE_SCOPE_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  -- Legacy body transforms were evaluated by the view's statement snapshot.
  -- Lock separately, then reject a concurrent change rather than overwrite it.
  PERFORM 1 FROM v2_workflow_state_header WHERE tenant_id=OLD.tenant_id AND warehouse_id=OLD.warehouse_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT version,v2_workflow_full_state(tenant_id,warehouse_id,state) INTO current_version,current_body
   FROM v2_workflow_state_header WHERE tenant_id=OLD.tenant_id AND warehouse_id=OLD.warehouse_id;
  IF current_version IS DISTINCT FROM OLD.version OR current_body IS DISTINCT FROM OLD.state THEN
   RAISE EXCEPTION 'WORKFLOW_LEGACY_STATE_RETRY' USING ERRCODE='40001';
  END IF;
  UPDATE v2_workflow_state_header SET version=NEW.version,state=v2_workflow_state_metadata(NEW.state),updated_at=NEW.updated_at
   WHERE tenant_id=OLD.tenant_id AND warehouse_id=OLD.warehouse_id;
  DELETE FROM v2_workflow_object_state WHERE tenant_id=OLD.tenant_id AND warehouse_id=OLD.warehouse_id;
 ELSE
  INSERT INTO v2_workflow_state_header(tenant_id,warehouse_id,version,state,updated_at)
   VALUES(NEW.tenant_id,NEW.warehouse_id,NEW.version,v2_workflow_state_metadata(NEW.state),NEW.updated_at);
 END IF;
 INSERT INTO v2_workflow_object_state(tenant_id,warehouse_id,kind,object_key,object_id,position,body,changed_version)
 SELECT NEW.tenant_id,NEW.warehouse_id,a.key,COALESCE(CASE WHEN jsonb_typeof(e.body->'id')='string' THEN e.body->>'id' END,'')||':'||(e.ordinality-1)::text,CASE WHEN jsonb_typeof(e.body->'id')='string' THEN e.body->>'id' END,(e.ordinality-1)::integer,e.body,NEW.version
 FROM jsonb_each(NEW.state) a CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.value)='array' THEN a.value ELSE '[]'::jsonb END) WITH ORDINALITY e(body,ordinality);
 RETURN NEW;
END $$;
CREATE TRIGGER v2_workflow_legacy_state_write INSTEAD OF INSERT OR UPDATE OR DELETE ON v2_workflow_state FOR EACH ROW EXECUTE FUNCTION v2_workflow_legacy_state_write();
REVOKE ALL ON v2_workflow_object_state,v2_workflow_state FROM PUBLIC;
-- Invoker helpers have no elevated privileges: all body reads still obey RLS.
-- Existing application-specific roles inherit their normal function access.
REVOKE ALL ON FUNCTION v2_workflow_legacy_state_write() FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wms_app') THEN
 GRANT SELECT,INSERT,UPDATE,DELETE ON v2_workflow_state,v2_workflow_state_header,v2_workflow_object_state TO wms_app;
 GRANT EXECUTE ON FUNCTION v2_workflow_full_state(uuid,uuid,jsonb),v2_workflow_state_metadata(jsonb) TO wms_app;
END IF; END $$;$migration_sql$;
 INSERT INTO public.pgmigrations(name,run_on) VALUES('1792368000019_v2-object-state',CURRENT_TIMESTAMP);
 END IF;
END $upgrade$;

-- 1792368000020_v2-count-master-usage.sql
DO $upgrade$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000020_v2-count-master-usage') THEN
 EXECUTE $migration_sql$-- Counted items can be newly discovered and absent from the frozen baseline.
-- Retain the scoped guard used by service updates and direct-write triggers.
-- Keep pg_temp explicitly last even when this migration runs by itself.
SELECT set_config('search_path',current_setting('search_path') || ', pg_temp',true);
CREATE OR REPLACE FUNCTION master_workflow_in_use_scoped(target_tenant uuid,target_kind text,target_id uuid) RETURNS boolean LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE st jsonb; obj jsonb; ln jsonb;
BEGIN
 IF target_kind IN ('items','locations') AND EXISTS(SELECT 1 FROM v2_workflow_stock WHERE tenant_id=target_tenant
 AND ((target_kind='items' AND item_id=target_id) OR (target_kind='locations' AND location_id=target_id))
 AND (s>0 OR r>0 OR p>0 OR q>0 OR b>0)) THEN RETURN true; END IF;
 FOR st IN SELECT state FROM v2_workflow_state WHERE tenant_id=target_tenant LOOP
  FOR obj IN SELECT value FROM jsonb_array_elements(COALESCE(st->'receipts','[]') || COALESCE(st->'returns','[]')) LOOP
   IF NOT COALESCE((obj->>'closed')::boolean,false) THEN
    IF target_kind='partners' AND obj->>'supplier_id'=target_id::text AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(obj->'lines','[]')) l WHERE COALESCE((l->>'quantity')::bigint,0)>COALESCE((l->>'received')::bigint,0)+COALESCE((l->>'cancelled')::bigint,0)) THEN RETURN true; END IF;
    FOR ln IN SELECT value FROM jsonb_array_elements(COALESCE(obj->'lines','[]')) LOOP
     IF target_kind='items' AND ln->>'item_id'=target_id::text AND COALESCE((ln->>'quantity')::bigint,0)>COALESCE((ln->>'received')::bigint,0)+COALESCE((ln->>'cancelled')::bigint,0) THEN RETURN true; END IF;
    END LOOP;
   END IF;
  END LOOP;
  FOR obj IN SELECT value FROM jsonb_array_elements(COALESCE(st->'orders','[]')) LOOP
   FOR ln IN SELECT value FROM jsonb_array_elements(COALESCE(obj->'lines','[]')) LOOP
    IF COALESCE((ln->>'quantity')::bigint,0)>COALESCE((ln->>'shipped')::bigint,0)+COALESCE((ln->>'cancelled')::bigint,0) THEN
     IF (target_kind='items' AND ln->>'item_id'=target_id::text)
      OR (target_kind='partners' AND obj->'delivery'->>'partner_id'=target_id::text)
      OR (target_kind='destinations' AND (obj->'delivery'->>'destination_id'=target_id::text OR obj->'delivery'->>'delivery_destination_id'=target_id::text)) THEN RETURN true; END IF;
    END IF;
   END LOOP;
  END LOOP;
  FOR obj IN SELECT value FROM jsonb_array_elements(COALESCE(st->'counts','[]')) LOOP
   IF obj->>'status' IN ('counting','submitted') AND (target_kind='locations' AND obj->>'location_id'=target_id::text OR target_kind='items' AND (
    (obj->'baseline')::text LIKE '%' || target_id::text || '%'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(obj->'lines')='array' THEN obj->'lines' ELSE '[]'::jsonb END) line WHERE line->>'item_id'=target_id::text)
   )) THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END $$;$migration_sql$;
 INSERT INTO public.pgmigrations(name,run_on) VALUES('1792368000020_v2-count-master-usage',CURRENT_TIMESTAMP);
 END IF;
END $upgrade$;

-- 1792368000021_v2-supplier-pending-lots.sql
DO $upgrade$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000021_v2-supplier-pending-lots') THEN
 EXECUTE $migration_sql$-- Protect suppliers through receipt inspection, putaway and held physical work.
SELECT set_config('search_path',current_setting('search_path') || ', pg_temp',true);
CREATE OR REPLACE FUNCTION master_workflow_in_use_scoped(target_tenant uuid,target_kind text,target_id uuid) RETURNS boolean LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE st jsonb; obj jsonb; ln jsonb;
BEGIN
 IF target_kind IN ('items','locations') AND EXISTS(SELECT 1 FROM v2_workflow_stock WHERE tenant_id=target_tenant
 AND ((target_kind='items' AND item_id=target_id) OR (target_kind='locations' AND location_id=target_id))
 AND (s>0 OR r>0 OR p>0 OR q>0 OR b>0)) THEN RETURN true; END IF;
 FOR st IN SELECT state FROM v2_workflow_state WHERE tenant_id=target_tenant LOOP
  FOR obj IN SELECT value FROM jsonb_array_elements(COALESCE(st->'receipts','[]') || COALESCE(st->'returns','[]')) LOOP
   -- Receipt closure only closes unreceived quantity; physical lot work remains.
   IF target_kind='partners' AND obj->>'supplier_id'=target_id::text AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(COALESCE(obj->'lots','[]')) lot
    WHERE COALESCE((lot->>'pending')::bigint,0)>0 OR COALESCE((lot->>'normal')::bigint,0)>0 OR COALESCE((lot->>'hold')::bigint,0)>0
   ) THEN RETURN true; END IF;
   IF NOT COALESCE((obj->>'closed')::boolean,false) THEN
    IF target_kind='partners' AND obj->>'supplier_id'=target_id::text AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(obj->'lines','[]')) l WHERE COALESCE((l->>'quantity')::bigint,0)>COALESCE((l->>'received')::bigint,0)+COALESCE((l->>'cancelled')::bigint,0)) THEN RETURN true; END IF;
    FOR ln IN SELECT value FROM jsonb_array_elements(COALESCE(obj->'lines','[]')) LOOP
     IF target_kind='items' AND ln->>'item_id'=target_id::text AND COALESCE((ln->>'quantity')::bigint,0)>COALESCE((ln->>'received')::bigint,0)+COALESCE((ln->>'cancelled')::bigint,0) THEN RETURN true; END IF;
    END LOOP;
   END IF;
  END LOOP;
  FOR obj IN SELECT value FROM jsonb_array_elements(COALESCE(st->'orders','[]')) LOOP
   FOR ln IN SELECT value FROM jsonb_array_elements(COALESCE(obj->'lines','[]')) LOOP
    IF COALESCE((ln->>'quantity')::bigint,0)>COALESCE((ln->>'shipped')::bigint,0)+COALESCE((ln->>'cancelled')::bigint,0) THEN
     IF (target_kind='items' AND ln->>'item_id'=target_id::text)
      OR (target_kind='partners' AND obj->'delivery'->>'partner_id'=target_id::text)
      OR (target_kind='destinations' AND (obj->'delivery'->>'destination_id'=target_id::text OR obj->'delivery'->>'delivery_destination_id'=target_id::text)) THEN RETURN true; END IF;
    END IF;
   END LOOP;
  END LOOP;
  FOR obj IN SELECT value FROM jsonb_array_elements(COALESCE(st->'counts','[]')) LOOP
   IF obj->>'status' IN ('counting','submitted') AND (target_kind='locations' AND obj->>'location_id'=target_id::text OR target_kind='items' AND (
    (obj->'baseline')::text LIKE '%' || target_id::text || '%'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(obj->'lines')='array' THEN obj->'lines' ELSE '[]'::jsonb END) line WHERE line->>'item_id'=target_id::text)
   )) THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END $$;$migration_sql$;
 INSERT INTO public.pgmigrations(name,run_on) VALUES('1792368000021_v2-supplier-pending-lots',CURRENT_TIMESTAMP);
 END IF;
END $upgrade$;

GRANT SELECT,INSERT,UPDATE,DELETE ON public."rateLimit" TO wms_app;
GRANT UPDATE(idle_lock_minutes) ON public.tenants TO wms_app;
GRANT INSERT(user_id,tenant_id,role,status),UPDATE(role,status,updated_at) ON public.memberships TO wms_app;
GRANT SELECT,INSERT,UPDATE ON public.delivery_destinations TO wms_app;
REVOKE ALL ON FUNCTION public.master_workflow_in_use(uuid,text,uuid),public.master_workflow_in_use_scoped(uuid,text,uuid),public.master_active_guard(),public.master_barcode_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.master_workflow_in_use(uuid,text,uuid) TO wms_app;

REVOKE ALL ON public.v2_workflow_state,public.v2_workflow_state_header,public.v2_workflow_stock,public.v2_workflow_objects,public.v2_identity_links,public.v2_machine_keys,public.business_partners,public.master_barcodes,public.master_csv_previews,public.v2_integration_limits,public.v2_integration_entities,public.v2_integration_events FROM PUBLIC,wms_app;
GRANT SELECT,INSERT,UPDATE ON public.v2_workflow_state,public.v2_workflow_state_header,public.v2_workflow_stock,public.v2_workflow_objects,public.v2_identity_links,public.v2_machine_keys,public.business_partners,public.master_barcodes,public.master_csv_previews,public.v2_integration_limits,public.v2_integration_entities,public.v2_integration_events TO wms_app;

REVOKE ALL ON public.v2_workflow_requests,public.v2_workflow_performances,public.v2_workflow_receivings,public.v2_workflow_ledger,public.v2_identity_audit,public.master_csv_applies,public.master_csv_applied_rows,public.v2_cutovers,public.api_request_metrics,public.v2_opening_imports FROM PUBLIC,wms_app;
GRANT SELECT,INSERT ON public.v2_workflow_requests,public.v2_workflow_performances,public.v2_workflow_receivings,public.v2_workflow_ledger,public.v2_identity_audit,public.master_csv_applies,public.master_csv_applied_rows,public.v2_cutovers,public.api_request_metrics,public.v2_opening_imports TO wms_app;

REVOKE ALL ON public.v2_warehouse_grants,public.v2_machine_warehouses,public.v2_workflow_object_state FROM PUBLIC,wms_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.v2_warehouse_grants,public.v2_machine_warehouses,public.v2_workflow_object_state TO wms_app;

GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO wms_app;
-- A separate empty workspace lets existing users try v2 without converting their legacy warehouse.
DO $workspace$ DECLARE company uuid; wh uuid; partner uuid; item uuid; loc record; previous_tenant text:=current_setting('app.tenant_id',true); BEGIN
 FOR company IN SELECT t.id FROM tenants t WHERE t.active AND EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=t.id AND m.role='admin' AND m.status='active') LOOP
  PERFORM set_config('app.tenant_id',company::text,true);
  INSERT INTO warehouses(tenant_id,code,name) VALUES(company,'OPS-V2-TEST','운영테스트 창고') ON CONFLICT(tenant_id,code) DO NOTHING;
  SELECT id INTO STRICT wh FROM warehouses WHERE tenant_id=company AND code='OPS-V2-TEST' AND active;
  INSERT INTO locations(tenant_id,warehouse_id,code,name,kind)
   SELECT company,wh,code,name,kind FROM (VALUES ('RECV','수령·검수대기','RECEIVING'),('STORE','정상 보관','STORAGE'),('PICK','피킹·포장대기','STAGING'),('SHIP','출하대기','SHIPPING'),('HOLD','품질·과납보류','HOLD')) v(code,name,kind)
   ON CONFLICT(tenant_id,warehouse_id,code) DO NOTHING;
  IF (SELECT count(*) FROM locations WHERE tenant_id=company AND warehouse_id=wh AND active AND (code,kind) IN (('RECV','RECEIVING'),('STORE','STORAGE'),('PICK','STAGING'),('SHIP','SHIPPING'),('HOLD','HOLD')))<>5 THEN RAISE EXCEPTION 'Existing test locations need review'; END IF;
  INSERT INTO v2_warehouse_grants(tenant_id,user_id,warehouse_id) SELECT company,user_id,wh FROM memberships WHERE tenant_id=company AND status='active' ON CONFLICT DO NOTHING;
  INSERT INTO business_partners(tenant_id,code,name,supplier,customer) VALUES(company,'OPS-TEST-PARTNER','운영테스트 거래처',true,true) ON CONFLICT(tenant_id,code) DO NOTHING;
  SELECT id INTO STRICT partner FROM business_partners WHERE tenant_id=company AND code='OPS-TEST-PARTNER' AND active AND supplier AND customer;
  INSERT INTO delivery_destinations(tenant_id,partner_id,recipient_name,name,address_line1,external_code) VALUES(company,partner,'운영테스트 수령인','운영테스트 배송지','서울특별시 중구 세종대로 110','OPS-TEST-DESTINATION') ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM delivery_destinations WHERE tenant_id=company AND partner_id=partner AND external_code='OPS-TEST-DESTINATION' AND active) THEN RAISE EXCEPTION 'Existing test destination needs review'; END IF;
  INSERT INTO items(tenant_id,code,name) VALUES(company,'OPS-TEST-ITEM','운영테스트 품목') ON CONFLICT(tenant_id,code) DO NOTHING;
  SELECT id INTO STRICT item FROM items WHERE tenant_id=company AND code='OPS-TEST-ITEM' AND active;
  INSERT INTO master_barcodes(tenant_id,barcode,item_id,unit,quantity) VALUES(company,'OPS-TEST-ITEM-EA',item,'EA',1) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM master_barcodes WHERE tenant_id=company AND barcode='OPS-TEST-ITEM-EA' AND item_id=item AND unit='EA' AND quantity=1 AND active) THEN RAISE EXCEPTION 'Existing test item barcode needs review'; END IF;
  FOR loc IN SELECT id,code FROM locations WHERE tenant_id=company AND warehouse_id=wh LOOP
   INSERT INTO master_barcodes(tenant_id,barcode,location_id) VALUES(company,'OPS-V2-'||loc.code,loc.id) ON CONFLICT DO NOTHING;
  END LOOP;
 END LOOP;
 PERFORM set_config('app.tenant_id',COALESCE(previous_tenant,''),true);
END $workspace$;
RESET ROLE;
DO $check$ BEGIN
 IF (SELECT count(*) FROM public.pgmigrations)<>22
  OR to_regclass('public.v2_workflow_state_header') IS NULL
  OR to_regclass('public.v2_workflow_object_state') IS NULL
  OR NOT has_table_privilege('wms_app','public.v2_workflow_state','SELECT,INSERT,UPDATE')
  OR has_table_privilege('wms_app','public.v2_workflow_ledger','UPDATE')
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wms_app' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
  RAISE EXCEPTION 'Field operations schema/permissions incomplete';
 END IF;
END $check$;
COMMIT;
SELECT true AS field_operations_ready,(SELECT count(*) FROM public.pgmigrations) AS migrations_applied,'운영테스트 창고' AS test_warehouse;

