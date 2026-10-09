-- push1-additive.sql — FND-1b, Jobright clone, db push #1 (TASK_PLAN.md §4.0 G1, diff (a))
--
-- Generated 2026-10-10 (Prisma 7.10.0) with:
--   npx prisma migrate diff \
--     --from-schema /Users/kenny/code/RoboApply/server/prisma/schema.prisma \
--     --to-schema server/prisma/schema --script
-- From: main checkout at 8278e5f (server/prisma/schema.prisma byte-identical to 11e102f).
-- To:   feat/jobright-clone worktree, server/prisma/schema/ after FND-1a + FND-1b.
--
-- REVIEW ONLY. Do not run this file. The owner applies the schema with
-- `prisma db push` after running server/prisma/sql/000_extensions.sql (pg_trgm).
--
-- Statement summary (all additive):
--   ALTER TYPE  ... ADD VALUE          1   SeekerSubscriptionTier + 'pro'
--   ALTER TABLE ... ADD COLUMN         9   tables: User, AlipayOrder, SeekerProfile,
--                                          SeekerSubscription, SeekerNotification, RAJob,
--                                          RATrackerEntry, RAResumeVariant, RAJobMatchScore
--                                          (every new column is nullable or has a DEFAULT)
--   CREATE TABLE                      68   all new RA* tables
--   CREATE INDEX / UNIQUE INDEX  115 / 24  18 of them on existing tables, each covering
--                                          at least one new column; incl. RAJob_searchText_idx
--                                          USING GIN ("searchText" gin_trgm_ops), which
--                                          needs pg_trgm
--   ALTER TABLE ... ADD CONSTRAINT FK 71   69 on new tables; 2 on new nullable columns
--                                          of the existing RAJob (ownerUserId → User
--                                          CASCADE, companyId → RACompany SET NULL)
--   DROP ...                           0
--   ALTER COLUMN (TYPE / SET NOT NULL / DROP DEFAULT)  0
--
-- Existing-table notes:
--   * User_brand_phoneE164_key is a UNIQUE index on (brand, phoneE164); phoneE164 is
--     new and NULL on every existing row, and Postgres treats NULLs as distinct, so it
--     cannot fail on existing data.
--   * SeekerProfile.onboardingStep defaults to 'done' (R-06): existing users are not
--     sent back through onboarding; no backfill is needed.
--   * User.brand defaults to 'roboapply'; every existing account becomes RoboApply.
--   * ALTER TYPE ... ADD VALUE cannot be used in the same transaction on old Postgres;
--     db push handles it (Neon runs PG 16/17).
--
-- AlterEnum
ALTER TYPE "SeekerSubscriptionTier" ADD VALUE 'pro';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "brand" TEXT NOT NULL DEFAULT 'roboapply',
ADD COLUMN     "emailIsPlaceholder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastActiveAt" TIMESTAMP(3),
ADD COLUMN     "phoneE164" TEXT,
ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AlipayOrder" ADD COLUMN     "amountMinor" INTEGER,
ADD COLUMN     "brand" TEXT,
ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'alipay',
ADD COLUMN     "planKey" TEXT,
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'subscription',
ADD COLUMN     "relatedId" TEXT,
ADD COLUMN     "tradeType" TEXT,
ADD COLUMN     "wxCodeUrl" TEXT,
ADD COLUMN     "wxPrepayId" TEXT,
ADD COLUMN     "wxTransactionId" TEXT;

-- AlterTable
ALTER TABLE "SeekerProfile" ADD COLUMN     "acquisitionNote" TEXT,
ADD COLUMN     "acquisitionSource" TEXT,
ADD COLUMN     "onboardingAnswers" JSONB,
ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingEntry" JSONB,
ADD COLUMN     "onboardingPath" TEXT,
ADD COLUMN     "onboardingStartedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingStep" TEXT NOT NULL DEFAULT 'done',
ADD COLUMN     "onboardingVersion" TEXT,
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "SeekerSubscription" ADD COLUMN     "billingCountry" TEXT,
ADD COLUMN     "brand" TEXT,
ADD COLUMN     "interval" TEXT,
ADD COLUMN     "planKey" TEXT,
ADD COLUMN     "rail" TEXT;

-- AlterTable
ALTER TABLE "SeekerNotification" ADD COLUMN     "brand" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "params" JSONB,
ADD COLUMN     "pushSentAt" TIMESTAMP(3),
ADD COLUMN     "templateKey" TEXT,
ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "RAJob" ADD COLUMN     "applicantCount" INTEGER,
ADD COLUMN     "applicantCountAt" TIMESTAMP(3),
ADD COLUMN     "applicantCountSource" TEXT,
ADD COLUMN     "atsType" TEXT,
ADD COLUMN     "canonicalJobId" TEXT,
ADD COLUMN     "citizenshipRequired" BOOLEAN,
ADD COLUMN     "clearanceRequired" BOOLEAN,
ADD COLUMN     "closeReason" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "companyId" TEXT,
ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "educationLevel" TEXT,
ADD COLUMN     "employerTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "employerVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enrichModel" TEXT,
ADD COLUMN     "enrichVersion" INTEGER,
ADD COLUMN     "enrichedAt" TIMESTAMP(3),
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "fraudFlags" JSONB,
ADD COLUMN     "fromRecruiterBank" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "geoLat" DOUBLE PRECISION,
ADD COLUMN     "geoLng" DOUBLE PRECISION,
ADD COLUMN     "isAgency" BOOLEAN,
ADD COLUMN     "isCanonical" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "locationRegion" TEXT,
ADD COLUMN     "locations" JSONB,
ADD COLUMN     "market" TEXT NOT NULL DEFAULT 'intl',
ADD COLUMN     "marketTags" JSONB,
ADD COLUMN     "maxYears" INTEGER,
ADD COLUMN     "minYears" INTEGER,
ADD COLUMN     "originalSourceName" TEXT,
ADD COLUMN     "ownerUserId" TEXT,
ADD COLUMN     "postedAtEstimated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "primaryTaxonomyId" TEXT,
ADD COLUMN     "publicDisplay" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "remoteScope" TEXT,
ADD COLUMN     "roleType" TEXT,
ADD COLUMN     "salaryAnnualMax" INTEGER,
ADD COLUMN     "salaryAnnualMin" INTEGER,
ADD COLUMN     "salaryDisclosed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "salaryMonths" INTEGER,
ADD COLUMN     "salarySource" TEXT,
ADD COLUMN     "salaryText" TEXT,
ADD COLUMN     "searchText" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "seniority" TEXT,
ADD COLUMN     "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "skillsDetail" JSONB,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "sourceName" TEXT,
ADD COLUMN     "sourcePriority" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "sourceUrl" TEXT,
ADD COLUMN     "sponsorship" TEXT,
ADD COLUMN     "sponsorshipEvidence" TEXT,
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "taxonomyIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'public',
ADD COLUMN     "workModel" TEXT;

