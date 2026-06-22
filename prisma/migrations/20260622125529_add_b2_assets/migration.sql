-- CreateEnum
CREATE TYPE "AssetScope" AS ENUM ('PERSONAL', 'TEAM', 'ORG', 'PUBLIC');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('SKILL', 'SNIPPET', 'PLAYBOOK', 'CONVENTION');

-- CreateEnum
CREATE TYPE "AssetLifecycle" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "TrustTier" AS ENUM ('ORG_VERIFIED', 'ORG', 'COMMUNITY', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "AssetOrigin" AS ENUM ('AUTHORED', 'PROMOTED', 'IMPORTED');

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "teamId" TEXT,
    "ownerDeviceId" TEXT,
    "scope" "AssetScope" NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "lifecycle" "AssetLifecycle" NOT NULL DEFAULT 'DRAFT',
    "trustTier" "TrustTier" NOT NULL DEFAULT 'ORG',
    "origin" "AssetOrigin" NOT NULL DEFAULT 'AUTHORED',
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "lang" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceUrl" TEXT,
    "promotedFromId" TEXT,
    "supersededById" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetVersion" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "redactions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByDeviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Asset_orgId_scope_lifecycle_idx" ON "Asset"("orgId", "scope", "lifecycle");

-- CreateIndex
CREATE INDEX "Asset_orgId_kind_idx" ON "Asset"("orgId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_orgId_scope_teamId_kind_slug_key" ON "Asset"("orgId", "scope", "teamId", "kind", "slug");

-- CreateIndex
CREATE INDEX "AssetVersion_assetId_createdAt_idx" ON "AssetVersion"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "AssetVersion_contentHash_idx" ON "AssetVersion"("contentHash");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetVersion" ADD CONSTRAINT "AssetVersion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
