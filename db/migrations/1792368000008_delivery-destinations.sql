-- Up Migration
CREATE TABLE delivery_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  recipient_name varchar(128) NOT NULL CHECK (recipient_name = btrim(recipient_name) AND length(recipient_name) > 0),
  name varchar(128) NOT NULL CHECK (name = btrim(name) AND length(name) > 0),
  postal_code varchar(5) NOT NULL DEFAULT '' CHECK (postal_code = '' OR postal_code ~ '^[0-9]{5}$'),
  address_line1 varchar(300) NOT NULL CHECK (address_line1 = btrim(address_line1) AND length(address_line1) > 0),
  address_line2 varchar(160) NOT NULL DEFAULT '' CHECK (address_line2 = btrim(address_line2)),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, recipient_name, name)
);
ALTER TABLE delivery_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_destinations FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_destinations_tenant_isolation ON delivery_destinations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Reuse valid historical addresses without modifying document snapshots or references.
-- Set each tenant context explicitly because this table and documents FORCE RLS.
DO $$
DECLARE
  tenant record;
  previous_tenant text := current_setting('app.tenant_id', true);
BEGIN
  FOR tenant IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tenant.id::text, true);
    INSERT INTO delivery_destinations (tenant_id, recipient_name, name, address_line1)
    SELECT tenant.id, recipient_name,
      '기존 배송지 ' || row_number() OVER (PARTITION BY recipient_name ORDER BY delivery_address),
      delivery_address
    FROM (
      SELECT DISTINCT recipient_name, delivery_address FROM inventory_documents
      WHERE tenant_id = tenant.id AND kind = 'OUTBOUND'
        AND recipient_name IS NOT NULL AND recipient_name = btrim(recipient_name) AND length(recipient_name) > 0
        AND delivery_address IS NOT NULL AND delivery_address = btrim(delivery_address)
        AND length(delivery_address) BETWEEN 1 AND 300
    ) historical;
  END LOOP;
  PERFORM set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
END $$;
ALTER TABLE inventory_documents
  ADD COLUMN delivery_destination_id uuid,
  ADD CONSTRAINT inventory_documents_delivery_destination_fk FOREIGN KEY (tenant_id, delivery_destination_id) REFERENCES delivery_destinations (tenant_id, id),
  ADD CONSTRAINT inventory_documents_delivery_destination_check CHECK (delivery_destination_id IS NULL OR kind = 'OUTBOUND');

-- Down Migration
ALTER TABLE inventory_documents DROP CONSTRAINT inventory_documents_delivery_destination_check,
  DROP CONSTRAINT inventory_documents_delivery_destination_fk, DROP COLUMN delivery_destination_id;
DROP TABLE delivery_destinations;
