-- AlterTable
ALTER TABLE "users" ADD COLUMN     "permissions" JSONB NOT NULL DEFAULT '{}',
ALTER COLUMN "role" SET DEFAULT 'user';


-- Papel "agent" foi renomeado para "user" (permissões configuráveis)
UPDATE "users" SET "role" = 'user' WHERE "role" = 'agent';
