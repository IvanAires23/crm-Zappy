-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "buttons" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "footerText" TEXT,
ADD COLUMN     "headerText" TEXT,
ADD COLUMN     "metaTemplateId" TEXT,
ADD COLUMN     "rejectedReason" TEXT,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'waba',
ADD COLUMN     "variableMap" JSONB NOT NULL DEFAULT '[]';
