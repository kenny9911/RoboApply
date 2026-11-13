-- DropIndex
DROP INDEX "RAJob_sourceBoard_externalId_idx";

-- CreateTable
CREATE TABLE "RAVisitor" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "anonId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "landingPath" TEXT,
    "referrerHost" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'direct',
    "country" TEXT,
    "device" TEXT,
    "locale" TEXT,
    "pageViews" INTEGER NOT NULL DEFAULT 0,
    "visits" INTEGER NOT NULL DEFAULT 1,
    "lastVisitId" TEXT,
    "signupViewedAt" TIMESTAMP(3),
    "signupFrom" TEXT,
    "signupStartedAt" TIMESTAMP(3),
    "signupMethod" TEXT,
    "signedUpAt" TIMESTAMP(3),
    "knownUser" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT,

    CONSTRAINT "RAVisitor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RAVisitor_brand_firstSeenAt_idx" ON "RAVisitor"("brand", "firstSeenAt");

-- CreateIndex
CREATE INDEX "RAVisitor_brand_lastSeenAt_idx" ON "RAVisitor"("brand", "lastSeenAt");

-- CreateIndex
CREATE INDEX "RAVisitor_userId_idx" ON "RAVisitor"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RAVisitor_brand_anonId_key" ON "RAVisitor"("brand", "anonId");

-- CreateIndex
CREATE INDEX "RAJob_sourceBoard_externalId_idx" ON "RAJob"("sourceBoard", "externalId" text_pattern_ops);

-- AddForeignKey
ALTER TABLE "RAVisitor" ADD CONSTRAINT "RAVisitor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

