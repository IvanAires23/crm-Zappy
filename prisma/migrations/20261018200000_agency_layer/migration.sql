-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "disabledPermissions" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "agencyRole" TEXT;

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "actingTenantId" TEXT;

-- CreateTable
CREATE TABLE "agency_user_access" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_user_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agency_user_access_tenantId_idx" ON "agency_user_access"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "agency_user_access_userId_tenantId_key" ON "agency_user_access"("userId", "tenantId");

-- AddForeignKey
ALTER TABLE "agency_user_access" ADD CONSTRAINT "agency_user_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_user_access" ADD CONSTRAINT "agency_user_access_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Conta master: o admin ativo mais antigo (o dono que criou o sistema) vira
-- agency_admin e passa a enxergar todas as contas.
UPDATE "users" SET "agencyRole" = 'agency_admin'
WHERE "id" = (
  SELECT "id" FROM "users" WHERE "role" = 'admin' AND "active" = true ORDER BY "createdAt" ASC LIMIT 1
);
