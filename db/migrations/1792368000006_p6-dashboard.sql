-- Up Migration
ALTER TABLE items ADD COLUMN min_stock bigint NOT NULL DEFAULT 0 CHECK (min_stock BETWEEN 0 AND 1000000000);
CREATE INDEX inventory_documents_tenant_created_idx ON inventory_documents (tenant_id, created_at DESC, id DESC);
CREATE INDEX inventory_documents_tenant_posted_idx ON inventory_documents (tenant_id, posted_at DESC);
CREATE INDEX inventory_documents_tenant_reversed_idx ON inventory_documents (tenant_id, reversed_at DESC) WHERE reversed_at IS NOT NULL;
CREATE INDEX stock_ledger_tenant_created_idx ON stock_ledger (tenant_id, created_at DESC, id DESC);
CREATE INDEX stock_balances_tenant_item_idx ON stock_balances (tenant_id, item_id);
CREATE INDEX audit_logs_tenant_created_idx ON audit_logs (tenant_id, created_at DESC, id DESC);
CREATE INDEX inventory_document_lines_tenant_item_document_idx ON inventory_document_lines (tenant_id, item_id, document_id);

-- Down Migration
DROP INDEX inventory_document_lines_tenant_item_document_idx;
DROP INDEX audit_logs_tenant_created_idx;
DROP INDEX stock_balances_tenant_item_idx;
DROP INDEX stock_ledger_tenant_created_idx;
DROP INDEX inventory_documents_tenant_reversed_idx;
DROP INDEX inventory_documents_tenant_posted_idx;
DROP INDEX inventory_documents_tenant_created_idx;
ALTER TABLE items DROP COLUMN min_stock;
