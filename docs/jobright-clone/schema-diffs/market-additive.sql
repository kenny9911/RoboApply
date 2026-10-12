-- docs/jobright-clone/schema-diffs/market-additive.sql
-- Market wave, phase M0 (bundle MKT-0): the additive schema diff for review.
--
-- WHAT THIS IS
--   The output of `prisma migrate diff --from-schema <base> --to-schema server/prisma/schema --script`,
--   datamodel to datamodel, written by `node scripts/check-schema-additive.mjs --out <this file>`.
--   No database was read to produce it. It shows what the schema change adds on top of the
--   base commit named below the marker line; it is NOT a database-to-schema diff. On a real
--   database the diff of server/prisma/sql/README.md step 3 is the one that counts: it can also
--   show the three SR-16b-1 columns that are already declared (RAJob.lastSeenQueryId,
--   RAJob.lastSeenRun, RAIngestQuery.runCount, with the index on lastSeenQueryId) where a
--   database lacks them, and the KNOWN_DRIFT.md pair.
--
-- HOW IT IS APPLIED (server/prisma/sql/README.md; the engineer of MKT-0 ran none of this)
--   1. server/prisma/sql/000_extensions.sql if it never ran on that database (pg_trgm).
--   2. server/prisma/sql/001_vector.sql (CREATE EXTENSION IF NOT EXISTS vector). It must run
--      BEFORE the push: three columns below have the type halfvec(1024).
--   3. Read the database-to-schema diff, then `npm run db:push`, then read the diff again.
--
-- WHAT IT CONTAINS (additive only; scripts/check-schema-additive.mjs exits 0 on it)
--   CREATE TABLE   RABillingRefund, RABillingConsentArchive, RASponsorRegisterEntry,
--                  RAJobEmbedding, RAUserEmbedding, RASkill
--   ADD COLUMN     RAJob (11 columns), RACareerSiteSource (7), RAJobMatchScore (2),
--                  RAUserAffinity (1), RATailorSession (1); each is nullable or has a default
--   CREATE INDEX   20: 15 on the six new tables (three of them unique), 4 on RAJob (two GIN:
--                  skillIds and searchTsv), 1 on RACareerSiteSource
--   ADD CONSTRAINT two foreign keys, both ON DELETE CASCADE: RAJobEmbedding.jobId -> RAJob.id and
--                  RAUserEmbedding.userId -> User.id (deleting an account removes its vectors)
--   Nothing is dropped, renamed, retyped or tightened. AlipayOrder, SeekerSubscription,
--   RACreditLedger and RACreditGrant are not named anywhere below (MARKET_STRATEGY 5.2 rule A8).
--   RAJob.searchTsv is an ordinary nullable column that the application writes in the same
--   statement as searchDoc. It is not a generated column, and its GIN index is declared in the
--   Prisma schema (plain form, default operator class) so that db push keeps it.
--
-- BEYOND MARKET_STRATEGY SECTION 7 ITEM 11 (for the owner: these were not in that list)
--   RAJob.sponsorshipSource            who states RAJob.sponsorship (posting quote or a named
--                                      provider's reading)                          JI-7, JI-11
--   RAJob.locationDistrict             Taiwan district as posted, with the index
--                                      (market, locationCountry, locationDistrict)  JT-7
--   RAJob.workShift                    shift from the source's own field            JT-7
--   RACareerSiteSource.failCount       consecutive hard sync failures (3 disables)  JI-4
--   RACareerSiteSource.lastChangeAt    last sync that added or closed a posting     JI-4
--   RACareerSiteSource.nextSyncAt      when the board is next due, and the sync lease,
--                                      with the index (enabled, nextSyncAt)         JI-4
--   RACareerSiteSource.disabledAt      set when three failures disabled the source  JI-4
--   RAUserAffinity.titleWeights        negative weights from "Not interested: wrong title" SM-12
--   RATailorSession.fitSnapshot        the kit's stored before and after numbers with kind,
--                                      version and date (strategy 2.2 invariant I6) SM-5
--   RASponsorRegisterEntry (table)     USCIS H-1B Employer Data Hub and UK sponsor register
--                                      rows: company facts with source and date     JI-11
--   RABillingRefund (table)            readable record of a refund, withdrawal, dispute or
--                                      manual CN refund; no relation fields         ST-4, ST-9, AL-7
--   RABillingConsentArchive (table)    checkout acknowledgements kept after account deletion
--                                      until retainUntil (California AB 2863)       ST-9
--
-- BEYOND THE PLAN'S SCHEMA LIST (MARKET_TASK_PLAN section 4; added after the MKT-0 review; the
-- orchestrator confirms or removes it before the push)
--   RABillingConsentArchive            unique (userId, consentType, consentedAt): one row per
--                                      acknowledgement, so a purge that runs twice or two sweeps
--                                      that overlap cannot archive it twice (the purge writes with
--                                      createMany skipDuplicates, MKT-4A). The table is new and
--                                      empty, so the key is additive; it could not be added safely
--                                      once the table holds rows.                   ST-9
--   To remove it: delete the @@unique line of RABillingConsentArchive in ra-credits.prisma and its
--   entry in server/prisma/__tests__/marketSchema.test.ts, then regenerate this file (below).
--   In item 11 and present below: RAJob.atsPostingKey (JI-5), titleMatchScore (SM-2), skillIds
--   (SM-6), searchDoc, searchTsv, contentHash, lang (SM-7), requirements (SM-8);
--   RACareerSiteSource.origin, discoveredFrom, countries (JI-3); RAJobMatchScore.jobContentHash,
--   rubricVersion (SM-5, SM-8); RASkill (SM-6); RAJobEmbedding, RAUserEmbedding (SM-7).
--
-- TO REGENERATE OR VERIFY
--   node scripts/check-schema-additive.mjs --check docs/jobright-clone/schema-diffs/market-additive.sql
--   node scripts/check-schema-additive.mjs --base <the base commit below> --out docs/jobright-clone/schema-diffs/market-additive.sql
--
-- >>> generated by scripts/check-schema-additive.mjs: do not edit below this line >>>
-- base: 03b140ff28fbdd25b965269cd023da98850b5353 (server/prisma/schema at that commit) -> the schema folder of this commit

