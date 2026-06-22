-- AlterEnum
ALTER TYPE "AssetKind" ADD VALUE 'KNOWLEDGE';

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "summary" TEXT;
