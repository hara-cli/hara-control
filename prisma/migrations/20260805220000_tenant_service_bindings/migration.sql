-- Organization service connections are public descriptors. Any provisioning credential is kept
-- in the existing envelope-encrypted Secret table and referenced by a non-secret logical name.
CREATE TYPE "TenantServiceKind" AS ENUM (
  'MODEL_CONTROL',
  'DESK_TASKS',
  'COLLAB',
  'EXTENSION_CATALOG'
);

CREATE TYPE "TenantServiceMode" AS ENUM (
  'HARA_HOSTED',
  'CUSTOMER_HOSTED'
);

CREATE TYPE "TenantServiceRegion" AS ENUM (
  'CN',
  'GLOBAL'
);

CREATE TYPE "TenantServiceStatus" AS ENUM (
  'PENDING_VERIFICATION',
  'ACTIVE',
  'DEGRADED',
  'DISABLED'
);

CREATE TABLE "tenant_service_bindings" (
  "id" UUID NOT NULL,
  "orgId" TEXT NOT NULL,
  "service" "TenantServiceKind" NOT NULL,
  "mode" "TenantServiceMode" NOT NULL,
  "account_region" "TenantServiceRegion" NOT NULL,
  "api_origin" VARCHAR(2048) NOT NULL,
  "issuer" VARCHAR(2048),
  "jwks_uri" VARCHAR(2048),
  "audience" VARCHAR(160),
  "credential_ref" VARCHAR(256),
  "status" "TenantServiceStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  "capabilities_version" INTEGER NOT NULL DEFAULT 1,
  "config_version" INTEGER NOT NULL DEFAULT 1,
  "verified_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "tenant_service_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_service_bindings_orgId_service_key"
  ON "tenant_service_bindings"("orgId", "service");

CREATE INDEX "tenant_service_bindings_orgId_status_idx"
  ON "tenant_service_bindings"("orgId", "status");

ALTER TABLE "tenant_service_bindings"
  ADD CONSTRAINT "tenant_service_bindings_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
