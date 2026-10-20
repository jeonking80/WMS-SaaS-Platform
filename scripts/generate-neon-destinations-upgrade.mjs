/** Add a reusable address book to an existing demo DB without resetting data. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function renderDestinationsUpgrade() {
  const name = '1792368000008_delivery-destinations';
  const source = await readFile(new URL('../db/migrations/' + name + '.sql', import.meta.url), 'utf8');
  const up = source.split('-- Down Migration')[0].replace('-- Up Migration', '').trim();
  return `-- Existing wms_demo only. Add reusable delivery destinations; preserve accounts and stock.
BEGIN;
DO $guard$ BEGIN
  IF current_database() <> 'wms_demo' THEN RAISE EXCEPTION 'Select wms_demo database'; END IF;
END $guard$;
SET LOCAL ROLE wms_migrator;
SET LOCAL search_path = public;
SELECT pg_advisory_xact_lock(hashtext('wms-delivery-destinations-upgrade'));
DO $upgrade$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name='1792368000007_outbound-delivery') THEN
    RAISE EXCEPTION 'Previous outbound delivery migration is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name='${name}') THEN
    ${up}
    INSERT INTO pgmigrations(name,run_on) VALUES('${name}',CURRENT_TIMESTAMP);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.delivery_destinations'::regclass
      AND relrowsecurity AND relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.inventory_documents'::regclass
      AND conname='inventory_documents_delivery_destination_fk')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='inventory_documents' AND column_name='delivery_destination_id') THEN
    RAISE EXCEPTION 'Delivery destination schema is incomplete';
  END IF;
END $upgrade$;
REVOKE ALL ON TABLE public.delivery_destinations FROM PUBLIC, wms_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.delivery_destinations TO wms_app;
COMMIT;
SELECT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='${name}') AS address_book_ready,
  EXISTS(SELECT 1 FROM pg_class WHERE oid='public.delivery_destinations'::regclass
    AND relrowsecurity AND relforcerowsecurity) AS tenant_isolation_ready;
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../deploy/neon-delivery-destinations.sql', import.meta.url), await renderDestinationsUpgrade());
  console.log('Generated reusable destination SQL (no credentials).');
}
