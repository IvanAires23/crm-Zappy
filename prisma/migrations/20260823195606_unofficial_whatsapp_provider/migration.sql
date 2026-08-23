-- AlterTable
ALTER TABLE "tenant_whatsapp_accounts" ADD COLUMN     "baileysAuthState" TEXT,
ADD COLUMN     "baileysStatus" TEXT,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'cloud_api',
ALTER COLUMN "wabaId" DROP NOT NULL,
ALTER COLUMN "accessTokenEncrypted" DROP NOT NULL;
