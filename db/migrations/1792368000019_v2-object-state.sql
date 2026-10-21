-- Up Migration
-- Header locks remain the transaction boundary; format 2 stores every ordered array
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
END IF; END $$;

-- Down Migration
-- Reconstitute every retained body before removing normalized storage.
LOCK TABLE v2_workflow_state_header IN ACCESS EXCLUSIVE MODE;
ALTER TABLE v2_workflow_state_header NO FORCE ROW LEVEL SECURITY;
ALTER TABLE v2_workflow_object_state NO FORCE ROW LEVEL SECURITY;
UPDATE v2_workflow_state_header h SET state=v2_workflow_full_state(h.tenant_id,h.warehouse_id,h.state);
DROP VIEW v2_workflow_state;
DROP FUNCTION v2_workflow_legacy_state_write();
DROP FUNCTION v2_workflow_full_state(uuid,uuid,jsonb);
DROP FUNCTION v2_workflow_state_metadata(jsonb);
DROP TABLE v2_workflow_object_state;
ALTER TABLE v2_workflow_state_header FORCE ROW LEVEL SECURITY;
ALTER TABLE v2_workflow_state_header DROP COLUMN storage_format;
ALTER TABLE v2_workflow_state_header RENAME TO v2_workflow_state;

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