-- AlterTable
ALTER TABLE "RATrackerEntry" ADD COLUMN     "coverLetterId" TEXT,
ADD COLUMN     "interviewAt" TIMESTAMP(3),
ADD COLUMN     "offer" JSONB,
ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "stageDetail" TEXT,
ADD COLUMN     "tailoredVariantId" TEXT;

-- AlterTable
ALTER TABLE "RAResumeVariant" ADD COLUMN     "analysisStatus" TEXT,
ADD COLUMN     "layout" JSONB,
ADD COLUMN     "targetTitle" TEXT,
ADD COLUMN     "unverifiedClaims" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RAJobMatchScore" ADD COLUMN     "dimensions" JSONB,
ADD COLUMN     "locale" TEXT,
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "scoreKind" TEXT NOT NULL DEFAULT 'ai',
ADD COLUMN     "searchProfileVersion" INTEGER,
ADD COLUMN     "tier" TEXT;

-- CreateTable
CREATE TABLE "RAAgentSettings" (
    "userId" TEXT NOT NULL,
    "weeklyTarget" INTEGER NOT NULL DEFAULT 10,
    "minTier" TEXT NOT NULL DEFAULT 'good',
    "tailorEach" BOOLEAN NOT NULL DEFAULT true,
    "coverLetterMode" TEXT NOT NULL DEFAULT 'when_required',
    "baseVariantId" TEXT,
    "fileNameStyle" TEXT NOT NULL DEFAULT 'name_company_role',
    "setupStep" TEXT NOT NULL DEFAULT 'profile',
    "calibration" JSONB NOT NULL DEFAULT '[]',
    "setupCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAAgentSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RAAgentQueueItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "trackerEntryId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'picked',
    "weekKey" TEXT NOT NULL,
    "resumeVariantId" TEXT,
    "coverLetterId" TEXT,
    "tailorSessionId" TEXT,
    "missingFields" JSONB,
    "addedVia" TEXT NOT NULL,
    "lastError" TEXT,
    "openedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "userMarkedSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAAgentQueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAAgentKitEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "queueItemId" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAAgentKitEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAAnswerBankItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionKey" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAAnswerBankItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAPhoneOtp" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ipHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAPhoneOtp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACampusEvent" (
    "id" TEXT NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'cn',
    "companyName" TEXT NOT NULL,
    "companyId" TEXT,
    "title" TEXT NOT NULL,
    "graduationClass" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'application',
    "applyOpensAt" TIMESTAMP(3),
    "applyClosesAt" TIMESTAMP(3),
    "stages" JSONB NOT NULL DEFAULT '[]',
    "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "officialUrl" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceName" TEXT,
    "sourceNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "verifiedAt" TIMESTAMP(3),
    "verifiedByUserId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RACampusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACampusSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'event',
    "eventId" TEXT,
    "companyNameNormalized" TEXT,
    "graduationClass" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'in_app',
    "remindAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RACampusSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAAiContentLabelLog" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "userId" TEXT,
    "artifactType" TEXT NOT NULL,
    "artifactId" TEXT,
    "labelMode" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAAiContentLabelLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAContentSafetyEvent" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "userId" TEXT,
    "surface" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "matched" JSONB,
    "provider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAContentSafetyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAPersonalInfoRequest" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "RAPersonalInfoRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACopilotThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "title" TEXT,
    "contextJobId" TEXT,
    "summary" TEXT,
    "summarizedThroughId" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RACopilotThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACopilotMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "cards" JSONB NOT NULL DEFAULT '[]',
    "toolCalls" JSONB,
    "model" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "feedback" TEXT,
    "feedbackNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RACopilotMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACopilotProposal" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RACopilotProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACopilotMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fact" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RACopilotMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACoverLetter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT,
    "trackerEntryId" TEXT,
    "resumeVariantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "tone" TEXT NOT NULL DEFAULT 'professional',
    "length" TEXT NOT NULL DEFAULT 'medium',
    "locale" TEXT NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "versions" JSONB NOT NULL DEFAULT '[]',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "creditLedgerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RACoverLetter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACreditWindow" (
    "userId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RACreditWindow_pkey" PRIMARY KEY ("userId","bucket","windowKey")
);

-- CreateTable
CREATE TABLE "RACreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "fromSource" TEXT NOT NULL,
    "windowKey" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "sku" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "RACreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACreditGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RACreditGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAEntitlementOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "adminId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAEntitlementOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAExtensionDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "browser" TEXT,
    "extVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAExtensionDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAAutofillRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "jobId" TEXT,
    "trackerEntryId" TEXT,
    "host" TEXT NOT NULL,
    "atsType" TEXT NOT NULL,
    "fieldsTotal" INTEGER NOT NULL DEFAULT 0,
    "fieldsFilled" INTEGER NOT NULL DEFAULT 0,
    "aiAnswers" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL DEFAULT 'started',
    "userMarkedSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "creditLedgerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAAutofillRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RASiteRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RASiteRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAJobUserState" (
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "hiddenAt" TIMESTAMP(3),
    "hiddenReason" TEXT,
    "viewedAt" TIMESTAMP(3),
    "applyClickedAt" TIMESTAMP(3),
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "lastImpressionAt" TIMESTAMP(3),

    CONSTRAINT "RAJobUserState_pkey" PRIMARY KEY ("userId","jobId")
);

