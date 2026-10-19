-- Up Migration
ALTER TABLE inventory_documents DROP CONSTRAINT inventory_documents_status_check;
ALTER TABLE inventory_documents ADD CONSTRAINT inventory_documents_status_check
  CHECK (status IN ('DRAFT', 'CANCELLED', 'POSTED', 'REVERSED'));
ALTER TABLE inventory_documents
  ADD COLUMN reversal_of_id uuid,
  ADD COLUMN reversed_at timestamptz,
  ADD CONSTRAINT inventory_documents_reversal_unique UNIQUE (tenant_id, reversal_of_id),
  ADD CONSTRAINT inventory_documents_reversal_fk FOREIGN KEY (tenant_id, reversal_of_id)
    REFERENCES inventory_documents(tenant_id, id),
  ADD CONSTRAINT inventory_documents_reversal_check
    CHECK (reversal_of_id IS NULL OR (reversal_of_id <> id AND status = 'POSTED'));

-- Down Migration
ALTER TABLE inventory_documents
  DROP CONSTRAINT inventory_documents_reversal_check,
  DROP CONSTRAINT inventory_documents_reversal_fk,
  DROP CONSTRAINT inventory_documents_reversal_unique,
  DROP COLUMN reversed_at,
  DROP COLUMN reversal_of_id;
ALTER TABLE inventory_documents DROP CONSTRAINT inventory_documents_status_check;
ALTER TABLE inventory_documents ADD CONSTRAINT inventory_documents_status_check
  CHECK (status IN ('DRAFT', 'CANCELLED', 'POSTED'));