-- AlterTable
ALTER TABLE "RAUserAffinity" ADD COLUMN     "titleWeights" JSONB NOT NULL DEFAULT '{}';

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
ALTER TABLE "RACareerSiteSource" ADD COLUMN     "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "discoveredFrom" TEXT,
ADD COLUMN     "failCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastChangeAt" TIMESTAMP(3),
ADD COLUMN     "nextSyncAt" TIMESTAMP(3),
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'admin';

-- AlterTable
ALTER TABLE "RAJobMatchScore" ADD COLUMN     "jobContentHash" TEXT,
ADD COLUMN     "rubricVersion" TEXT;

-- AlterTable
ALTER TABLE "RATailorSession" ADD COLUMN     "fitSnapshot" JSONB;

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
CREATE INDEX "RAJob_market_atsPostingKey_idx" ON "RAJob"("market", "atsPostingKey");

-- CreateIndex
CREATE INDEX "RAJob_market_locationCountry_locationDistrict_idx" ON "RAJob"("market", "locationCountry", "locationDistrict");

-- CreateIndex
CREATE INDEX "RAJob_skillIds_idx" ON "RAJob" USING GIN ("skillIds");

-- CreateIndex
CREATE INDEX "RAJob_searchTsv_idx" ON "RAJob" USING GIN ("searchTsv");

-- CreateIndex
CREATE INDEX "RACareerSiteSource_enabled_nextSyncAt_idx" ON "RACareerSiteSource"("enabled", "nextSyncAt");

-- AddForeignKey
ALTER TABLE "RAJobEmbedding" ADD CONSTRAINT "RAJobEmbedding_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RAJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAUserEmbedding" ADD CONSTRAINT "RAUserEmbedding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

