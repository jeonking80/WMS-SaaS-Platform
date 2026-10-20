-- Up Migration
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

-- Down Migration
DROP TRIGGER inventory_documents_document_no_immutable ON inventory_documents;
DROP FUNCTION preserve_document_no();
ALTER TABLE inventory_documents DROP COLUMN document_no;
