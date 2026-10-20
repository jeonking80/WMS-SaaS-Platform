-- Up Migration
-- Resolve live warehouse grants once per SQL statement, not once per ledger row.
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
END $$;

-- Down Migration
ALTER POLICY warehouse_scope ON warehouses USING(v2_can_access_warehouse(tenant_id,id)) WITH CHECK(v2_can_access_warehouse(tenant_id,id));
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['locations','inventory_documents','stock_balances','stock_ledger','v2_workflow_state','v2_workflow_stock','v2_workflow_objects','v2_workflow_performances','v2_workflow_receivings','v2_workflow_requests','v2_workflow_ledger','v2_cutovers','api_request_metrics'] LOOP
  EXECUTE format('ALTER POLICY warehouse_scope ON %I USING(v2_can_access_warehouse(tenant_id,warehouse_id)) WITH CHECK(v2_can_access_warehouse(tenant_id,warehouse_id))',tab);
 END LOOP;
END $$;
DROP FUNCTION v2_authorized_warehouse_ids();
