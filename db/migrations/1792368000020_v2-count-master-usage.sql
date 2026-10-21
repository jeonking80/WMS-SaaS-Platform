-- Up Migration
-- Counted items can be newly discovered and absent from the frozen baseline.
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
END $$;

-- Down Migration
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
   IF obj->>'status' IN ('counting','submitted') AND (target_kind='locations' AND obj->>'location_id'=target_id::text OR target_kind='items' AND (obj->'baseline')::text LIKE '%' || target_id::text || '%') THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END $$;
