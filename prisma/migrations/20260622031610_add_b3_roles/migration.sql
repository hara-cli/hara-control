-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "personId" TEXT,
ADD COLUMN     "roleVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "EnrollCode" ADD COLUMN     "personId" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "policy" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "owns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rejects" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model" TEXT,
    "allowTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "denyTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "system" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "policy" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonTeam" (
    "personId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,

    CONSTRAINT "PersonTeam_pkey" PRIMARY KEY ("personId","teamId")
);

-- CreateTable
CREATE TABLE "DigitalEmployee" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "personId" TEXT,
    "teamId" TEXT,
    "name" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "policy" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigitalEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Role_orgId_idx" ON "Role"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_orgId_key_key" ON "Role"("orgId", "key");

-- CreateIndex
CREATE INDEX "Team_orgId_idx" ON "Team"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_orgId_name_key" ON "Team"("orgId", "name");

-- CreateIndex
CREATE INDEX "Person_orgId_idx" ON "Person"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Person_orgId_email_key" ON "Person"("orgId", "email");

-- CreateIndex
CREATE INDEX "DigitalEmployee_orgId_idx" ON "DigitalEmployee"("orgId");

-- CreateIndex
CREATE INDEX "DigitalEmployee_roleId_idx" ON "DigitalEmployee"("roleId");

-- CreateIndex
CREATE INDEX "DigitalEmployee_personId_idx" ON "DigitalEmployee"("personId");

-- CreateIndex
CREATE INDEX "DigitalEmployee_teamId_idx" ON "DigitalEmployee"("teamId");

-- CreateIndex
CREATE INDEX "Device_personId_idx" ON "Device"("personId");

-- AddForeignKey
ALTER TABLE "EnrollCode" ADD CONSTRAINT "EnrollCode_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonTeam" ADD CONSTRAINT "PersonTeam_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonTeam" ADD CONSTRAINT "PersonTeam_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalEmployee" ADD CONSTRAINT "DigitalEmployee_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalEmployee" ADD CONSTRAINT "DigitalEmployee_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalEmployee" ADD CONSTRAINT "DigitalEmployee_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalEmployee" ADD CONSTRAINT "DigitalEmployee_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