-- CreateTable
CREATE TABLE "RAJobInteraction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reasonCode" TEXT,
    "detail" JSONB,
    "feedSessionId" TEXT,
    "position" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAJobInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAFeedSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "searchProfileId" TEXT,
    "profileVersion" INTEGER,
    "sort" TEXT NOT NULL,
    "queryHash" TEXT NOT NULL,
    "jobIds" TEXT[],
    "ranks" JSONB NOT NULL,
    "totalEstimate" INTEGER NOT NULL,
    "windowEndsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAFeedSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAFeedRating" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "feedSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAFeedRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAUserAffinity" (
    "userId" TEXT NOT NULL,
    "taxonomyWeights" JSONB NOT NULL DEFAULT '{}',
    "companyWeights" JSONB NOT NULL DEFAULT '{}',
    "skillWeights" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAUserAffinity_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RAReferralCode" (
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAReferralCode_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RAReferral" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "inviterUserId" TEXT NOT NULL,
    "inviteeUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "qualifiedAt" TIMESTAMP(3),
    "rewardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAAttribution" (
    "userId" TEXT NOT NULL,
    "anonId" TEXT,
    "firstTouch" JSONB NOT NULL,
    "lastTouch" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAAttribution_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RACompany" (
    "id" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT,
    "logoUrl" TEXT,
    "website" TEXT,
    "linkedinUrl" TEXT,
    "industries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sizeBand" TEXT,
    "employeeCount" INTEGER,
    "hqLocation" TEXT,
    "foundedYear" INTEGER,
    "description" TEXT,
    "isAgency" BOOLEAN,
    "bankCompanyRef" TEXT,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RACompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAIngestQuery" (
    "id" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "paramsHash" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "origin" TEXT NOT NULL,
    "demandScore" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),
    "lastNewCount" INTEGER,
    "lastSeenCount" INTEGER,
    "consecutiveEmpty" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAIngestQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAProviderUsage" (
    "provider" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "jobsReturned" INTEGER NOT NULL DEFAULT 0,
    "jobsNew" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RAProviderUsage_pkey" PRIMARY KEY ("provider","dayKey")
);

