-- Existing wms_demo only. Add delivery fields; preserve all accounts, stock and documents.
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
  IF NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name='1792368000007_outbound-delivery') THEN
    ALTER TABLE inventory_documents
  ADD COLUMN recipient_name varchar(128),
  ADD COLUMN delivery_address varchar(500),
  ADD CONSTRAINT inventory_documents_delivery_check CHECK (
    (recipient_name IS NULL AND delivery_address IS NULL)
    OR (kind = 'OUTBOUND'
      AND recipient_name IS NOT NULL AND delivery_address IS NOT NULL
      AND recipient_name = btrim(recipient_name) AND length(recipient_name) > 0
      AND delivery_address = btrim(delivery_address) AND length(delivery_address) > 0)
  );
    INSERT INTO pgmigrations(name,run_on) VALUES('1792368000007_outbound-delivery',CURRENT_TIMESTAMP);
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
      AND table_name='inventory_documents' AND column_name IN ('recipient_name','delivery_address')) <> 2
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.inventory_documents'::regclass
      AND conname='inventory_documents_delivery_check') THEN
    RAISE EXCEPTION 'Delivery schema is incomplete';
  END IF;
END $upgrade$;
COMMIT;
SELECT EXISTS(SELECT 1 FROM public.pgmigrations WHERE name='1792368000007_outbound-delivery') AS delivery_ready,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
    AND table_name='inventory_documents' AND column_name IN ('recipient_name','delivery_address')) AS delivery_columns;
