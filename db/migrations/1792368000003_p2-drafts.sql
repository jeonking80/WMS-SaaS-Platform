-- Up Migration
CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code varchar(64) NOT NULL CHECK (length(btrim(code)) > 0),
  name varchar(128) NOT NULL CHECK (length(btrim(name)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  warehouse_id uuid NOT NULL,
  code varchar(64) NOT NULL CHECK (length(btrim(code)) > 0),
  name varchar(128) NOT NULL CHECK (length(btrim(name)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, warehouse_id, code),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, warehouse_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id)
);
CREATE TABLE inventory_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind varchar(16) NOT NULL CHECK (kind IN ('INBOUND', 'OUTBOUND', 'TRANSFER')),
  status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CANCELLED')),
  warehouse_id uuid NOT NULL,
  source_location_id uuid,
  destination_location_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id, source_location_id) REFERENCES locations(tenant_id, warehouse_id, id),
  FOREIGN KEY (tenant_id, warehouse_id, destination_location_id) REFERENCES locations(tenant_id, warehouse_id, id),
  CHECK (
    (kind = 'INBOUND' AND source_location_id IS NULL AND destination_location_id IS NOT NULL) OR
    (kind = 'OUTBOUND' AND source_location_id IS NOT NULL AND destination_location_id IS NULL) OR
    (kind = 'TRANSFER' AND source_location_id IS NOT NULL AND destination_location_id IS NOT NULL AND source_location_id <> destination_location_id)
  )
);
CREATE TABLE inventory_document_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000000000),
  UNIQUE (tenant_id, document_id, item_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES inventory_documents(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouses_tenant_isolation ON warehouses
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
CREATE POLICY locations_tenant_isolation ON locations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE inventory_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_documents_tenant_isolation ON inventory_documents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE inventory_document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_document_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_document_lines_tenant_isolation ON inventory_document_lines
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Down Migration
DROP TABLE inventory_document_lines;
DROP TABLE inventory_documents;
DROP TABLE locations;
DROP TABLE warehouses;