-- CreateTable
CREATE TABLE "RAH1bEmployerStat" (
    "id" TEXT NOT NULL,
    "employerNameNormalized" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "certifiedCount" INTEGER NOT NULL,
    "withdrawnCount" INTEGER NOT NULL DEFAULT 0,
    "medianWageAnnualUsd" INTEGER,
    "topTitles" JSONB NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAH1bEmployerStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACareerSiteSource" (
    "id" TEXT NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'intl',
    "ats" TEXT NOT NULL,
    "boardToken" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "companyId" TEXT,
    "countryCode" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "lastJobCount" INTEGER,
    "lastError" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RACareerSiteSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAFitReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "model" TEXT,
    "creditLedgerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAFitReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAContact" (
    "id" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "consentBasis" TEXT,
    "companyNameNormalized" TEXT NOT NULL,
    "companyId" TEXT,
    "fullName" TEXT NOT NULL,
    "firstName" TEXT,
    "title" TEXT,
    "linkedinUrl" TEXT,
    "connectedOn" TIMESTAMP(3),
    "pastCompaniesNormalized" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "schoolsNormalized" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAContactImport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "importedCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAContactImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAOutreachDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contactId" TEXT,
    "jobId" TEXT,
    "trackerEntryId" TEXT,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "model" TEXT,
    "copiedAt" TIMESTAMP(3),
    "markedSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAOutreachDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAAlertDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "searchProfileId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "jobIds" TEXT[],
    "emailLogId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAAlertDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAPushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "lastOkAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAPushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAAnnouncement" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "locales" TEXT[],
    "content" JSONB NOT NULL,
    "cohort" JSONB NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAAnnouncement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAUserUiState" (
    "userId" TEXT NOT NULL,
    "state" JSONB NOT NULL DEFAULT '{}',
    "lastFeedVisitAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAUserUiState_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RAEmailLog" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "userId" TEXT,
    "template" TEXT NOT NULL,
    "toHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerId" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAEmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAAnonAlertSubscription" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "cadence" TEXT NOT NULL DEFAULT 'daily',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confirmedAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAAnonAlertSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAWorkItem" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "brand" TEXT,
    "userId" TEXT,
    "payload" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "leasedUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAWorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RARateCounter" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RARateCounter_pkey" PRIMARY KEY ("key","windowStart")
);

-- CreateTable
CREATE TABLE "RAAuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "brand" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "payload" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAAuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAAuthIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "appId" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL,
    "unionId" TEXT,
    "email" TEXT,
    "profile" JSONB,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAAuthIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAProductEvent" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "userId" TEXT,
    "anonId" TEXT,
    "name" TEXT NOT NULL,
    "props" JSONB,
    "path" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAProductEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RASurveyResponse" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "anonId" TEXT,
    "answers" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RASurveyResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RABrandInvite" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RABrandInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAInterviewQuestion" (
    "id" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "companyId" TEXT,
    "companyNameNormalized" TEXT,
    "taxonomyId" TEXT,
    "category" TEXT NOT NULL,
    "difficulty" TEXT,
    "seniority" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "reportedPeriod" TEXT,
    "contributionId" TEXT,
    "guide" JSONB,
    "guideModel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'published',
    "reportsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RAInterviewQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAQuestionContribution" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "interviewYm" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "moderatorId" TEXT,
    "moderatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAQuestionContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAQuestionReport" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAQuestionReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACoach" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "brand" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "bio" TEXT NOT NULL,
    "photoUrl" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "specialties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sessionLengths" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "rates" JSONB NOT NULL DEFAULT '{}',
    "bookingUrl" TEXT,
    "requestEmail" TEXT,
    "introVideoUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RACoach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACoachSlot" (
    "id" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "heldUntil" TIMESTAMP(3),

    CONSTRAINT "RACoachSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RACoachBooking" (
    "id" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "topic" TEXT NOT NULL,
    "resumeVariantId" TEXT,
    "contact" JSONB NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "paymentRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_payment',
    "meetingUrl" TEXT,
    "cancelledBy" TEXT,
    "refundPct" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RACoachBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAProfile" (
    "userId" TEXT NOT NULL,
    "firstName" TEXT,
    "middleName" TEXT,
    "lastName" TEXT,
    "headline" TEXT,
    "contactEmail" TEXT,
    "phoneE164" TEXT,
    "phoneType" TEXT,
    "addressLine1" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "links" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT,
    "skills" JSONB NOT NULL DEFAULT '[]',
    "languages" JSONB NOT NULL DEFAULT '[]',
    "workAuth" JSONB NOT NULL DEFAULT '[]',
    "seekerType" TEXT,
    "careerGoal" TEXT,
    "cnFields" JSONB,
    "completeness" INTEGER NOT NULL DEFAULT 0,
    "syncedFromVariantId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RAProfileEducation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "school" TEXT NOT NULL,
    "degree" TEXT,
    "major" TEXT,
    "gpa" TEXT,
    "startYm" TEXT,
    "endYm" TEXT,
    "current" BOOLEAN NOT NULL DEFAULT false,
    "location" TEXT,
    "coursework" TEXT,
    "achievements" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RAProfileEducation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAProfileExperience" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "employmentType" TEXT,
    "location" TEXT,
    "startYm" TEXT,
    "endYm" TEXT,
    "current" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT,
    "bullets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kind" TEXT NOT NULL DEFAULT 'work',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RAProfileExperience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RASensitiveAnswers" (
    "userId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RASensitiveAnswers_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RAResumeGrade" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "targetTitle" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "grade" TEXT,
    "score" INTEGER,
    "counts" JSONB,
    "issues" JSONB,
    "model" TEXT,
    "creditLedgerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RAResumeGrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RATailorSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "baseVariantId" TEXT NOT NULL,
    "resultVariantId" TEXT,
    "jobId" TEXT,
    "jdSnapshot" JSONB,
    "mode" TEXT NOT NULL DEFAULT 'guided',
    "sections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customPrompt" TEXT,
    "keywordsSelected" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scoreBefore" INTEGER,
    "scoreAfter" INTEGER,
    "claims" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "creditLedgerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RATailorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RASearchProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "filters" JSONB NOT NULL,
    "alertInstantMax" INTEGER NOT NULL DEFAULT 0,
    "alertDigest" TEXT,
    "alertLastInstantAt" TIMESTAMP(3),
    "alertLastDigestAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RASearchProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RASeoPage" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "h1" TEXT NOT NULL,
    "intro" TEXT NOT NULL,
    "stats" JSONB NOT NULL,
    "jobCount" INTEGER NOT NULL,
    "indexable" BOOLEAN NOT NULL DEFAULT false,
    "lastBuiltAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RASeoPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RATrackerEvent" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RATrackerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAApplicationArtifact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackerEntryId" TEXT,
    "autofillRunId" TEXT,
    "kind" TEXT NOT NULL,
    "variantId" TEXT,
    "coverLetterId" TEXT,
    "fileName" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "storageKey" TEXT,
    "channel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RAApplicationArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RAAgentQueueItem_userId_state_updatedAt_idx" ON "RAAgentQueueItem"("userId", "state", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "RAAgentQueueItem_userId_weekKey_idx" ON "RAAgentQueueItem"("userId", "weekKey");

-- CreateIndex
CREATE UNIQUE INDEX "RAAgentQueueItem_userId_jobId_key" ON "RAAgentQueueItem"("userId", "jobId");

-- CreateIndex
CREATE INDEX "RAAgentKitEvent_queueItemId_createdAt_idx" ON "RAAgentKitEvent"("queueItemId", "createdAt");

-- CreateIndex
CREATE INDEX "RAAgentKitEvent_userId_createdAt_idx" ON "RAAgentKitEvent"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RAAnswerBankItem_userId_questionKey_key" ON "RAAnswerBankItem"("userId", "questionKey");

-- CreateIndex
CREATE INDEX "RAPhoneOtp_phoneE164_createdAt_idx" ON "RAPhoneOtp"("phoneE164", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RAPhoneOtp_expiresAt_idx" ON "RAPhoneOtp"("expiresAt");

-- CreateIndex
CREATE INDEX "RACampusEvent_market_status_graduationClass_applyClosesAt_idx" ON "RACampusEvent"("market", "status", "graduationClass", "applyClosesAt");

-- CreateIndex
CREATE INDEX "RACampusEvent_companyName_idx" ON "RACampusEvent"("companyName");

-- CreateIndex
CREATE INDEX "RACampusSubscription_eventId_idx" ON "RACampusSubscription"("eventId");

-- CreateIndex
CREATE INDEX "RACampusSubscription_companyNameNormalized_graduationClass_idx" ON "RACampusSubscription"("companyNameNormalized", "graduationClass");

-- CreateIndex
CREATE UNIQUE INDEX "RACampusSubscription_userId_eventId_key" ON "RACampusSubscription"("userId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "RACampusSubscription_userId_kind_companyNameNormalized_key" ON "RACampusSubscription"("userId", "kind", "companyNameNormalized");

-- CreateIndex
CREATE INDEX "RAAiContentLabelLog_createdAt_idx" ON "RAAiContentLabelLog"("createdAt");

-- CreateIndex
CREATE INDEX "RAAiContentLabelLog_userId_createdAt_idx" ON "RAAiContentLabelLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RAContentSafetyEvent_createdAt_idx" ON "RAContentSafetyEvent"("createdAt");

-- CreateIndex
CREATE INDEX "RAContentSafetyEvent_brand_verdict_createdAt_idx" ON "RAContentSafetyEvent"("brand", "verdict", "createdAt");

-- CreateIndex
CREATE INDEX "RAPersonalInfoRequest_status_dueAt_idx" ON "RAPersonalInfoRequest"("status", "dueAt");

-- CreateIndex
CREATE INDEX "RAPersonalInfoRequest_userId_idx" ON "RAPersonalInfoRequest"("userId");

-- CreateIndex
CREATE INDEX "RACopilotThread_userId_lastMessageAt_idx" ON "RACopilotThread"("userId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "RACopilotMessage_threadId_createdAt_idx" ON "RACopilotMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "RACopilotProposal_userId_status_idx" ON "RACopilotProposal"("userId", "status");

-- CreateIndex
CREATE INDEX "RACopilotProposal_threadId_idx" ON "RACopilotProposal"("threadId");

-- CreateIndex
CREATE INDEX "RACopilotMemory_userId_deletedAt_idx" ON "RACopilotMemory"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "RACoverLetter_userId_updatedAt_idx" ON "RACoverLetter"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "RACoverLetter_userId_jobId_idx" ON "RACoverLetter"("userId", "jobId");

-- CreateIndex
CREATE INDEX "RACoverLetter_resumeVariantId_idx" ON "RACoverLetter"("resumeVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "RACreditLedger_idempotencyKey_key" ON "RACreditLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RACreditLedger_userId_bucket_createdAt_idx" ON "RACreditLedger"("userId", "bucket", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RACreditLedger_status_createdAt_idx" ON "RACreditLedger"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RACreditGrant_userId_bucket_expiresAt_idx" ON "RACreditGrant"("userId", "bucket", "expiresAt");

-- CreateIndex
CREATE INDEX "RAEntitlementOverride_userId_key_idx" ON "RAEntitlementOverride"("userId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "RAExtensionDevice_tokenHash_key" ON "RAExtensionDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "RAExtensionDevice_userId_revokedAt_idx" ON "RAExtensionDevice"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "RAAutofillRun_userId_createdAt_idx" ON "RAAutofillRun"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RAAutofillRun_deviceId_idx" ON "RAAutofillRun"("deviceId");

-- CreateIndex
CREATE INDEX "RASiteRequest_host_idx" ON "RASiteRequest"("host");

-- CreateIndex
CREATE INDEX "RASiteRequest_userId_idx" ON "RASiteRequest"("userId");

-- CreateIndex
CREATE INDEX "RAJobUserState_userId_hiddenAt_idx" ON "RAJobUserState"("userId", "hiddenAt");

-- CreateIndex
CREATE INDEX "RAJobUserState_jobId_idx" ON "RAJobUserState"("jobId");

-- CreateIndex
CREATE INDEX "RAJobInteraction_userId_createdAt_idx" ON "RAJobInteraction"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RAJobInteraction_jobId_kind_idx" ON "RAJobInteraction"("jobId", "kind");

-- CreateIndex
CREATE INDEX "RAFeedSession_userId_createdAt_idx" ON "RAFeedSession"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RAFeedSession_expiresAt_idx" ON "RAFeedSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RAFeedRating_userId_dayKey_key" ON "RAFeedRating"("userId", "dayKey");

-- CreateIndex
CREATE UNIQUE INDEX "RAReferralCode_code_key" ON "RAReferralCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "RAReferral_inviteeUserId_key" ON "RAReferral"("inviteeUserId");

-- CreateIndex
CREATE INDEX "RAReferral_inviterUserId_status_idx" ON "RAReferral"("inviterUserId", "status");

-- CreateIndex
CREATE INDEX "RACompany_domain_idx" ON "RACompany"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "RACompany_market_nameNormalized_key" ON "RACompany"("market", "nameNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "RACompany_market_slug_key" ON "RACompany"("market", "slug");

-- CreateIndex
CREATE INDEX "RAIngestQuery_enabled_nextRunAt_priority_idx" ON "RAIngestQuery"("enabled", "nextRunAt", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "RAIngestQuery_provider_paramsHash_key" ON "RAIngestQuery"("provider", "paramsHash");

-- CreateIndex
CREATE UNIQUE INDEX "RAH1bEmployerStat_employerNameNormalized_fiscalYear_key" ON "RAH1bEmployerStat"("employerNameNormalized", "fiscalYear");

-- CreateIndex
CREATE INDEX "RACareerSiteSource_market_enabled_lastSyncedAt_idx" ON "RACareerSiteSource"("market", "enabled", "lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RACareerSiteSource_ats_boardToken_key" ON "RACareerSiteSource"("ats", "boardToken");

-- CreateIndex
CREATE INDEX "RAFitReport_userId_kind_createdAt_idx" ON "RAFitReport"("userId", "kind", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RAContact_ownerUserId_companyNameNormalized_idx" ON "RAContact"("ownerUserId", "companyNameNormalized");

-- CreateIndex
CREATE INDEX "RAContact_market_companyNameNormalized_source_idx" ON "RAContact"("market", "companyNameNormalized", "source");

-- CreateIndex
CREATE INDEX "RAContactImport_userId_createdAt_idx" ON "RAContactImport"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RAOutreachDraft_userId_createdAt_idx" ON "RAOutreachDraft"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RAOutreachDraft_contactId_idx" ON "RAOutreachDraft"("contactId");

-- CreateIndex
CREATE INDEX "RAAlertDelivery_userId_sentAt_idx" ON "RAAlertDelivery"("userId", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "RAAlertDelivery_searchProfileId_sentAt_idx" ON "RAAlertDelivery"("searchProfileId", "sentAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RAPushSubscription_endpoint_key" ON "RAPushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "RAPushSubscription_userId_idx" ON "RAPushSubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RAAnnouncement_key_key" ON "RAAnnouncement"("key");

-- CreateIndex
CREATE INDEX "RAAnnouncement_brand_startsAt_endsAt_idx" ON "RAAnnouncement"("brand", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "RAEmailLog_template_createdAt_idx" ON "RAEmailLog"("template", "createdAt");

-- CreateIndex
CREATE INDEX "RAEmailLog_userId_createdAt_idx" ON "RAEmailLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RAEmailLog_toHash_idx" ON "RAEmailLog"("toHash");

-- CreateIndex
CREATE INDEX "RAAnonAlertSubscription_brand_status_lastSentAt_idx" ON "RAAnonAlertSubscription"("brand", "status", "lastSentAt");

-- CreateIndex
CREATE INDEX "RAAnonAlertSubscription_emailHash_idx" ON "RAAnonAlertSubscription"("emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "RAWorkItem_dedupeKey_key" ON "RAWorkItem"("dedupeKey");

-- CreateIndex
CREATE INDEX "RAWorkItem_kind_status_runAfter_priority_idx" ON "RAWorkItem"("kind", "status", "runAfter", "priority");

-- CreateIndex
CREATE INDEX "RAWorkItem_status_leasedUntil_idx" ON "RAWorkItem"("status", "leasedUntil");

-- CreateIndex
CREATE INDEX "RAWorkItem_userId_idx" ON "RAWorkItem"("userId");

-- CreateIndex
CREATE INDEX "RARateCounter_expiresAt_idx" ON "RARateCounter"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RAAuthToken_tokenHash_key" ON "RAAuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RAAuthToken_userId_kind_idx" ON "RAAuthToken"("userId", "kind");

-- CreateIndex
CREATE INDEX "RAAuthToken_expiresAt_idx" ON "RAAuthToken"("expiresAt");

-- CreateIndex
CREATE INDEX "RAAuthIdentity_unionId_idx" ON "RAAuthIdentity"("unionId");

-- CreateIndex
CREATE INDEX "RAAuthIdentity_userId_idx" ON "RAAuthIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RAAuthIdentity_brand_provider_appId_subject_key" ON "RAAuthIdentity"("brand", "provider", "appId", "subject");

-- CreateIndex
CREATE INDEX "RAProductEvent_name_createdAt_idx" ON "RAProductEvent"("name", "createdAt");

-- CreateIndex
CREATE INDEX "RAProductEvent_userId_createdAt_idx" ON "RAProductEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RAProductEvent_brand_createdAt_idx" ON "RAProductEvent"("brand", "createdAt");

-- CreateIndex
CREATE INDEX "RAProductEvent_anonId_idx" ON "RAProductEvent"("anonId");

-- CreateIndex
CREATE INDEX "RASurveyResponse_kind_createdAt_idx" ON "RASurveyResponse"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "RASurveyResponse_userId_idx" ON "RASurveyResponse"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RABrandInvite_codeHash_key" ON "RABrandInvite"("codeHash");

-- CreateIndex
CREATE INDEX "RABrandInvite_brand_createdAt_idx" ON "RABrandInvite"("brand", "createdAt");

-- CreateIndex
CREATE INDEX "RAInterviewQuestion_market_companyNameNormalized_category_s_idx" ON "RAInterviewQuestion"("market", "companyNameNormalized", "category", "status");

-- CreateIndex
CREATE INDEX "RAInterviewQuestion_market_taxonomyId_category_idx" ON "RAInterviewQuestion"("market", "taxonomyId", "category");

-- CreateIndex
CREATE INDEX "RAQuestionContribution_status_createdAt_idx" ON "RAQuestionContribution"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RAQuestionContribution_userId_idx" ON "RAQuestionContribution"("userId");

-- CreateIndex
CREATE INDEX "RAQuestionReport_questionId_idx" ON "RAQuestionReport"("questionId");

-- CreateIndex
CREATE INDEX "RAQuestionReport_userId_idx" ON "RAQuestionReport"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RACoach_userId_key" ON "RACoach"("userId");

-- CreateIndex
CREATE INDEX "RACoach_brand_active_idx" ON "RACoach"("brand", "active");

-- CreateIndex
CREATE INDEX "RACoachSlot_coachId_startsAt_idx" ON "RACoachSlot"("coachId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "RACoachBooking_slotId_key" ON "RACoachBooking"("slotId");

-- CreateIndex
CREATE INDEX "RACoachBooking_userId_createdAt_idx" ON "RACoachBooking"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RACoachBooking_coachId_idx" ON "RACoachBooking"("coachId");

-- CreateIndex
CREATE INDEX "RAProfileEducation_userId_sortOrder_idx" ON "RAProfileEducation"("userId", "sortOrder");

-- CreateIndex
CREATE INDEX "RAProfileExperience_userId_sortOrder_idx" ON "RAProfileExperience"("userId", "sortOrder");

-- CreateIndex
CREATE INDEX "RAResumeGrade_variantId_createdAt_idx" ON "RAResumeGrade"("variantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RAResumeGrade_userId_createdAt_idx" ON "RAResumeGrade"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RATailorSession_userId_jobId_idx" ON "RATailorSession"("userId", "jobId");

-- CreateIndex
CREATE INDEX "RATailorSession_baseVariantId_idx" ON "RATailorSession"("baseVariantId");

-- CreateIndex
CREATE INDEX "RATailorSession_resultVariantId_idx" ON "RATailorSession"("resultVariantId");

-- CreateIndex
CREATE INDEX "RASearchProfile_userId_isDefault_idx" ON "RASearchProfile"("userId", "isDefault");

-- CreateIndex
CREATE INDEX "RASearchProfile_alertInstantMax_alertLastInstantAt_idx" ON "RASearchProfile"("alertInstantMax", "alertLastInstantAt");

-- CreateIndex
CREATE INDEX "RASearchProfile_alertDigest_alertLastDigestAt_idx" ON "RASearchProfile"("alertDigest", "alertLastDigestAt");

-- CreateIndex
CREATE INDEX "RASeoPage_brand_indexable_type_idx" ON "RASeoPage"("brand", "indexable", "type");

-- CreateIndex
CREATE UNIQUE INDEX "RASeoPage_brand_locale_type_slug_key" ON "RASeoPage"("brand", "locale", "type", "slug");

-- CreateIndex
CREATE INDEX "RATrackerEvent_entryId_createdAt_idx" ON "RATrackerEvent"("entryId", "createdAt");

-- CreateIndex
CREATE INDEX "RATrackerEvent_userId_createdAt_idx" ON "RATrackerEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RAApplicationArtifact_userId_createdAt_idx" ON "RAApplicationArtifact"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RAApplicationArtifact_trackerEntryId_idx" ON "RAApplicationArtifact"("trackerEntryId");

-- CreateIndex
CREATE INDEX "User_brand_createdAt_idx" ON "User"("brand", "createdAt");

-- CreateIndex
CREATE INDEX "User_lastActiveAt_idx" ON "User"("lastActiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_brand_phoneE164_key" ON "User"("brand", "phoneE164");

-- CreateIndex
CREATE INDEX "AlipayOrder_channel_status_idx" ON "AlipayOrder"("channel", "status");

-- CreateIndex
CREATE INDEX "SeekerNotification_userId_readAt_createdAt_idx" ON "SeekerNotification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "RAJob_market_isCanonical_archivedAt_postedAt_idx" ON "RAJob"("market", "isCanonical", "archivedAt", "postedAt" DESC);

-- CreateIndex
CREATE INDEX "RAJob_market_locationCountry_workModel_archivedAt_idx" ON "RAJob"("market", "locationCountry", "workModel", "archivedAt");

-- CreateIndex
CREATE INDEX "RAJob_taxonomyIds_idx" ON "RAJob" USING GIN ("taxonomyIds");

-- CreateIndex
CREATE INDEX "RAJob_skills_idx" ON "RAJob" USING GIN ("skills");

-- CreateIndex
CREATE INDEX "RAJob_searchText_idx" ON "RAJob" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "RAJob_dedupeKey_idx" ON "RAJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "RAJob_companyId_archivedAt_idx" ON "RAJob"("companyId", "archivedAt");

-- CreateIndex
CREATE INDEX "RAJob_expiresAt_idx" ON "RAJob"("expiresAt");

-- CreateIndex
CREATE INDEX "RAJob_enrichedAt_idx" ON "RAJob"("enrichedAt");

-- CreateIndex
CREATE INDEX "RAJob_ownerUserId_idx" ON "RAJob"("ownerUserId");

-- CreateIndex
CREATE INDEX "RAJob_salaryCurrency_salaryAnnualMax_idx" ON "RAJob"("salaryCurrency", "salaryAnnualMax");

-- CreateIndex
CREATE INDEX "RATrackerEntry_userId_interviewAt_idx" ON "RATrackerEntry"("userId", "interviewAt");

-- CreateIndex
CREATE INDEX "RAJobMatchScore_userId_tier_generatedAt_idx" ON "RAJobMatchScore"("userId", "tier", "generatedAt" DESC);

-- AddForeignKey
ALTER TABLE "RAAgentSettings" ADD CONSTRAINT "RAAgentSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAAgentQueueItem" ADD CONSTRAINT "RAAgentQueueItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAAgentKitEvent" ADD CONSTRAINT "RAAgentKitEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAAgentKitEvent" ADD CONSTRAINT "RAAgentKitEvent_queueItemId_fkey" FOREIGN KEY ("queueItemId") REFERENCES "RAAgentQueueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAAnswerBankItem" ADD CONSTRAINT "RAAnswerBankItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACampusSubscription" ADD CONSTRAINT "RACampusSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACampusSubscription" ADD CONSTRAINT "RACampusSubscription_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "RACampusEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAPersonalInfoRequest" ADD CONSTRAINT "RAPersonalInfoRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACopilotThread" ADD CONSTRAINT "RACopilotThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACopilotMessage" ADD CONSTRAINT "RACopilotMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "RACopilotThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACopilotProposal" ADD CONSTRAINT "RACopilotProposal_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "RACopilotThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACopilotProposal" ADD CONSTRAINT "RACopilotProposal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACopilotMemory" ADD CONSTRAINT "RACopilotMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACoverLetter" ADD CONSTRAINT "RACoverLetter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACoverLetter" ADD CONSTRAINT "RACoverLetter_resumeVariantId_fkey" FOREIGN KEY ("resumeVariantId") REFERENCES "RAResumeVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACreditWindow" ADD CONSTRAINT "RACreditWindow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACreditLedger" ADD CONSTRAINT "RACreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACreditGrant" ADD CONSTRAINT "RACreditGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAEntitlementOverride" ADD CONSTRAINT "RAEntitlementOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAExtensionDevice" ADD CONSTRAINT "RAExtensionDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAAutofillRun" ADD CONSTRAINT "RAAutofillRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAAutofillRun" ADD CONSTRAINT "RAAutofillRun_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "RAExtensionDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RASiteRequest" ADD CONSTRAINT "RASiteRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAJobUserState" ADD CONSTRAINT "RAJobUserState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAJobUserState" ADD CONSTRAINT "RAJobUserState_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RAJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAJobInteraction" ADD CONSTRAINT "RAJobInteraction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAFeedSession" ADD CONSTRAINT "RAFeedSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAFeedRating" ADD CONSTRAINT "RAFeedRating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAUserAffinity" ADD CONSTRAINT "RAUserAffinity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAReferralCode" ADD CONSTRAINT "RAReferralCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAReferral" ADD CONSTRAINT "RAReferral_inviterUserId_fkey" FOREIGN KEY ("inviterUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAReferral" ADD CONSTRAINT "RAReferral_inviteeUserId_fkey" FOREIGN KEY ("inviteeUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAAttribution" ADD CONSTRAINT "RAAttribution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAJob" ADD CONSTRAINT "RAJob_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAJob" ADD CONSTRAINT "RAJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "RACompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAFitReport" ADD CONSTRAINT "RAFitReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAContact" ADD CONSTRAINT "RAContact_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAContactImport" ADD CONSTRAINT "RAContactImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAOutreachDraft" ADD CONSTRAINT "RAOutreachDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAOutreachDraft" ADD CONSTRAINT "RAOutreachDraft_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "RAContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAAlertDelivery" ADD CONSTRAINT "RAAlertDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAAlertDelivery" ADD CONSTRAINT "RAAlertDelivery_searchProfileId_fkey" FOREIGN KEY ("searchProfileId") REFERENCES "RASearchProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAPushSubscription" ADD CONSTRAINT "RAPushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAUserUiState" ADD CONSTRAINT "RAUserUiState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAEmailLog" ADD CONSTRAINT "RAEmailLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAAuthToken" ADD CONSTRAINT "RAAuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAAuthIdentity" ADD CONSTRAINT "RAAuthIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAProductEvent" ADD CONSTRAINT "RAProductEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RASurveyResponse" ADD CONSTRAINT "RASurveyResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAQuestionContribution" ADD CONSTRAINT "RAQuestionContribution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAQuestionReport" ADD CONSTRAINT "RAQuestionReport_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "RAInterviewQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAQuestionReport" ADD CONSTRAINT "RAQuestionReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACoach" ADD CONSTRAINT "RACoach_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACoachSlot" ADD CONSTRAINT "RACoachSlot_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "RACoach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACoachBooking" ADD CONSTRAINT "RACoachBooking_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "RACoach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACoachBooking" ADD CONSTRAINT "RACoachBooking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RACoachBooking" ADD CONSTRAINT "RACoachBooking_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "RACoachSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAProfile" ADD CONSTRAINT "RAProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAProfileEducation" ADD CONSTRAINT "RAProfileEducation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAProfileExperience" ADD CONSTRAINT "RAProfileExperience_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RASensitiveAnswers" ADD CONSTRAINT "RASensitiveAnswers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAResumeGrade" ADD CONSTRAINT "RAResumeGrade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAResumeGrade" ADD CONSTRAINT "RAResumeGrade_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "RAResumeVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RATailorSession" ADD CONSTRAINT "RATailorSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RATailorSession" ADD CONSTRAINT "RATailorSession_baseVariantId_fkey" FOREIGN KEY ("baseVariantId") REFERENCES "RAResumeVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RATailorSession" ADD CONSTRAINT "RATailorSession_resultVariantId_fkey" FOREIGN KEY ("resultVariantId") REFERENCES "RAResumeVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RASearchProfile" ADD CONSTRAINT "RASearchProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RATrackerEvent" ADD CONSTRAINT "RATrackerEvent_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "RATrackerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RATrackerEvent" ADD CONSTRAINT "RATrackerEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAApplicationArtifact" ADD CONSTRAINT "RAApplicationArtifact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RAApplicationArtifact" ADD CONSTRAINT "RAApplicationArtifact_trackerEntryId_fkey" FOREIGN KEY ("trackerEntryId") REFERENCES "RATrackerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

