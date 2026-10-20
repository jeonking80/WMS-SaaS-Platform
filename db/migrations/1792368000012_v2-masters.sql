-- Up Migration
ALTER TABLE items ADD COLUMN search_terms text NOT NULL DEFAULT '',
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
END IF; END $$;
-- Down Migration
DROP TRIGGER destinations_delete_guard ON delivery_destinations;
DROP TRIGGER partners_delete_guard ON business_partners;
DROP TRIGGER locations_active_guard ON locations;
DROP TRIGGER items_active_guard ON items;
DROP FUNCTION master_active_guard();
DROP FUNCTION master_workflow_in_use(uuid,text,uuid);
DROP TABLE master_csv_applied_rows,master_csv_applies,master_csv_previews;
DROP TABLE master_barcodes;
DROP FUNCTION master_barcode_immutable();
DROP INDEX delivery_destinations_external_key;
ALTER TABLE delivery_destinations DROP CONSTRAINT delivery_destinations_partner_fk, DROP COLUMN partner_id, DROP COLUMN external_code, DROP COLUMN contact_name, DROP COLUMN phone;
DROP TABLE business_partners;
ALTER TABLE locations DROP COLUMN kind, DROP COLUMN priority, DROP COLUMN reservation_blocked;
ALTER TABLE items DROP COLUMN search_terms, DROP COLUMN base_unit;
