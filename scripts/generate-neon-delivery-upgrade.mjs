/** Additive SQL Editor upgrade for existing demo databases, without resetting data. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function renderDeliveryUpgrade() {
  const name='1792368000007_outbound-delivery';
  const source=await readFile(new URL('../db/migrations/'+name+'.sql',import.meta.url),'utf8');
  const up=source.split('-- Down Migration')[0].replace('-- Up Migration','').trim();
  return `-- Existing wms_demo only. Add delivery fields; preserve all accounts, stock and documents.
BEGIN;
DO $guard$ BEGIN
  IF current_database() <> 'wms_demo' THEN RAISE EXCEPTION 'Select wms_demo database'; END IF;
END $guard$;
SET LOCAL ROLE wms_migrator;
SET LOCAL search_path = public;
SELECT pg_advisory_xact_lock(hashtext('wms-outbound-delivery-upgrade'));
DO $upgrade$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name='1792368000006_p6-dashboard') THEN
    RAISE EXCEPTION 'Previous migrations are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name='${name}') THEN
    ${up}
    INSERT INTO pgmigrations(name,run_on) VALUES('${name}',CURRENT_TIMESTAMP);
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
      AND table_name='inventory_documents' AND column_name IN ('recipient_name','delivery_address')) <> 2
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.inventory_documents'::regclass
      AND conname='inventory_documents_delivery_check') THEN
    RAISE EXCEPTION 'Delivery schema is incomplete';
  END IF;
END $upgrade$;
COMMIT;
SELECT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='${name}') AS delivery_ready,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
    AND table_name='inventory_documents' AND column_name IN ('recipient_name','delivery_address')) AS delivery_columns;
`;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  await writeFile(new URL('../deploy/neon-outbound-delivery.sql',import.meta.url),await renderDeliveryUpgrade());
  console.log('Generated additive outbound delivery SQL (no credentials).');
}
