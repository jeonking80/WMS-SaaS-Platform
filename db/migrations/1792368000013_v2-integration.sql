-- Up Migration
CREATE TABLE v2_integration_limits (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  rate_per_minute integer NOT NULL DEFAULT 600 CHECK (rate_per_minute BETWEEN 1 AND 60000),
  queue_limit integer NOT NULL DEFAULT 10000 CHECK (queue_limit BETWEEN 1 AND 1000000),
  window_start timestamptz NOT NULL DEFAULT now(),
  window_count integer NOT NULL DEFAULT 0 CHECK (window_count >= 0)
);
CREATE TABLE v2_integration_entities (
  tenant_id uuid NOT NULL REFERENCES tenants(id), source_system varchar(100) NOT NULL,
  entity_kind varchar(30) NOT NULL, external_entity_id varchar(160) NOT NULL,
  warehouse_id uuid NOT NULL, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  object_id uuid, PRIMARY KEY(tenant_id,source_system,entity_kind,external_entity_id),
  FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TABLE v2_integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sequence bigserial UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id), source_system varchar(100) NOT NULL,
  warehouse_id uuid NOT NULL, actor_id text NOT NULL, source_key_id uuid NOT NULL, event_id uuid NOT NULL, entity_kind varchar(30) NOT NULL,
  external_entity_id varchar(160) NOT NULL, revision integer NOT NULL CHECK(revision > 0),
  event_type varchar(60) NOT NULL, schema_version varchar(8) NOT NULL CHECK(schema_version='2.0'),
  occurred_at timestamptz NOT NULL, correlation_id varchar(160) NOT NULL, run_id varchar(160),
  request_hash char(64) NOT NULL, revision_hash char(64) NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  status varchar(30) NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted','dependency_wait','applied','business_rejected','retry_wait','quarantined')),
  reason varchar(100), result jsonb, attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(), received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  UNIQUE(tenant_id,source_system,event_id),
  UNIQUE(tenant_id,source_system,entity_kind,external_entity_id,revision),
  FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE INDEX v2_integration_pending ON v2_integration_events(tenant_id,warehouse_id,next_attempt_at,sequence) WHERE status IN ('accepted','dependency_wait','retry_wait');
CREATE INDEX v2_integration_poll ON v2_integration_events(tenant_id,source_system,warehouse_id,sequence);
ALTER TABLE v2_integration_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE v2_integration_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY v2_integration_limits_tenant ON v2_integration_limits USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE v2_integration_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE v2_integration_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY v2_integration_entities_tenant ON v2_integration_entities USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE v2_integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE v2_integration_events FORCE ROW LEVEL SECURITY;
CREATE POLICY v2_integration_events_tenant ON v2_integration_events USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
-- The content and deduplication identifiers survive result/log retention.
CREATE FUNCTION v2_integration_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'integration identifiers are retained' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','reason','result','attempts','next_attempt_at','processed_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','reason','result','attempts','next_attempt_at','processed_at']) THEN
    RAISE EXCEPTION 'integration event content is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER v2_integration_event_immutable BEFORE UPDATE OR DELETE ON v2_integration_events FOR EACH ROW EXECUTE FUNCTION v2_integration_event_immutable();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wms_app') THEN
  GRANT SELECT,INSERT,UPDATE ON v2_integration_limits,v2_integration_entities,v2_integration_events TO wms_app;
  GRANT USAGE,SELECT ON SEQUENCE v2_integration_events_sequence_seq TO wms_app;
END IF; END $$;
-- Down Migration
DROP TABLE v2_integration_events;
DROP FUNCTION v2_integration_event_immutable();
DROP TABLE v2_integration_entities;
DROP TABLE v2_integration_limits;
