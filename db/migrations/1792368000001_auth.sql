-- Up Migration
-- Better Auth 1.7.11 default schema; roles belong to memberships, not auth users.
CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "session" (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE
);
CREATE INDEX session_user_id_idx ON "session" ("userId");
CREATE TABLE account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("providerId", "accountId")
);
CREATE INDEX account_user_id_idx ON account ("userId");
CREATE TABLE verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX verification_identifier_idx ON verification (identifier);
CREATE TABLE memberships (
  user_id text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  role text NOT NULL CHECK (role IN ('admin', 'worker', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX memberships_tenant_id_idx ON memberships (tenant_id);
COMMENT ON TABLE memberships IS 'One trusted tenant assignment per user; never accepted from client input';

-- Down Migration
DROP TABLE memberships;
DROP TABLE verification;
DROP TABLE account;
DROP TABLE "session";
DROP TABLE "user";
