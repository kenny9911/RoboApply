-- DropIndex
DROP INDEX "RAJob_sourceBoard_externalId_idx";

-- CreateIndex
CREATE INDEX "RAJob_sourceBoard_externalId_idx" ON "RAJob"("sourceBoard", "externalId" text_pattern_ops);

