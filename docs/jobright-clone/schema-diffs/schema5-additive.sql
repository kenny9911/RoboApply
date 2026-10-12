-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tokensValidAfter" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RAReferralSignal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "ipHash" TEXT,
    "uaHash" TEXT,
    "deviceHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAReferralSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAJobReview" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "by" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedRules" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "RAJobReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RATwoFactor" (
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "secretSealed" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "lastUsedStep" INTEGER,
    "recoveryCodeHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recoveryCodesGeneratedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RATwoFactor_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RAStudentVerification" (
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "schoolEmailHash" TEXT NOT NULL,
    "schoolDomain" TEXT NOT NULL,
    "pendingEmailHash" TEXT,
    "pendingDomain" TEXT,
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "codeAttempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAStudentVerification_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RAAdminAuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAAdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RAReferralSignal_userId_createdAt_idx" ON "RAReferralSignal"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RAReferralSignal_createdAt_idx" ON "RAReferralSignal"("createdAt");

-- CreateIndex
CREATE INDEX "RAJobReview_jobId_at_idx" ON "RAJobReview"("jobId", "at" DESC);

-- CreateIndex
CREATE INDEX "RAStudentVerification_schoolEmailHash_idx" ON "RAStudentVerification"("schoolEmailHash");

-- CreateIndex
CREATE INDEX "RAAdminAuditLog_subjectUserId_createdAt_idx" ON "RAAdminAuditLog"("subjectUserId", "createdAt");

-- CreateIndex
CREATE INDEX "RAAdminAuditLog_eventType_createdAt_idx" ON "RAAdminAuditLog"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "RAJobInteraction_kind_createdAt_idx" ON "RAJobInteraction"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "RAReferral_brand_status_idx" ON "RAReferral"("brand", "status");

-- AddForeignKey
ALTER TABLE "RAReferralSignal" ADD CONSTRAINT "RAReferralSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAJobReview" ADD CONSTRAINT "RAJobReview_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RAJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RATwoFactor" ADD CONSTRAINT "RATwoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAStudentVerification" ADD CONSTRAINT "RAStudentVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

