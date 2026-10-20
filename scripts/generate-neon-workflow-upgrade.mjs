/** Stable business document numbers for an existing WMS demo database. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function renderWorkflowUpgrade() {
  const name = '1792368000009_document-numbers';
  const source = await readFile(new URL('../db/migrations/' + name + '.sql', import.meta.url), 'utf8');
  const up = source.split('-- Down Migration')[0].replace('-- Up Migration', '').trim();
  return `-- Existing wms_demo only. Add stable document numbers; preserve accounts, documents and stock.
BEGIN;
DO $guard$ BEGIN
  IF current_database() <> 'wms_demo' THEN RAISE EXCEPTION 'Select wms_demo database'; END IF;
END $guard$;
SET LOCAL ROLE wms_migrator;
SET LOCAL search_path = public;
SELECT pg_advisory_xact_lock(hashtext('wms-document-workflow-upgrade'));
DO $upgrade$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name='1792368000008_delivery-destinations') THEN
    RAISE EXCEPTION 'Previous address book migration is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name='${name}') THEN
    ${up}
    INSERT INTO pgmigrations(name,run_on) VALUES('${name}',CURRENT_TIMESTAMP);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='inventory_documents' AND column_name='document_no' AND is_identity='YES' AND is_nullable='NO')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.inventory_documents'::regclass
      AND conname='inventory_documents_document_no_unique')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.inventory_documents'::regclass
      AND tgname='inventory_documents_document_no_immutable' AND tgenabled='O') THEN
    RAISE EXCEPTION 'Document number schema is incomplete';
  END IF;
END $upgrade$;
COMMIT;
SELECT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='${name}') AS workflow_ready,
  EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.inventory_documents'::regclass
    AND tgname='inventory_documents_document_no_immutable' AND tgenabled='O') AS document_numbers_ready;
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../deploy/neon-workflow.sql', import.meta.url), await renderWorkflowUpgrade());
  console.log('Generated document workflow upgrade SQL (no credentials).');
}
