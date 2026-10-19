-- Up Migration
ALTER TABLE inventory_documents DROP CONSTRAINT inventory_documents_status_check;
ALTER TABLE inventory_documents ADD CONSTRAINT inventory_documents_status_check CHECK (status IN ('DRAFT', 'CANCELLED', 'POSTED'));
ALTER TABLE inventory_documents ADD COLUMN posted_at timestamptz;
CREATE TABLE stock_balances (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity bigint NOT NULL DEFAULT 0 CHECK (quantity BETWEEN 0 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, location_id, item_id),
  FOREIGN KEY (tenant_id, warehouse_id, location_id) REFERENCES locations(tenant_id, warehouse_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE TABLE stock_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity_delta bigint NOT NULL CHECK (quantity_delta <> 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, document_id, location_id, item_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES inventory_documents(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id, location_id) REFERENCES locations(tenant_id, warehouse_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE TABLE idempotency_requests (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key varchar(128) NOT NULL CHECK (length(btrim(key)) > 0),
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES "user"(id),
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, document_id) REFERENCES inventory_documents(tenant_id, id)
);
ALTER TABLE stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_balances_tenant_isolation ON stock_balances
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE stock_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_ledger_tenant_isolation ON stock_ledger
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE idempotency_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_requests_tenant_isolation ON idempotency_requests
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Down Migration
DROP TABLE audit_logs;
DROP TABLE idempotency_requests;
DROP TABLE stock_ledger;
DROP TABLE stock_balances;
ALTER TABLE inventory_documents DROP COLUMN posted_at;
ALTER TABLE inventory_documents DROP CONSTRAINT inventory_documents_status_check;
ALTER TABLE inventory_documents ADD CONSTRAINT inventory_documents_status_check CHECK (status IN ('DRAFT', 'CANCELLED'));
