-- schema2-drift.sql — SCHEMA-2 (Wave 2 gate G3), Jobright clone (TASK_PLAN.md §4.0 SCHEMA-n, diff (b))
--
-- Generated 2026-10-10 (Prisma 7.10.0) with (read-only introspection of the clone DB):
--   npx prisma migrate diff --from-config-datasource \
--     --to-schema server/prisma/schema --script
-- Result: no DROP and no ALTER of an existing column; identical in content to
-- schema2-additive.sql, so the clone DB matched the pre-SCHEMA-2 schema (no drift).
-- Not applied. The owner confirms the push to the clone Neon branch.

-- AlterTable
ALTER TABLE "RAIngestQuery" ADD COLUMN     "runCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RAJob" ADD COLUMN     "lastSeenQueryId" TEXT,
ADD COLUMN     "lastSeenRun" INTEGER,
ADD COLUMN     "originalHost" TEXT;

-- AlterTable
ALTER TABLE "RAProfile" ADD COLUMN     "twFields" JSONB;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "inactivityNoticeSentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RAGrowthChecklist" (
    "userId" TEXT NOT NULL,
    "tailorAt" TIMESTAMP(3),
    "practiceAt" TIMESTAMP(3),
    "saveJobAt" TIMESTAMP(3),
    "rewardedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAGrowthChecklist_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "RACompany_nameNormalized_idx" ON "RACompany" USING GIN ("nameNormalized" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "RAJob_lastSeenQueryId_idx" ON "RAJob"("lastSeenQueryId");

-- AddForeignKey
ALTER TABLE "RAGrowthChecklist" ADD CONSTRAINT "RAGrowthChecklist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

