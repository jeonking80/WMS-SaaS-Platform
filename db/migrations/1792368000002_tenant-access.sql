-- Up Migration
CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name varchar(128) NOT NULL CHECK (length(btrim(name)) > 0),
  code varchar(64) NOT NULL CHECK (length(btrim(code)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
CREATE POLICY items_tenant_isolation ON items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Down Migration
DROP TABLE items;
