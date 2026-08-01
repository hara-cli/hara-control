ALTER TABLE "AssetVersion"
  ADD COLUMN "requiredCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "grantedCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "reviewedAt" TIMESTAMP(3);
