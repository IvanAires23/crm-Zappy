-- AlterTable
ALTER TABLE "users" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "conversations_tenantId_assignedUserId_idx" ON "conversations"("tenantId", "assignedUserId");
