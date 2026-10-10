-- DropIndex
DROP INDEX "RAJob_sourceBoard_externalId_idx";

-- AlterTable
ALTER TABLE "RACareerSiteSource" ADD COLUMN     "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "discoveredFrom" TEXT,
ADD COLUMN     "failCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastChangeAt" TIMESTAMP(3),
ADD COLUMN     "nextSyncAt" TIMESTAMP(3),
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'admin';

-- AlterTable
ALTER TABLE "RAJob" ADD COLUMN     "atsPostingKey" TEXT,
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "lang" TEXT,
ADD COLUMN     "locationDistrict" TEXT,
ADD COLUMN     "requirements" JSONB,
ADD COLUMN     "searchDoc" TEXT,
ADD COLUMN     "searchTsv" tsvector,
ADD COLUMN     "skillIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sponsorshipSource" TEXT,
ADD COLUMN     "titleMatchScore" REAL,
ADD COLUMN     "workShift" TEXT;

-- AlterTable
ALTER TABLE "RAJobMatchScore" ADD COLUMN     "jobContentHash" TEXT,
ADD COLUMN     "rubricVersion" TEXT;

-- AlterTable
ALTER TABLE "RATailorSession" ADD COLUMN     "fitSnapshot" JSONB;

-- AlterTable
ALTER TABLE "RAUserAffinity" ADD COLUMN     "titleWeights" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "RABillingRefund" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "rail" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "chargeId" TEXT,
    "paymentIntentId" TEXT,
    "invoiceId" TEXT,
    "checkoutSessionId" TEXT,
    "alipayOrderId" TEXT,
    "planKey" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "full" BOOLEAN NOT NULL DEFAULT false,
    "entitlementReversed" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "actor" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RABillingRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RABillingConsentArchive" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "consentType" TEXT NOT NULL,
    "proseHash" TEXT,
    "proseVersion" TEXT,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "subscriptionEndedAt" TIMESTAMP(3),
    "stripeCustomerId" TEXT,
    "retainUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RABillingConsentArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RASponsorRegisterEntry" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "employerNameNormalized" TEXT NOT NULL,
    "employerName" TEXT NOT NULL,
    "period" TEXT NOT NULL DEFAULT '',
    "approvals" INTEGER,
    "denials" INTEGER,
    "town" TEXT,
    "rating" TEXT,
    "routes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceFile" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RASponsorRegisterEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAJobEmbedding" (
    "jobId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" halfvec(1024) NOT NULL,
    "embeddedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAJobEmbedding_pkey" PRIMARY KEY ("jobId")
);

-- CreateTable
CREATE TABLE "RAUserEmbedding" (
    "userId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "embedding" halfvec(1024) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAUserEmbedding_pkey" PRIMARY KEY ("userId","market","kind")
);

-- CreateTable
CREATE TABLE "RASkill" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'hard',
    "labelEn" TEXT NOT NULL,
    "labelZh" TEXT,
    "labelZhHant" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parentId" TEXT,
    "esco" TEXT,
    "onet" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unreviewed',
    "mentionCount" INTEGER NOT NULL DEFAULT 0,
    "embedding" halfvec(1024),
    "embeddingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RASkill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RABillingRefund_userId_createdAt_idx" ON "RABillingRefund"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RABillingRefund_invoiceId_idx" ON "RABillingRefund"("invoiceId");

-- CreateIndex
CREATE INDEX "RABillingRefund_alipayOrderId_idx" ON "RABillingRefund"("alipayOrderId");

-- CreateIndex
CREATE INDEX "RABillingRefund_kind_createdAt_idx" ON "RABillingRefund"("kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RABillingRefund_rail_externalRef_key" ON "RABillingRefund"("rail", "externalRef");

-- CreateIndex
CREATE INDEX "RABillingConsentArchive_retainUntil_idx" ON "RABillingConsentArchive"("retainUntil");

-- CreateIndex
CREATE INDEX "RABillingConsentArchive_emailHash_idx" ON "RABillingConsentArchive"("emailHash");

-- CreateIndex
CREATE INDEX "RABillingConsentArchive_userId_idx" ON "RABillingConsentArchive"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RABillingConsentArchive_userId_consentType_consentedAt_key" ON "RABillingConsentArchive"("userId", "consentType", "consentedAt");

-- CreateIndex
CREATE INDEX "RASponsorRegisterEntry_country_employerNameNormalized_idx" ON "RASponsorRegisterEntry"("country", "employerNameNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "RASponsorRegisterEntry_source_employerNameNormalized_period_key" ON "RASponsorRegisterEntry"("source", "employerNameNormalized", "period");

-- CreateIndex
CREATE INDEX "RAJobEmbedding_market_model_idx" ON "RAJobEmbedding"("market", "model");

-- CreateIndex
CREATE INDEX "RASkill_aliases_idx" ON "RASkill" USING GIN ("aliases");

-- CreateIndex
CREATE INDEX "RASkill_parentId_idx" ON "RASkill"("parentId");

-- CreateIndex
CREATE INDEX "RASkill_status_mentionCount_idx" ON "RASkill"("status", "mentionCount" DESC);

-- CreateIndex
CREATE INDEX "RACareerSiteSource_enabled_nextSyncAt_idx" ON "RACareerSiteSource"("enabled", "nextSyncAt");

-- CreateIndex
CREATE INDEX "RAJob_sourceBoard_externalId_idx" ON "RAJob"("sourceBoard", "externalId" text_pattern_ops);

-- CreateIndex
CREATE INDEX "RAJob_market_atsPostingKey_idx" ON "RAJob"("market", "atsPostingKey");

-- CreateIndex
CREATE INDEX "RAJob_market_locationCountry_locationDistrict_idx" ON "RAJob"("market", "locationCountry", "locationDistrict");

-- CreateIndex
CREATE INDEX "RAJob_skillIds_idx" ON "RAJob" USING GIN ("skillIds");

-- CreateIndex
CREATE INDEX "RAJob_searchTsv_idx" ON "RAJob" USING GIN ("searchTsv");

-- AddForeignKey
ALTER TABLE "RAJobEmbedding" ADD CONSTRAINT "RAJobEmbedding_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RAJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAUserEmbedding" ADD CONSTRAINT "RAUserEmbedding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

