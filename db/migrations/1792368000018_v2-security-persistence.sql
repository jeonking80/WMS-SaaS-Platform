-- Up Migration
-- Explicit pg_temp last prevents temporary-table shadowing inside definer guards.
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
END IF; END $$;

-- Down Migration
-- Fail closed: dropping this guard would reintroduce hidden-warehouse bypasses.
DO $$ BEGIN RAISE EXCEPTION 'Security persistence migration requires a reviewed forward migration'; END $$;
