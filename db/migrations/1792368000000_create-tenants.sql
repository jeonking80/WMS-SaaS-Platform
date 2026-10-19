-- Up Migration
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(128) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tenants_name_not_blank CHECK (length(btrim(name)) > 0)
);

COMMENT ON TABLE tenants IS 'Service tenant registry; no public application access in P0';

-- Down Migration
DROP TABLE tenants;
