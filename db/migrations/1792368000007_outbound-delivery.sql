-- Up Migration
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

-- Down Migration
ALTER TABLE inventory_documents
  DROP CONSTRAINT inventory_documents_delivery_check,
  DROP COLUMN delivery_address,
  DROP COLUMN recipient_name;
