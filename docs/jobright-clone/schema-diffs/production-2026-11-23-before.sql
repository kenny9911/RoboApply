-- DropIndex
DROP INDEX "RAJob_sourceBoard_externalId_idx";

-- CreateTable
CREATE TABLE "RAAliceThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "stage" TEXT NOT NULL DEFAULT 'intake',
    "resumeVariantId" TEXT,
    "resumeSkipped" BOOLEAN NOT NULL DEFAULT false,
    "brief" JSONB NOT NULL DEFAULT '{}',
    "topics" JSONB NOT NULL DEFAULT '{}',
    "pending" JSONB,
    "analysis" JSONB,
    "drafts" JSONB NOT NULL DEFAULT '[]',
    "revisions" JSONB NOT NULL DEFAULT '[]',
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "savedProfileId" TEXT,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "draftCount" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAAliceThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAAliceMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "agent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAAliceMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAJobProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "searchProfileId" TEXT,
    "previousFilters" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAJobProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RAAliceThread_userId_archivedAt_idx" ON "RAAliceThread"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "RAAliceMessage_threadId_createdAt_idx" ON "RAAliceMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "RAJobProfile_userId_status_updatedAt_idx" ON "RAJobProfile"("userId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "RAJob_sourceBoard_externalId_idx" ON "RAJob"("sourceBoard", "externalId" text_pattern_ops);

-- AddForeignKey
ALTER TABLE "RAAliceThread" ADD CONSTRAINT "RAAliceThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAAliceMessage" ADD CONSTRAINT "RAAliceMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "RAAliceThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAJobProfile" ADD CONSTRAINT "RAJobProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

