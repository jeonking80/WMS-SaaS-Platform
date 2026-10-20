-- Existing wms_demo only. Add stable document numbers; preserve accounts, documents and stock.
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
  IF NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name='1792368000009_document-numbers') THEN
    ALTER TABLE inventory_documents ADD COLUMN document_no bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE inventory_documents ADD CONSTRAINT inventory_documents_document_no_unique UNIQUE (document_no);
CREATE FUNCTION preserve_document_no() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.document_no IS DISTINCT FROM OLD.document_no THEN
    RAISE EXCEPTION 'document_no is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_documents_document_no_immutable BEFORE UPDATE ON inventory_documents
FOR EACH ROW EXECUTE FUNCTION preserve_document_no();
    INSERT INTO pgmigrations(name,run_on) VALUES('1792368000009_document-numbers',CURRENT_TIMESTAMP);
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
SELECT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000009_document-numbers') AS workflow_ready,
  EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.inventory_documents'::regclass
    AND tgname='inventory_documents_document_no_immutable' AND tgenabled='O') AS document_numbers_ready;
