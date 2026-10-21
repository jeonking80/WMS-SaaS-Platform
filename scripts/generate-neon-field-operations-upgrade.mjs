/** Upgrade an existing Neon demo from the published MVP to the canonical v2 schema. */
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export async function renderFieldOperationsUpgrade() {
 const directory=new URL('../db/migrations/',import.meta.url);
 const files=(await readdir(directory)).filter(name=>/^\d+_[a-z0-9-]+\.sql$/.test(name)).sort();
 if(files.length!==22)throw new Error('Review the upgrade when the migration set changes.');
 const names=files.map(name=>name.slice(0,-4));
 const literals=names.map(name=>`'${name}'`).join(',');
 const parts=[`-- Generated from canonical migrations. Run the ENTIRE file in Neon SQL Editor, wms_demo.
-- Existing users, passwords, documents and inventory are retained. No seed/reset/cutover is performed.
BEGIN;
DO $target$ BEGIN
 IF current_database()<>'wms_demo' THEN RAISE EXCEPTION 'Select wms_demo'; END IF;
 IF to_regclass('public.pgmigrations') IS NULL THEN RAISE EXCEPTION 'Existing WMS database required'; END IF;
END $target$;
SET LOCAL ROLE wms_migrator;
SET LOCAL search_path=public;
SELECT pg_advisory_xact_lock(hashtext('wms-field-operations-upgrade'));
DO $history$ DECLARE existing text[]; expected text[]:=ARRAY[${literals}]; n integer; BEGIN
 SELECT array_agg(name::text ORDER BY name),count(*) INTO existing,n FROM public.pgmigrations;
 IF n<10 OR n>22 OR existing IS DISTINCT FROM expected[1:n] THEN
  RAISE EXCEPTION 'Expected a complete known migration prefix (10 through 22); nothing changed';
 END IF;
END $history$;`];
 for(const file of files.slice(10)) {
  const contents=await readFile(new URL(file,directory),'utf8');
  if(!contents.includes('-- Down Migration'))throw new Error('Unexpected migration format.');
  const up=contents.split('-- Down Migration')[0].replace('-- Up Migration','').trim();
  if(up.includes('$migration_sql$'))throw new Error('Unexpected migration delimiter.');
  parts.push(`-- ${file}\nDO $upgrade$ BEGIN\n IF NOT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='${file.slice(0,-4)}') THEN\n EXECUTE $migration_sql$${up}$migration_sql$;\n INSERT INTO public.pgmigrations(name,run_on) VALUES('${file.slice(0,-4)}',CURRENT_TIMESTAMP);\n END IF;\nEND $upgrade$;`);
 }
 // Same restricted application grants as db-bootstrap --grant, without changing any password or role.
 const mutable=['v2_workflow_state','v2_workflow_state_header','v2_workflow_stock','v2_workflow_objects','v2_identity_links','v2_machine_keys','business_partners','master_barcodes','master_csv_previews','v2_integration_limits','v2_integration_entities','v2_integration_events'];
 const appendOnly=['v2_workflow_requests','v2_workflow_performances','v2_workflow_receivings','v2_workflow_ledger','v2_identity_audit','master_csv_applies','master_csv_applied_rows','v2_cutovers','api_request_metrics','v2_opening_imports'];
 const grants=['v2_warehouse_grants','v2_machine_warehouses','v2_workflow_object_state'];
 parts.push(`GRANT SELECT,INSERT,UPDATE,DELETE ON public."rateLimit" TO wms_app;
GRANT UPDATE(idle_lock_minutes) ON public.tenants TO wms_app;
GRANT INSERT(user_id,tenant_id,role,status),UPDATE(role,status,updated_at) ON public.memberships TO wms_app;
GRANT SELECT,INSERT,UPDATE ON public.delivery_destinations TO wms_app;
REVOKE ALL ON FUNCTION public.master_workflow_in_use(uuid,text,uuid),public.master_workflow_in_use_scoped(uuid,text,uuid),public.master_active_guard(),public.master_barcode_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.master_workflow_in_use(uuid,text,uuid) TO wms_app;`);
 for(const [tables,permissions]of [[mutable,'SELECT,INSERT,UPDATE'],[appendOnly,'SELECT,INSERT'],[grants,'SELECT,INSERT,UPDATE,DELETE']]) {
  parts.push(`REVOKE ALL ON ${tables.map(t=>'public.'+t).join(',')} FROM PUBLIC,wms_app;\nGRANT ${permissions} ON ${tables.map(t=>'public.'+t).join(',')} TO wms_app;`);
 }
 parts.push(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO wms_app;
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
`);
 return parts.join('\n\n')+'\n';
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 await writeFile(new URL('../deploy/neon-field-operations.sql',import.meta.url),await renderFieldOperationsUpgrade());
 console.log('Generated deploy/neon-field-operations.sql (no credentials).');
}
