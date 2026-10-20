-- Up Migration
CREATE TABLE v2_cutovers (
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
CREATE TRIGGER v2_legacy_ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_ledger FOR EACH ROW EXECUTE FUNCTION v2_block_legacy_inventory();

-- Down Migration
DROP TRIGGER v2_legacy_document_guard ON inventory_documents;
DROP TRIGGER v2_legacy_balance_guard ON stock_balances;
DROP TRIGGER v2_legacy_ledger_guard ON stock_ledger;
DROP FUNCTION v2_block_legacy_inventory();
DROP POLICY warehouse_scope ON inventory_document_lines;
DROP POLICY warehouse_scope ON audit_logs;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['warehouses','locations','inventory_documents','stock_balances','stock_ledger','v2_workflow_state','v2_workflow_stock','v2_workflow_objects','v2_workflow_performances','v2_workflow_receivings','v2_workflow_requests','v2_workflow_ledger','v2_cutovers'] LOOP
 EXECUTE format('DROP POLICY warehouse_scope ON %I',tab);
 END LOOP;
END $$;
DROP FUNCTION v2_can_access_warehouse(uuid,uuid);
DROP TABLE v2_cutovers;
