-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- AlterTable
ALTER TABLE "AssetVersion" ADD COLUMN     "embedDim" INTEGER,
ADD COLUMN     "embedModel" TEXT,
ADD COLUMN     "embedding" vector;
