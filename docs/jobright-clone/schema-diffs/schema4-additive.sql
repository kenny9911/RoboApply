-- AlterTable
ALTER TABLE "AlipayOrder" ADD COLUMN     "termsVersion" TEXT;

-- AlterTable
ALTER TABLE "InterviewSession" ADD COLUMN     "brand" TEXT,
ADD COLUMN     "voiceProvider" TEXT;

-- AlterTable
ALTER TABLE "RAAgentSettings" ADD COLUMN     "filterOverrides" JSONB,
ADD COLUMN     "searchProfileId" TEXT;

-- AlterTable
ALTER TABLE "RAAgentKitEvent" ADD COLUMN     "kind" TEXT;

-- AlterTable
ALTER TABLE "RAContact" ADD COLUMN     "companyName" TEXT;

-- AlterTable
ALTER TABLE "RAAnnouncement" ADD COLUMN     "active" BOOLEAN,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "RAInterviewQuestion" ADD COLUMN     "jobId" TEXT;

-- AlterTable
ALTER TABLE "RAQuestionContribution" ADD COLUMN     "category" TEXT,
ADD COLUMN     "rejectReason" TEXT;

-- CreateTable
CREATE TABLE "RACnReferralCode" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "companyNormalized" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "programme" TEXT,
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rejectReason" TEXT,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "hiddenAt" TIMESTAMP(3),
    "moderatedAt" TIMESTAMP(3),
    "moderatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RACnReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACnReferralReport" (
    "id" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RACnReferralReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RACnReferralCode_brand_status_companyNormalized_idx" ON "RACnReferralCode"("brand", "status", "companyNormalized");

-- CreateIndex
CREATE INDEX "RACnReferralCode_userId_createdAt_idx" ON "RACnReferralCode"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RACnReferralReport_codeId_userId_key" ON "RACnReferralReport"("codeId", "userId");

-- CreateIndex
CREATE INDEX "InterviewSession_createdAt_idx" ON "InterviewSession"("createdAt");

-- CreateIndex
CREATE INDEX "RAAgentQueueItem_state_updatedAt_idx" ON "RAAgentQueueItem"("state", "updatedAt");

-- CreateIndex
CREATE INDEX "RAAgentQueueItem_addedVia_createdAt_idx" ON "RAAgentQueueItem"("addedVia", "createdAt");

-- CreateIndex
CREATE INDEX "RAMockSession_createdAt_idx" ON "RAMockSession"("createdAt");

-- CreateIndex
CREATE INDEX "RAOutreachDraft_userId_jobId_idx" ON "RAOutreachDraft"("userId", "jobId");

-- CreateIndex
CREATE INDEX "RAOutreachDraft_trackerEntryId_idx" ON "RAOutreachDraft"("trackerEntryId");

-- CreateIndex
CREATE INDEX "RAAnnouncement_brand_active_startsAt_endsAt_idx" ON "RAAnnouncement"("brand", "active", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "RAInterviewQuestion_jobId_status_idx" ON "RAInterviewQuestion"("jobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RAQuestionReport_questionId_userId_key" ON "RAQuestionReport"("questionId", "userId");

-- AddForeignKey
ALTER TABLE "RACnReferralCode" ADD CONSTRAINT "RACnReferralCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACnReferralReport" ADD CONSTRAINT "RACnReferralReport_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "RACnReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACnReferralReport" ADD CONSTRAINT "RACnReferralReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

